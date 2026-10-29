import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { memDb, fixtureServer, rss, hoursAgo, logger, testConfig, type Fixture } from './helpers.js';
import { ingestSource, processNewArticles, type SourceRow } from '../server/news/ingest.js';
import { recomputeCluster } from '../server/news/cluster.js';
import { queryFeed } from '../server/news/query.js';
import { Ai, type AiTransport } from '../server/ai/gemini.js';
import { buildApp } from '../server/app.js';
import { migrate } from '../server/db.js';
import { MIGRATIONS } from '../server/migrations.js';
import type { OidcClient } from '../server/auth.js';
import type { DB } from '../server/db.js';

let fx: Fixture;
beforeAll(async () => { fx = await fixtureServer(); });
afterAll(async () => { await fx.close(); });

const URL1 = 'https://news.example/city/parking-plan';
const TITLE = 'Council approves downtown parking plan';
const EXC = 'The city council voted Tuesday night to approve a new downtown parking plan that adds two garages and extends meter hours.';

function mockAi(db: DB) {
  const st = { attempts: 0, article: 0, articleIds: [] as number[][] };
  const transport: AiTransport = {
    async generateJson({ prompt }) {
      st.attempts++;
      if (prompt.includes('cover the same event')) return { text: JSON.stringify({ summary: 'AI consolidated summary', differences: null }), inputTokens: 1, outputTokens: 1 };
      const ids = [...prompt.matchAll(/<article id="(\d+)"/g)].map((m) => Number(m[1]));
      st.article++; st.articleIds.push(ids);
      return { text: JSON.stringify({ items: ids.map((id) => ({ id, category: 'Local', importance: 0.5, summary: `AI summary for article ${id}.` })) }), inputTokens: 1, outputTokens: 1 };
    },
  };
  return { ai: new Ai(db, 'm', transport, 1000), st };
}
const deps = (db: DB, ai: Ai | null) => ({ db, ai, log: logger, fetchOpts: { allowPrivate: true } });
/** Sequential, in source-id order, so "first discovered" is deterministic. */
async function refresh(db: DB, ai: Ai | null) {
  const d = deps(db, ai); const ids: number[] = [];
  for (const s of db.prepare('SELECT * FROM sources WHERE enabled = 1 ORDER BY id').all() as SourceRow[]) ids.push(...await ingestSource(d, s));
  await processNewArticles(d, ids);
  return ids;
}
const addSource = (db: DB, name: string, path: string) => Number(db.prepare("INSERT INTO sources (name, site_url, feed_url, kind, created_at) VALUES (?,?,?,'rss',?)").run(name, `${fx.url}/site-${name.replace(/\W/g, '')}`, fx.url + path, Date.now()).lastInsertRowid);
const feed = (path: string, items: { title: string; link: string; desc?: string; hrs?: number }[]) => fx.routes.set(path, { body: rss(items.map((i) => ({ title: i.title, link: i.link, date: hoursAgo(i.hrs ?? 2), desc: i.desc }))) });
const count = (db: DB, sql: string) => (db.prepare(sql).get() as { n: number }).n;
const snap = (db: DB) => JSON.stringify([db.prepare('SELECT * FROM articles').all(), db.prepare('SELECT * FROM story_clusters').all(), db.prepare('SELECT * FROM article_sources ORDER BY article_id, source_id').all()]);

describe('exact duplicates keep every feed relationship', () => {
  it('REGRESSION: two feeds with the same canonical URL -> one article, one story, both feeds recorded', async () => {
    const db = memDb(); const a = addSource(db, 'Feed A', '/d1-a'), b = addSource(db, 'Feed B', '/d1-b');
    feed('/d1-a', [{ title: TITLE, link: URL1, desc: EXC }]);
    feed('/d1-b', [{ title: TITLE, link: `${URL1}/?utm_source=feedb#top`, desc: EXC }]); // same article after canonicalization
    await refresh(db, null);
    expect(count(db, 'SELECT COUNT(*) n FROM articles')).toBe(1); expect(count(db, 'SELECT COUNT(*) n FROM story_clusters')).toBe(1);
    expect(db.prepare('SELECT article_id, source_id FROM article_sources ORDER BY source_id').all()).toEqual([{ article_id: 1, source_id: a }, { article_id: 1, source_id: b }]); // before: only A
    const items = queryFeed(db, { tab: 'latest' }).items;
    expect(items).toHaveLength(1); // still shown once
    expect(items[0].sourceCount).toBe(1); // one publisher, not two feed entries
    expect(items[0].articles).toHaveLength(1);
    expect(items[0].articles[0]).toMatchObject({ publisher: 'Feed A', url: URL1, alsoVia: ['Feed B'] }); // originating publisher + discovery feeds
  });

  it('one publisher distributing an article through several feeds is still one publisher', async () => {
    const db = memDb(); addSource(db, 'BBC News', '/d2-a'); addSource(db, 'BBC Business', '/d2-b'); addSource(db, 'BBC World', '/d2-c');
    for (const p of ['/d2-a', '/d2-b', '/d2-c']) feed(p, [{ title: TITLE, link: URL1, desc: EXC }]);
    await refresh(db, null);
    const [story] = queryFeed(db, { tab: 'latest' }).items;
    expect(queryFeed(db, { tab: 'latest' }).items).toHaveLength(1);
    expect(story.sourceCount).toBe(1); expect(story.articles[0].publisher).toBe('BBC News'); expect(story.articles[0].alsoVia).toEqual(['BBC Business', 'BBC World']);
    expect(count(db, 'SELECT COUNT(*) n FROM article_sources')).toBe(3);
  });

  it('two publishers independently covering one event: grouped, counted as two publishers, each with its own link and feed', async () => {
    const db = memDb(); addSource(db, 'Alpha Times', '/d3-a'); addSource(db, 'Beta Post', '/d3-b');
    feed('/d3-a', [{ title: 'Boeing strike ends after union approves new contract', link: 'https://alpha.example/1', desc: EXC }]);
    feed('/d3-b', [{ title: 'Union approves new contract, ending Boeing strike', link: 'https://beta.example/9', desc: EXC }]);
    await refresh(db, null);
    const [story] = queryFeed(db, { tab: 'latest' }).items;
    expect(count(db, 'SELECT COUNT(*) n FROM story_clusters')).toBe(1);
    expect(story).toMatchObject({ sourceCount: 2 });
    expect(story.articles.map((x) => [x.publisher, x.url, x.alsoVia])).toEqual([['Alpha Times', 'https://alpha.example/1', []], ['Beta Post', 'https://beta.example/9', []]]);
    expect(count(db, 'SELECT COUNT(*) n FROM article_sources')).toBe(2);
  });

  it('coverage counts distinct publishers, ignoring case/spacing, not articles or feed entries', () => {
    const db = memDb();
    const src = Number(db.prepare("INSERT INTO sources (name, site_url, created_at) VALUES ('s','https://s.example',0)").run().lastInsertRowid);
    const cluster = Number(db.prepare('INSERT INTO story_clusters (title,first_published_at,last_published_at,updated_at,created_at) VALUES (?,?,?,?,?)').run('t', 1, 1, 1, 1).lastInsertRowid);
    ['Reuters', ' reuters ', 'REUTERS', 'AP'].forEach((p, i) => db.prepare(`INSERT INTO articles (source_id,url,canonical_url,canonical_hash,publisher,title,title_norm,published_at,fetched_at,content_hash,availability,cluster_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,'headline_only',?)`).run(src, `https://x/${i}`, `https://x/${i}`, `h${i}`, p, `t${i}`, `t${i}`, 1, 1, `c${i}`, cluster));
    recomputeCluster(db, cluster);
    expect(db.prepare('SELECT article_count, source_count FROM story_clusters').get()).toEqual({ article_count: 4, source_count: 2 });
  });

  it('a feed that merely links to another publisher\'s site does not make that feed (or the site) a second publisher', async () => {
    const db = memDb(); addSource(db, 'Roundup Blog', '/d5-roundup'); addSource(db, 'BBC News', '/d5-bbc');
    const bbc = 'https://www.bbc.com/news/world-12345';
    feed('/d5-roundup', [{ title: TITLE, link: bbc, desc: EXC }]); feed('/d5-bbc', [{ title: TITLE, link: bbc, desc: EXC }]);
    await refresh(db, null);
    const [story] = queryFeed(db, { tab: 'latest' }).items;
    expect(story.sourceCount).toBe(1);
    expect(story.articles[0].publisher).toBe('Roundup Blog'); // attributed by the feed that supplied it, never derived from the URL's host
    expect(story.articles[0].publisher).not.toMatch(/bbc/i);
    expect(story.articles[0].alsoVia).toEqual(['BBC News']);
  });

  it('REGRESSION: another feed\'s different text for the same URL never overwrites the article or re-queues it for Gemini', async () => {
    const db = memDb(); const { ai, st } = mockAi(db); addSource(db, 'Feed A', '/d6-a'); addSource(db, 'Feed B', '/d6-b');
    feed('/d6-a', [{ title: 'Council approves downtown parking plan', link: URL1, desc: EXC }]);
    feed('/d6-b', [{ title: 'City hall signs off on parking overhaul', link: URL1, desc: 'Feed B wrote an entirely different excerpt for this very same article, with other words.' }]);
    for (let i = 0; i < 4; i++) await refresh(db, ai);
    expect(db.prepare('SELECT title FROM articles').all()).toEqual([{ title: 'Council approves downtown parking plan' }]); // stable; before: flipped every refresh
    expect(st.articleIds).toEqual([[1]]); // exactly one Gemini article call, for one article, ever

    // the originating feed can still correct its own article (Issue #2 behaviour is intact)
    feed('/d6-a', [{ title: 'Council rejects downtown parking plan', link: URL1, desc: 'Correction: the council rejected the plan on a 4-3 vote after a lengthy public hearing on Tuesday night.' }]);
    await refresh(db, ai);
    expect(db.prepare('SELECT title FROM articles').get()).toEqual({ title: 'Council rejects downtown parking plan' });
    expect(st.articleIds).toEqual([[1], [1]]);
  });

  it('exact duplicates cost no extra Gemini work, and existing bookmarks, feedback, read state and AI summaries survive', async () => {
    const db = memDb(); const { ai, st } = mockAi(db); const a = addSource(db, 'Feed A', '/d7-a');
    feed('/d7-a', [{ title: TITLE, link: URL1, desc: EXC }]);
    await refresh(db, ai);
    expect(st.articleIds).toEqual([[1]]);
    db.prepare('INSERT INTO bookmarks VALUES (1, 55)').run();
    db.prepare("INSERT INTO feedback (cluster_id, rating, reason, category, created_at, updated_at) VALUES (1, 1, NULL, 'Local', 3, 4)").run();
    db.prepare('INSERT INTO feedback_sources VALUES (1, ?)').run(a);
    db.prepare('INSERT INTO reading_state (cluster_id, read_at) VALUES (1, 99)').run();
    const state = () => JSON.stringify(['bookmarks', 'feedback', 'feedback_sources', 'reading_state'].map((t) => db.prepare(`SELECT * FROM ${t}`).all()));
    const before = state(); const summary = db.prepare('SELECT summary, summary_kind FROM story_clusters').get();
    const calls = st.attempts;

    const b = addSource(db, 'Feed B', '/d7-b'); feed('/d7-b', [{ title: TITLE, link: URL1, desc: EXC }]);
    await refresh(db, ai); await refresh(db, ai);

    expect(st.attempts).toBe(calls); // duplicates never reach Gemini
    expect(state()).toBe(before);
    expect(db.prepare('SELECT summary, summary_kind FROM story_clusters').get()).toEqual(summary); expect(summary).toEqual({ summary: 'AI summary for article 1.', summary_kind: 'ai' });
    expect(count(db, 'SELECT COUNT(*) n FROM story_clusters')).toBe(1);
    expect(db.prepare('SELECT source_id FROM article_sources ORDER BY source_id').all()).toEqual([{ source_id: a }, { source_id: b }]);
  });

  it('repeated ingestion adds no duplicate relationships, writes nothing new, and makes no AI calls', async () => {
    const db = memDb(); const { ai, st } = mockAi(db); addSource(db, 'Feed A', '/d8-a'); addSource(db, 'Feed B', '/d8-b');
    feed('/d8-a', [{ title: TITLE, link: URL1, desc: EXC }]); feed('/d8-b', [{ title: TITLE, link: URL1, desc: EXC }]);
    await refresh(db, ai);
    const calls = st.attempts, s = snap(db);
    for (let i = 0; i < 3; i++) expect(await refresh(db, ai)).toEqual([]); // nothing new to process
    expect(count(db, 'SELECT COUNT(*) n FROM article_sources')).toBe(2); expect(st.attempts).toBe(calls); expect(snap(db)).toBe(s);
  });
});

describe('migration 2: article_sources', () => {
  it('backfills from existing articles and keeps all existing data (and is idempotent)', () => {
    const raw = new Database(':memory:'); raw.pragma('foreign_keys = ON');
    raw.exec('CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)');
    raw.exec(MIGRATIONS[0].sql); raw.prepare("INSERT INTO schema_migrations VALUES (1,'init',0)").run();
    const s1 = Number(raw.prepare("INSERT INTO sources (name, site_url, created_at) VALUES ('One','https://one.example',0)").run().lastInsertRowid);
    const s2 = Number(raw.prepare("INSERT INTO sources (name, site_url, created_at) VALUES ('Two','https://two.example',0)").run().lastInsertRowid);
    const cl = Number(raw.prepare('INSERT INTO story_clusters (title,summary,summary_kind,first_published_at,last_published_at,updated_at,created_at,article_count,source_count) VALUES (?,?,?,?,?,?,?,?,?)').run('Story', 'Kept summary', 'ai', 1, 2, 3, 4, 2, 2).lastInsertRowid);
    const mk = (src: number, n: number, fetched: number) => Number(raw.prepare(`INSERT INTO articles (source_id,url,canonical_url,canonical_hash,publisher,title,title_norm,published_at,fetched_at,content_hash,availability,summary,summary_kind,cluster_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,'excerpt','AI text','ai',?)`).run(src, `https://x/${n}`, `https://x/${n}`, `h${n}`, `Pub${n}`, `T${n}`, `t${n}`, 1, fetched, `c${n}`, cl).lastInsertRowid);
    const a1 = mk(s1, 1, 111), a2 = mk(s2, 2, 222);
    raw.prepare('INSERT INTO bookmarks VALUES (?,5)').run(cl);
    raw.prepare("INSERT INTO feedback (cluster_id, rating, reason, category, created_at, updated_at) VALUES (?,1,NULL,'X',1,1)").run(cl);
    raw.prepare('INSERT INTO reading_state (cluster_id, read_at) VALUES (?,9)').run(cl);
    raw.prepare("INSERT INTO ai_cache VALUES ('k','article','m','v1','{}',1)").run();
    raw.prepare("INSERT INTO application_settings VALUES ('theme','\"dark\"')").run();
    const before = ['sources', 'articles', 'story_clusters', 'bookmarks', 'feedback', 'reading_state', 'ai_cache', 'application_settings'].map((t) => JSON.stringify(raw.prepare(`SELECT * FROM ${t}`).all()));

    expect(migrate(raw as DB)).toEqual(MIGRATIONS.slice(1).map((m) => m.id)); // applies everything after init, including 2
    expect(raw.prepare('SELECT article_id, source_id, first_seen_at FROM article_sources ORDER BY article_id').all()).toEqual([{ article_id: a1, source_id: s1, first_seen_at: 111 }, { article_id: a2, source_id: s2, first_seen_at: 222 }]);
    // existing rows are untouched; later migrations only add columns (articles.blocked, which must default to 0)
    expect(['sources', 'articles', 'story_clusters', 'bookmarks', 'feedback', 'reading_state', 'ai_cache', 'application_settings'].map((t) => JSON.stringify((raw.prepare(`SELECT * FROM ${t}`).all() as any[]).map(({ blocked, ...rest }) => { if (t === 'articles') expect(blocked).toBe(0); return t === 'articles' ? rest : { ...rest, ...(blocked === undefined ? {} : { blocked }) }; })))).toEqual(before);
    expect(migrate(raw as DB)).toEqual([]); expect((raw.prepare('SELECT COUNT(*) n FROM article_sources').get() as any).n).toBe(2);
    raw.prepare('DELETE FROM sources WHERE id = ?').run(s2); // cascades remove only that feed's associations
    expect(raw.prepare('SELECT source_id FROM article_sources').all()).toEqual([{ source_id: s1 }]);
  });
});

describe('deleting a feed keeps articles another feed still carries', () => {
  let app: FastifyInstance;
  const oidc: OidcClient & { nonce?: string } = { authUrl: ({ state, nonce }) => `https://x/?state=${state}&nonce=${nonce}`, async exchange() { return { sub: 's', email: 'me@example.com', emailVerified: true, name: 'Me', nonce: oidc.nonce ?? null }; } };
  it('re-homes shared articles (with their story and bookmark) and removes the ones only that feed supplied', async () => {
    const db = memDb(); const a = addSource(db, 'Feed A', '/d9-a'); const b = addSource(db, 'Feed B', '/d9-b');
    feed('/d9-a', [{ title: TITLE, link: URL1, desc: EXC }, { title: 'Zebra population grows in the savanna', link: 'https://news.example/zebra', desc: EXC }]);
    feed('/d9-b', [{ title: TITLE, link: URL1, desc: EXC }]);
    await refresh(db, null);
    expect(count(db, 'SELECT COUNT(*) n FROM article_sources')).toBe(3);
    const sharedCluster = (db.prepare('SELECT cluster_id c FROM articles WHERE url = ?').get(URL1) as any).c;
    db.prepare('INSERT INTO bookmarks VALUES (?,1)').run(sharedCluster);

    ({ app } = await buildApp(testConfig(), db, { oidc, logger: false, transport: null, fetchOpts: { allowPrivate: true } }));
    const r1 = await app.inject({ url: '/auth/login' }); const loc = new URL(r1.headers.location as string); oidc.nonce = loc.searchParams.get('nonce')!;
    const r2 = await app.inject({ url: `/auth/callback?code=c&state=${loc.searchParams.get('state')}`, cookies: { oauth_tx: r1.cookies[0].value } });
    const cookie = r2.cookies.find((c) => c.name === 'sid')!.value;
    const csrf = (await app.inject({ url: '/api/me', cookies: { sid: cookie } })).json().csrfToken;
    expect((await app.inject({ method: 'DELETE', url: `/api/sources/${a}`, cookies: { sid: cookie }, headers: { 'x-csrf-token': csrf } })).statusCode).toBe(200);

    expect(db.prepare('SELECT url, source_id FROM articles').all()).toEqual([{ url: URL1, source_id: b }]); // shared article re-homed to Feed B
    expect(count(db, 'SELECT COUNT(*) n FROM story_clusters')).toBe(1);
    expect(db.prepare('SELECT cluster_id FROM bookmarks').all()).toEqual([{ cluster_id: sharedCluster }]); // bookmark survived
    expect(db.prepare('SELECT article_id, source_id FROM article_sources').all()).toEqual([{ article_id: 1, source_id: b }]);
    await app.close();
  });
});

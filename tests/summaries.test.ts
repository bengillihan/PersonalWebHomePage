import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { memDb, fixtureServer, rss, hoursAgo, logger, type Fixture } from './helpers.js';
import { ingestSource, processNewArticles, type SourceRow } from '../server/news/ingest.js';
import { isUsableSummary, clusterContentHash } from '../server/news/cluster.js';
import { sentencesFallback } from '../server/news/summary.js';
import { queryFeed } from '../server/news/query.js';
import { Ai, type AiTransport } from '../server/ai/gemini.js';
import type { DB } from '../server/db.js';

let fx: Fixture;
beforeAll(async () => { fx = await fixtureServer(); });
afterAll(async () => { await fx.close(); });

const TITLE_A = 'Boeing strike ends after union approves new contract';
const TITLE_B = 'Union approves new contract, ending Boeing strike';
const EXC_A = 'ALPHA-DETAIL: Boeing machinists voted to approve a new four-year contract, ending a strike that lasted several weeks.';
const EXC_B = 'BETA-DETAIL: Striking Boeing workers ratified the deal on Wednesday, ending the walkout that started weeks ago.';

function mockAi(db: DB) {
  const st = { fail: false, attempts: 0, article: 0, cluster: 0, clusterPrompts: [] as string[] };
  const transport: AiTransport = {
    async generateJson({ prompt }) {
      st.attempts++;
      if (st.fail) throw new Error('503 service unavailable');
      if (prompt.includes('cover the same event')) { st.cluster++; st.clusterPrompts.push(prompt); return { text: JSON.stringify({ summary: 'AI consolidated summary', differences: 'Beta adds extra detail.' }), inputTokens: 1, outputTokens: 1 }; }
      const ids = [...prompt.matchAll(/<article id="(\d+)"/g)].map((m) => Number(m[1]));
      st.article++;
      return { text: JSON.stringify({ items: ids.map((id) => ({ id, category: 'Business', importance: 0.5, summary: `AI summary for article ${id}.` })) }), inputTokens: 1, outputTokens: 1 };
    },
  };
  return { ai: new Ai(db, 'm', transport, 1000), st };
}
const deps = (db: DB, ai: Ai | null) => ({ db, ai, log: logger, fetchOpts: { allowPrivate: true } });
async function refresh(db: DB, ai: Ai | null) {
  const d = deps(db, ai); const ids: number[] = [];
  for (const s of db.prepare('SELECT * FROM sources WHERE enabled = 1').all() as SourceRow[]) ids.push(...await ingestSource(d, s));
  await processNewArticles(d, ids);
}
function addSource(db: DB, name: string, path: string) {
  return Number(db.prepare("INSERT INTO sources (name, site_url, feed_url, kind, created_at) VALUES (?,?,?,'rss',?)").run(name, `${fx.url}/site-${name}`, fx.url + path, Date.now()).lastInsertRowid);
}
const set = (path: string, items: Parameters<typeof rss>[0]) => fx.routes.set(path, { body: rss(items) });
const item = (title: string, link: string, desc?: string) => ({ title, link, date: hoursAgo(3), desc });
const clusters = (db: DB) => db.prepare('SELECT * FROM story_clusters ORDER BY id').all() as any[];
const snap = (db: DB) => JSON.stringify([db.prepare('SELECT * FROM articles').all(), db.prepare('SELECT * FROM story_clusters').all()]);

let n = 0;
/** A multi-article cluster created directly (as an older deployment may have left it) with the given cluster summary. */
function directCluster(db: DB, excerpts: (string | null)[], summary: string | null): number {
  const now = Date.now();
  const c = Number(db.prepare('INSERT INTO story_clusters (title,summary,summary_kind,first_published_at,last_published_at,updated_at,created_at,article_count,source_count) VALUES (?,?,?,?,?,?,?,?,?)')
    .run(`Story ${++n}`, summary, summary === null ? null : 'excerpt', now - 3600_000, now - 3600_000, 777, now, excerpts.length, excerpts.length).lastInsertRowid);
  excerpts.forEach((ex, i) => {
    n++;
    const src = Number(db.prepare('INSERT INTO sources (name, site_url, created_at) VALUES (?,?,0)').run(`Pub${n}`, `https://s${n}.example`).lastInsertRowid);
    const fb = sentencesFallback(ex, 't');
    const a = Number(db.prepare(`INSERT INTO articles (source_id,url,canonical_url,canonical_hash,publisher,title,title_norm,excerpt,published_at,fetched_at,content_hash,availability,summary,summary_kind,cluster_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(src, `https://s${n}.example/a`, `https://s${n}.example/a`, `h${n}`, `Pub${n}`, `Title ${n}`, `title ${n}`, ex, now - 3600_000, now, `c${n}`, ex ? 'excerpt' : 'headline_only', fb.text, fb.kind, c).lastInsertRowid);
    db.prepare('INSERT INTO cluster_articles VALUES (?,?,0,?)').run(c, a, now);
    if (i === 0) db.prepare('UPDATE story_clusters SET primary_article_id = ? WHERE id = ?').run(a, c);
  });
  return c;
}

describe('grouped stories always get a usable summary', () => {
  it('REGRESSION: a headline-only story joined by an article with an excerpt gets that excerpt as its summary (AI off)', async () => {
    const db = memDb(); addSource(db, 'Alpha', '/s1-a');
    set('/s1-a', [item(TITLE_A, 'https://a.example/1')]); // headline only
    await refresh(db, null);
    expect(clusters(db)).toHaveLength(1); expect(clusters(db)[0].summary).toBeNull(); // singleton, nothing to summarize yet

    addSource(db, 'Beta', '/s1-b'); set('/s1-b', [item(TITLE_B, 'https://b.example/9', EXC_B)]);
    await refresh(db, null);
    const [c] = clusters(db);
    expect(clusters(db)).toHaveLength(1); expect(c).toMatchObject({ article_count: 2, source_count: 2, summary_kind: 'excerpt' });
    expect(c.summary).toContain('BETA-DETAIL'); // before the fix: null
    expect(isUsableSummary(c.summary)).toBe(true);
    const item0 = queryFeed(db, { tab: 'latest' }).items[0];
    expect(item0.summary).toBe(c.summary); expect(item0.articles.map((a) => a.publisher).sort()).toEqual(['Alpha', 'Beta']);
    expect(item0.articles.map((a) => a.url).sort()).toEqual(['https://a.example/1', 'https://b.example/9']);
  });

  it('two articles with usable excerpts: Gemini writes one consolidated summary from both publishers, once', async () => {
    const db = memDb(); const { ai, st } = mockAi(db);
    addSource(db, 'Alpha', '/s2-a'); addSource(db, 'Beta', '/s2-b');
    set('/s2-a', [item(TITLE_A, 'https://a.example/1', EXC_A)]); set('/s2-b', [item(TITLE_B, 'https://b.example/9', EXC_B)]);
    await refresh(db, ai);
    const [c] = clusters(db);
    expect(c).toMatchObject({ article_count: 2, summary: 'AI consolidated summary', summary_kind: 'ai', differences: 'Beta adds extra detail.' });
    expect(st.cluster).toBe(1);
    const p = st.clusterPrompts[0];
    expect(p).toContain('publisher="Alpha"'); expect(p).toContain('publisher="Beta"'); expect(p).toContain('ALPHA-DETAIL'); expect(p).toContain('BETA-DETAIL'); // both sources, attributed
    expect(p).toMatch(/do not invent/i);
    expect(queryFeed(db, { tab: 'latest' }).items[0].articles).toHaveLength(2);
  });

  it('REGRESSION: existing clusters with NULL or blank summaries are repaired from their excerpts without any new article or AI call', async () => {
    const db = memDb();
    const nullC = directCluster(db, [EXC_A, EXC_B], null); const blankC = directCluster(db, [EXC_A, EXC_B], '   ');
    db.prepare('INSERT INTO bookmarks VALUES (?,5)').run(nullC);
    db.prepare("INSERT INTO feedback (cluster_id, rating, reason, category, created_at, updated_at) VALUES (?,1,NULL,'Business',1,1)").run(nullC);
    db.prepare('INSERT INTO reading_state (cluster_id, read_at) VALUES (?,9)').run(nullC);
    const members = (id: number) => db.prepare('SELECT id, cluster_id FROM articles WHERE cluster_id = ? ORDER BY id').all(id);
    const before = { m: members(nullC), links: db.prepare('SELECT url, publisher FROM articles ORDER BY id').all() };

    await processNewArticles(deps(db, null), []);

    for (const id of [nullC, blankC]) {
      const c = clusters(db).find((x) => x.id === id);
      expect(isUsableSummary(c.summary), `cluster ${id}`).toBe(true); expect(c.summary_kind).toBe('excerpt'); expect(c.summary).toContain('ALPHA-DETAIL');
      expect(c.updated_at).toBe(777); // repairing a summary must not flag the story as "Updated"
    }
    expect(members(nullC)).toEqual(before.m); expect(db.prepare('SELECT url, publisher FROM articles ORDER BY id').all()).toEqual(before.links);
    expect(db.prepare('SELECT created_at FROM bookmarks WHERE cluster_id = ?').get(nullC)).toEqual({ created_at: 5 });
    expect(db.prepare('SELECT rating FROM feedback WHERE cluster_id = ?').get(nullC)).toEqual({ rating: 1 });
    expect(db.prepare('SELECT read_at FROM reading_state WHERE cluster_id = ?').get(nullC)).toEqual({ read_at: 9 });
  });

  it('later, with Gemini available, those repaired clusters get one consolidated summary each, then settle', async () => {
    const db = memDb(); const { ai, st } = mockAi(db);
    directCluster(db, [EXC_A, EXC_B], null); directCluster(db, [EXC_A, EXC_B], '');
    await processNewArticles(deps(db, null), []); // AI off first
    expect(st.attempts).toBe(0);
    await processNewArticles(deps(db, ai), []);
    expect(clusters(db).map((c) => [c.summary, c.summary_kind])).toEqual([['AI consolidated summary', 'ai'], ['AI consolidated summary', 'ai']]);
    expect(st.cluster).toBe(2);
    const calls = st.attempts; const s = snap(db);
    await processNewArticles(deps(db, ai), []); await processNewArticles(deps(db, ai), []);
    expect(st.attempts).toBe(calls); expect(snap(db)).toBe(s);
  });

  it('Gemini failing: excerpts still produce a summary, no exception, no hammering; it recovers later', async () => {
    const db = memDb(); const { ai, st } = mockAi(db);
    for (let i = 0; i < 3; i++) directCluster(db, [EXC_A, EXC_B], null);
    st.fail = true;
    await expect(processNewArticles(deps(db, ai), [])).resolves.toBeDefined();
    expect(clusters(db).every((c) => isUsableSummary(c.summary) && c.summary_kind === 'excerpt')).toBe(true);
    expect(st.attempts).toBeLessThanOrEqual(2); // one failed article batch + one failed cluster call; the run stops instead of retrying each cluster

    st.fail = false;
    for (let i = 0; i < 4; i++) await processNewArticles(deps(db, ai), []);
    expect(clusters(db).every((c) => c.summary === 'AI consolidated summary' && c.summary_kind === 'ai')).toBe(true);
    expect(st.cluster).toBe(3);
    const calls = st.attempts; await processNewArticles(deps(db, ai), []); expect(st.attempts).toBe(calls);
  });

  it('headline-only sources: no summary is invented, Gemini is never asked to consolidate, and repeats are free', async () => {
    const db = memDb(); const { ai, st } = mockAi(db);
    addSource(db, 'Alpha', '/s5-a'); addSource(db, 'Beta', '/s5-b');
    set('/s5-a', [item(TITLE_A, 'https://a.example/1')]); set('/s5-b', [item(TITLE_B, 'https://b.example/9')]);
    await refresh(db, ai);
    const [c] = clusters(db);
    expect(c).toMatchObject({ article_count: 2, summary: null, summary_kind: 'headline' });
    expect(st.cluster).toBe(0);
    expect(queryFeed(db, { tab: 'latest' }).items[0]).toMatchObject({ summary: null, summaryKind: 'headline' }); // UI shows the headline-only message
    const calls = st.attempts; const s = snap(db);
    await refresh(db, ai); await refresh(db, ai); await refresh(db, ai);
    expect(st.attempts).toBe(calls); expect(snap(db)).toBe(s);
  });

  it('only one usable excerpt: the cluster uses it directly and Gemini is not asked to consolidate', async () => {
    const db = memDb(); const { ai, st } = mockAi(db);
    addSource(db, 'Alpha', '/s6-a'); addSource(db, 'Beta', '/s6-b');
    set('/s6-a', [item(TITLE_A, 'https://a.example/1')]); set('/s6-b', [item(TITLE_B, 'https://b.example/9', EXC_B)]);
    await refresh(db, ai);
    expect(isUsableSummary(clusters(db)[0].summary)).toBe(true); expect(st.cluster).toBe(0);
  });

  it('different but related details (AI off): the summary is one publisher\'s own excerpt, never a blend or invention, and every source stays linked', async () => {
    const db = memDb(); addSource(db, 'Alpha', '/s7-a'); addSource(db, 'Beta', '/s7-b');
    set('/s7-a', [item(TITLE_A, 'https://a.example/1', EXC_A)]); set('/s7-b', [item(TITLE_B, 'https://b.example/9', EXC_B)]);
    await refresh(db, null);
    const [c] = clusters(db);
    const fromA = c.summary.includes('ALPHA-DETAIL'), fromB = c.summary.includes('BETA-DETAIL');
    expect(fromA !== fromB).toBe(true); // exactly one source
    expect([EXC_A, EXC_B].some((e) => e.includes(c.summary.replace(/…$/, '')))).toBe(true); // text exists in a source
    const story = queryFeed(db, { tab: 'latest' }).items[0];
    expect(story.articles.map((a) => a.publisher).sort()).toEqual(['Alpha', 'Beta']);
    expect(db.prepare('SELECT COUNT(*) n FROM cluster_articles').get()).toEqual({ n: 2 });
  });

  it('repeated ingestion without changes: no Gemini calls, no writes to articles or clusters', async () => {
    const db = memDb(); const { ai, st } = mockAi(db);
    addSource(db, 'Alpha', '/s8-a'); addSource(db, 'Beta', '/s8-b');
    set('/s8-a', [item(TITLE_A, 'https://a.example/1', EXC_A)]); set('/s8-b', [item(TITLE_B, 'https://b.example/9', EXC_B)]);
    await refresh(db, ai);
    const calls = st.attempts, s = snap(db);
    for (let i = 0; i < 3; i++) await refresh(db, ai);
    expect(st.attempts).toBe(calls); expect(st.cluster).toBe(1); expect(snap(db)).toBe(s);
  });

  it('a cosmetic edit to one article keeps the AI consolidated summary and makes no new Gemini call', async () => {
    const db = memDb(); const { ai, st } = mockAi(db);
    addSource(db, 'Alpha', '/s9-a'); addSource(db, 'Beta', '/s9-b');
    set('/s9-a', [item(TITLE_A, 'https://a.example/1', EXC_A)]); set('/s9-b', [item(TITLE_B, 'https://b.example/9', EXC_B)]);
    await refresh(db, ai);
    const calls = st.attempts;
    set('/s9-b', [item(TITLE_B.toUpperCase() + '!', 'https://b.example/9', EXC_B)]);
    await refresh(db, ai); await refresh(db, ai);
    expect(st.attempts).toBe(calls); expect(clusters(db)[0]).toMatchObject({ summary: 'AI consolidated summary', summary_kind: 'ai' });
  });
});

describe('summary helpers', () => {
  it('isUsableSummary requires real text, not just a value', () => {
    for (const bad of [null, undefined, '', '   ', 'too short']) expect(isUsableSummary(bad as any)).toBe(false);
    expect(isUsableSummary('The council voted on Tuesday to approve the budget.')).toBe(true);
  });
  it('clusterContentHash is order independent and content sensitive', () => {
    expect(clusterContentHash(['a', 'b'])).toBe(clusterContentHash(['b', 'a'])); expect(clusterContentHash(['a', 'b'])).not.toBe(clusterContentHash(['a', 'c']));
  });
});

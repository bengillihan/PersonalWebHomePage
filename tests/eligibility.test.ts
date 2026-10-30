import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { memDb, fixtureServer, rss, hoursAgo, logger, testConfig, type Fixture } from './helpers.js';
import { ingestSource, processNewArticles, type SourceRow } from '../server/news/ingest.js';
import { recomputeCluster, sourceDefaultCategory } from '../server/news/cluster.js';
import { ensureTopicIndex, indexArticleTopics, reindexTopics } from '../server/news/topics.js';
import { queryFeed } from '../server/news/query.js';
import { Ai, type AiTransport } from '../server/ai/gemini.js';
import { buildApp } from '../server/app.js';
import { savePrefs, DEFAULT_PREFS } from '../server/settings.js';
import { setSetting } from '../server/db.js';
import type { OidcClient } from '../server/auth.js';
import type { DB } from '../server/db.js';

let fx: Fixture;
beforeAll(async () => { fx = await fixtureServer(); });
afterAll(async () => { await fx.close(); });

const BMW = 'How to replace the water pump on a BMW E91 wagon: maintenance guide';
const STOCKS = 'Stock market closes higher on strong earnings';
let db: DB; let n = 0;

const src = (name: string, o: { coverage?: 'comprehensive' | 'interest'; categories?: string[]; local?: boolean } = {}) =>
  Number(db.prepare('INSERT INTO sources (name, site_url, coverage, categories, is_local, created_at) VALUES (?,?,?,?,?,0)').run(name, `https://${name.replace(/\W/g, '')}${++n}.example`, o.coverage ?? 'comprehensive', JSON.stringify(o.categories ?? []), o.local ? 1 : 0).lastInsertRowid);

/** A single-article story from `source`, optionally also carried by other feeds, with an optional AI category. */
function story(source: number, title: string, o: { also?: number[]; ai?: string | null; publisher?: string; importance?: number; cluster?: number } = {}) {
  n++;
  const now = Date.now() - 2 * 3600_000;
  const pub = o.publisher ?? (db.prepare('SELECT name FROM sources WHERE id = ?').get(source) as any).name;
  const a = Number(db.prepare(`INSERT INTO articles (source_id,url,canonical_url,canonical_hash,publisher,title,title_norm,excerpt,published_at,fetched_at,content_hash,availability,ai_category,importance)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,'excerpt',?,?)`).run(source, `https://x.example/${n}`, `https://x.example/${n}`, `h${n}`, pub, title, title.toLowerCase(), title, now, now, `c${n}`, o.ai ?? null, o.importance ?? 0.3).lastInsertRowid);
  const cluster = o.cluster ?? Number(db.prepare('INSERT INTO story_clusters (primary_article_id,title,first_published_at,last_published_at,updated_at,created_at) VALUES (?,?,?,?,?,?)').run(a, title, now, now, now, now).lastInsertRowid);
  db.prepare('UPDATE articles SET cluster_id = ? WHERE id = ?').run(cluster, a);
  db.prepare('INSERT INTO cluster_articles VALUES (?,?,0,?)').run(cluster, a, now);
  for (const s of [source, ...(o.also ?? [])]) db.prepare('INSERT OR IGNORE INTO article_sources VALUES (?,?,?)').run(a, s, now);
  indexArticleTopics(db, [a]); recomputeCluster(db, cluster);
  return { cluster, article: a };
}
const interest = (name: string, o: { description?: string; include?: string[]; exclude?: string[]; kind?: 'interest' | 'category' } = {}) => {
  const id = Number(db.prepare('INSERT INTO topics (name, kind, description, priority, include_keywords, exclude_keywords, created_at) VALUES (?,?,?,1,?,?,0)').run(name, o.kind ?? 'interest', o.description ?? '', JSON.stringify(o.include ?? []), JSON.stringify(o.exclude ?? [])).lastInsertRowid);
  reindexTopics(db); return id;
};
const ids = (tab: string, extra: Record<string, string> = {}) => queryFeed(db, { tab, ...extra }).items.map((i) => i.id).sort((a, b) => a - b);
const category = (cluster: number) => (db.prepare('SELECT category FROM story_clusters WHERE id = ?').get(cluster) as any).category;
const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
beforeEach(() => { db = memDb(); });

describe('Interest-only sources filter by interest (eligibility), they do not just change a score', () => {
  it('REGRESSION: an interest-only source shows only matching stories; unrelated ones are hidden everywhere but never deleted', () => {
    interest('BMW E91', { description: 'BMW E91 maintenance' });
    const niche = src('Niche Blog', { coverage: 'interest' }); const general = src('General News');
    const match = story(niche, BMW), other = story(niche, STOCKS), base = story(general, 'City council approves budget');
    for (const tab of ['latest', 'foryou', 'unread', 'explore']) expect(ids(tab), tab).not.toContain(other.cluster);
    expect(ids('latest', { q: 'stock' })).toEqual([]); // not even via search
    expect(ids('latest')).toEqual([match.cluster, base.cluster].sort((a, b) => a - b));
    expect(ids('foryou')).toContain(match.cluster);
    expect(count('SELECT COUNT(*) n FROM articles')).toBe(3); expect(count('SELECT COUNT(*) n FROM story_clusters')).toBe(3); // nothing removed
    expect(count('SELECT COUNT(*) n FROM article_topics')).toBe(1); // only the match is indexed against interests
  });

  it('a general (comprehensive) source is unaffected: all its stories can appear with or without interests', () => {
    const general = src('General News'); const s = story(general, STOCKS);
    expect(ids('latest')).toEqual([s.cluster]);
    interest('BMW E91', { description: 'BMW E91 maintenance' });
    expect(ids('latest')).toEqual([s.cluster]);
  });

  it('with no interests configured, an interest-only source shows nothing (and loses nothing)', () => {
    const niche = src('Niche Blog', { coverage: 'interest' }); story(niche, BMW);
    expect(ids('latest')).toEqual([]); expect(count('SELECT COUNT(*) n FROM articles')).toBe(1);
  });

  it('Saved stories stay accessible even when they are not eligible', () => {
    interest('BMW E91', { description: 'BMW E91 maintenance' });
    const niche = src('Niche Blog', { coverage: 'interest' }); const other = story(niche, STOCKS);
    expect(ids('latest')).toEqual([]);
    db.prepare('INSERT INTO bookmarks VALUES (?,1)').run(other.cluster);
    expect(ids('saved')).toEqual([other.cluster]); expect(ids('latest')).toEqual([]);
    db.prepare('DELETE FROM bookmarks WHERE cluster_id = ?').run(other.cluster);
    expect(ids('saved')).toEqual([]);
  });

  it('explicitly blocked topics stay blocked: an exclude keyword hides an otherwise matching interest-only story, across topics', () => {
    const niche = src('Niche Blog', { coverage: 'interest' });
    const t1 = interest('BMW E91', { description: 'BMW E91 maintenance', exclude: ['lease deal'] });
    interest('Cars', { include: ['cars'] });
    const clean = story(niche, BMW), leased = story(niche, 'BMW E91 maintenance costs versus a lease deal'), cross = story(niche, 'Cars: the best lease deal this month');
    expect(ids('latest')).toEqual([clean.cluster]);
    expect((db.prepare('SELECT blocked FROM articles WHERE id = ?').get(cross.article) as any).blocked).toBe(1); // blocked by a different topic's exclude
    db.prepare('UPDATE topics SET exclude_keywords = ? WHERE id = ?').run('[]', t1); reindexTopics(db); // unblock
    expect(ids('latest')).toEqual([clean.cluster, leased.cluster, cross.cluster].sort((a, b) => a - b));
  });

  it('interests changing after ingestion take effect immediately without re-ingestion', () => {
    const niche = src('Niche Blog', { coverage: 'interest' }); const bmw = story(niche, BMW), stocks = story(niche, STOCKS);
    expect(ids('latest')).toEqual([]);
    const t = interest('BMW', { description: 'BMW E91 maintenance' });
    expect(ids('latest')).toEqual([bmw.cluster]);
    db.prepare('UPDATE topics SET description = ? WHERE id = ?').run('stock market earnings', t); reindexTopics(db);
    expect(ids('latest')).toEqual([stocks.cluster]);
    db.prepare('DELETE FROM topics WHERE id = ?').run(t); reindexTopics(db);
    expect(ids('latest')).toEqual([]);
  });

  it('flipping a source between comprehensive and interest-only applies instantly and reversibly', () => {
    const s = src('Flexible', { coverage: 'comprehensive' }); const st = story(s, STOCKS);
    expect(ids('latest')).toEqual([st.cluster]);
    db.prepare("UPDATE sources SET coverage = 'interest' WHERE id = ?").run(s); expect(ids('latest')).toEqual([]);
    db.prepare("UPDATE sources SET coverage = 'comprehensive' WHERE id = ?").run(s); expect(ids('latest')).toEqual([st.cluster]);
  });

  it('keeps ranking separate from filtering: ranking weights never change who is eligible', () => {
    interest('BMW E91', { description: 'BMW E91 maintenance' });
    const niche = src('Niche Blog', { coverage: 'interest' }); const general = src('General News');
    story(niche, STOCKS, { importance: 0.99 }); const g = story(general, 'Big national story', { importance: 0.9 }); const m = story(niche, BMW);
    const before = ids('latest');
    savePrefs(db, { ...DEFAULT_PREFS, weights: { interests: 0, importance: 1, recency: 0, source: 0, feedback: 0 } });
    expect(ids('latest')).toEqual(before); expect(ids('foryou')).toEqual([g.cluster, m.cluster].sort((a, b) => a - b)); // the 0.99-importance unrelated story is still not eligible
  });
});

describe('multi-source stories use every feed association', () => {
  it('a story stays eligible, and appears once, when a general-news article is in the same cluster', () => {
    interest('BMW E91', { description: 'BMW E91 maintenance' });
    const niche = src('Niche Blog', { coverage: 'interest' }); const general = src('General News');
    const a = story(niche, 'Boeing strike ends after union approves new contract');
    expect(ids('latest')).toEqual([]);
    story(general, 'Union approves new contract, ending Boeing strike', { cluster: a.cluster });
    const items = queryFeed(db, { tab: 'latest' }).items;
    expect(items).toHaveLength(1); expect(items[0].id).toBe(a.cluster);
    expect(items[0].articles.map((x) => x.publisher).sort()).toEqual(['General News', 'Niche Blog']); expect(items[0].sourceCount).toBe(2);
  });

  it('an article originating in an interest-only feed but also carried by a general feed is eligible via article_sources', () => {
    interest('BMW E91', { description: 'BMW E91 maintenance' });
    const niche = src('Niche Blog', { coverage: 'interest' }); const general = src('General News');
    const s = story(niche, STOCKS, { also: [general] });
    expect(ids('latest')).toEqual([s.cluster]);
    db.prepare("UPDATE sources SET coverage = 'interest' WHERE id = ?").run(general); expect(ids('latest')).toEqual([]);
    db.prepare("UPDATE sources SET coverage = 'comprehensive' WHERE id = ?").run(general); expect(ids('latest')).toEqual([s.cluster]);
  });

  it('preserves bookmarks, feedback, read state, sources and summaries while eligibility changes', () => {
    const niche = src('Niche Blog', { coverage: 'interest' }); const s = story(niche, STOCKS);
    db.prepare("UPDATE story_clusters SET summary = 'Kept AI summary', summary_kind = 'ai' WHERE id = ?").run(s.cluster);
    db.prepare('INSERT INTO bookmarks VALUES (?,5)').run(s.cluster);
    db.prepare("INSERT INTO feedback (cluster_id, rating, reason, category, created_at, updated_at) VALUES (?,1,NULL,NULL,1,1)").run(s.cluster);
    db.prepare('INSERT INTO reading_state (cluster_id, read_at) VALUES (?,9)').run(s.cluster); db.prepare('UPDATE story_clusters SET substantive_at = 10 WHERE id = ?').run(s.cluster); // read, then materially updated
    const t = interest('Stocks', { description: 'stock market earnings' }); expect(ids('latest')).toEqual([s.cluster]);
    db.prepare('DELETE FROM topics WHERE id = ?').run(t); reindexTopics(db); expect(ids('latest')).toEqual([]);
    const [saved] = queryFeed(db, { tab: 'saved' }).items;
    expect(saved).toMatchObject({ id: s.cluster, bookmarked: true, rating: 1, isRead: true, summary: 'Kept AI summary', sourceCount: 1 });
    expect(saved.articles[0].publisher).toBe('Niche Blog');
  });
});

describe('source categories: hints and defaults, never overriding a specific AI category', () => {
  it('sourceDefaultCategory only defaults for a niche source with exactly one category', () => {
    expect(sourceDefaultCategory('["Automotive"]', 'interest')).toBe('Automotive');
    expect(sourceDefaultCategory('["Automotive"]', 'comprehensive')).toBeNull(); // a general publisher is never forced into a narrow category
    expect(sourceDefaultCategory('["Local","Regional"]', 'interest')).toBeNull(); // ambiguous
    expect(sourceDefaultCategory('[]', 'interest')).toBeNull(); expect(sourceDefaultCategory('not json', 'interest')).toBeNull(); expect(sourceDefaultCategory(null, null)).toBeNull();
  });

  it('REGRESSION: a niche source\'s category becomes the story category (canonical case) and the category tab filters on it', () => {
    interest('Automotive', { kind: 'category' }); interest('BMW', { description: 'BMW E91 maintenance' });
    const niche = src('Car Blog', { coverage: 'interest', categories: ['automotive'] });
    const s = story(niche, BMW), unrelated = story(niche, STOCKS);
    expect(category(s.cluster)).toBe('Automotive'); // 'automotive' typed by the user -> the known category
    expect(ids('topic', { topic: 'Automotive' })).toEqual([s.cluster]);
    expect(ids('topic', { topic: 'automotive' })).toEqual([s.cluster]); // tab filter is case-insensitive
    expect(ids('topic', { topic: 'Automotive' })).not.toContain(unrelated.cluster); // still filtered by interest
  });

  it('conflicts: a specific AI category wins; generic "Other" or none falls back to the source default', () => {
    const niche = src('Car Blog', { coverage: 'interest', categories: ['Automotive'] });
    expect(category(story(niche, 'a', { ai: 'Technology' }).cluster)).toBe('Technology');
    expect(category(story(niche, 'b', { ai: 'Other' }).cluster)).toBe('Automotive');
    expect(category(story(niche, 'c', { ai: null }).cluster)).toBe('Automotive');
  });

  it('a general publisher and multi-category sources are not forced into a narrow category', () => {
    const general = src('General News', { categories: ['World'] }); const multi = src('Regional', { coverage: 'interest', categories: ['Local', 'Regional'] });
    expect(category(story(general, 'g').cluster)).toBeNull(); expect(category(story(multi, 'm').cluster)).toBeNull();
    expect(category(story(general, 'g2', { ai: 'Sports' }).cluster)).toBe('Sports');
  });

  it('categories are passed to Gemini only as weak hints, and a conflicting AI category is kept', async () => {
    const prompts: string[] = []; let calls = 0;
    const transport: AiTransport = { async generateJson({ prompt }) { calls++; prompts.push(prompt); const id = Number(/<article id="(\d+)"/.exec(prompt)![1]); return { text: JSON.stringify({ items: [{ id, category: 'Sports', importance: 0.5, summary: null }] }), inputTokens: 1, outputTokens: 1 }; } };
    const general = src('General News', { categories: ['World'] }); const s = story(general, 'Local team wins the championship game');
    await processNewArticles({ db, ai: new Ai(db, 'm', transport, 100), log: logger }, []);
    expect(calls).toBe(1); expect(prompts[0]).toContain('Publisher sections (weak hint): World');
    expect(category(s.cluster)).toBe('Sports'); // source hint 'World' did not override the AI's more specific topic
  });
});

describe('importance is no longer how interest-only works', () => {
  it('REGRESSION: identical feeds from a comprehensive and an interest-only source get identical importance scores', async () => {
    const mk = (name: string, coverage: string, path: string) => Number(db.prepare("INSERT INTO sources (name, site_url, feed_url, kind, coverage, created_at) VALUES (?,?,?,'rss',?,0)").run(name, `${fx.url}/s-${name}`, fx.url + path, coverage).lastInsertRowid);
    const items = (tag: string) => Array.from({ length: 4 }, (_, i) => ({ title: `${tag} headline number ${i} about different things`, link: `https://${tag}.example/${i}`, date: hoursAgo(i + 1), desc: undefined as string | undefined }));
    fx.routes.set('/imp-a', { body: rss(items('alpha')) }); fx.routes.set('/imp-b', { body: rss(items('beta')) });
    const a = mk('Alpha', 'comprehensive', '/imp-a'), b = mk('Beta', 'interest', '/imp-b');
    for (const s of db.prepare('SELECT * FROM sources').all() as SourceRow[]) await ingestSource({ db, ai: null, log: logger, fetchOpts: { allowPrivate: true } }, s);
    const imp = (id: number) => (db.prepare('SELECT importance FROM articles WHERE source_id = ? ORDER BY published_at DESC').all(id) as any[]).map((r) => r.importance);
    expect(imp(a)).toEqual(imp(b)); expect(imp(b)[0]).toBeGreaterThan(0.3); // before the fix the interest-only feed was stuck at 0.3
  });
});

describe('index backfill', () => {
  it('ensureTopicIndex backfills blocked flags once for an existing database', () => {
    const niche = src('Niche Blog', { coverage: 'interest' }); const s = story(niche, 'BMW E91 lease deal');
    db.prepare("INSERT INTO topics (name, kind, description, priority, include_keywords, exclude_keywords, created_at) VALUES ('BMW','interest','BMW E91',1,'[]','[\"lease deal\"]',0)").run();
    expect((db.prepare('SELECT blocked FROM articles WHERE id = ?').get(s.article) as any).blocked).toBe(0); // as after migration 3
    expect(ensureTopicIndex(db)).toBe(true);
    expect((db.prepare('SELECT blocked FROM articles WHERE id = ?').get(s.article) as any).blocked).toBe(1);
    expect(ensureTopicIndex(db)).toBe(false);
  });
});

describe('via the API: no Gemini requests, and eligibility follows preference changes', () => {
  let app: FastifyInstance; let cookie = ''; let csrf = ''; let attempts = 0;
  const oidc: OidcClient & { nonce?: string } = { authUrl: ({ state, nonce }) => `https://x/?state=${state}&nonce=${nonce}`, async exchange() { return { sub: 's', email: 'me@example.com', emailVerified: true, name: 'Me', nonce: oidc.nonce ?? null }; } };
  beforeEach(async () => {
    attempts = 0;
    setSetting(db, 'last_news_refresh_at', Date.now()); // cache is fresh, so opening the dashboard starts no background refresh (which may legitimately analyse NEW articles)
    ({ app } = await buildApp(testConfig(), db, { oidc, logger: false, transport: { async generateJson() { attempts++; throw new Error('should not be called'); } } }));
    const r1 = await app.inject({ url: '/auth/login' }); const loc = new URL(r1.headers.location as string); oidc.nonce = loc.searchParams.get('nonce')!;
    const r2 = await app.inject({ url: `/auth/callback?code=c&state=${loc.searchParams.get('state')}`, cookies: { oauth_tx: r1.cookies[0].value } });
    cookie = r2.cookies.find((c) => c.name === 'sid')!.value; csrf = (await app.inject({ url: '/api/me', cookies: { sid: cookie } })).json().csrfToken;
  });
  afterEach(async () => { await app.close(); });
  const call = (method: any, url: string, payload?: unknown) => app.inject({ method, url, cookies: { sid: cookie }, headers: { 'x-csrf-token': csrf }, payload: payload as any });
  const feedIds = async (tab = 'latest') => ((await call('GET', `/api/feed?tab=${tab}&limit=50`)).json().items as any[]).map((i) => i.id).sort((a, b) => a - b);

  it('adding, editing and deleting interests and changing source settings re-evaluates eligibility with zero Gemini calls', async () => {
    const niche = src('Niche Blog', { coverage: 'interest' }); const bmw = story(niche, BMW), stocks = story(niche, STOCKS);
    expect(await feedIds()).toEqual([]);
    const add = await call('POST', '/api/topics', { name: 'BMW', kind: 'interest', description: 'BMW E91 maintenance', priority: 'normal', include: [], exclude: [] });
    expect(add.statusCode).toBe(201); const topicId = add.json().id;
    expect(await feedIds()).toEqual([bmw.cluster]);
    expect((await call('PUT', `/api/topics/${topicId}`, { name: 'Stocks', kind: 'interest', description: 'stock market earnings', priority: 'normal', include: [], exclude: [] })).statusCode).toBe(200);
    expect(await feedIds()).toEqual([stocks.cluster]);
    expect((await call('PUT', `/api/topics/${topicId}`, { name: 'Stocks', kind: 'interest', description: 'stock market earnings', priority: 'normal', include: [], exclude: ['strong earnings'] })).statusCode).toBe(200);
    expect(await feedIds()).toEqual([]); // blocked keyword now hides it
    expect((await call('DELETE', `/api/topics/${topicId}`)).statusCode).toBe(200);
    expect(await feedIds()).toEqual([]);
    expect((await call('PATCH', `/api/sources/${niche}`, { coverage: 'comprehensive' })).statusCode).toBe(200);
    expect(await feedIds()).toEqual([bmw.cluster, stocks.cluster].sort((a, b) => a - b)); // source setting applies instantly
    expect((await call('PATCH', `/api/sources/${niche}`, { coverage: 'interest' })).statusCode).toBe(200);
    expect(await feedIds()).toEqual([]);
    for (let i = 0; i < 3; i++) await feedIds('foryou');
    expect(attempts).toBe(0);
  });

  it('editing source categories updates existing stories\' categories locally', async () => {
    const niche = src('Car Blog', { coverage: 'interest' }); const s = story(niche, BMW);
    expect(category(s.cluster)).toBeNull();
    expect((await call('PATCH', `/api/sources/${niche}`, { categories: ['automotive'] })).statusCode).toBe(200);
    expect(category(s.cluster)).toBe('Automotive');
    expect((await call('PATCH', `/api/sources/${niche}`, { categories: ['Food'] })).statusCode).toBe(200);
    expect(category(s.cluster)).toBe('Food');
    expect((await call('PATCH', `/api/sources/${niche}`, { categories: [] })).statusCode).toBe(200);
    expect(category(s.cluster)).toBeNull();
    expect(attempts).toBe(0);
  });
});

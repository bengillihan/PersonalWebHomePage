import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { memDb, fixtureServer, rss, hoursAgo, logger, testConfig, type Fixture } from './helpers.js';
import { parseBlockPhrases, reindexBlocks, indexArticleBlocks, ensureBlockIndex, previewBlock, suggestBlock } from '../server/news/blocking.js';
import { ingestSource, processNewArticles, type SourceRow } from '../server/news/ingest.js';
import { recomputeCluster } from '../server/news/cluster.js';
import { queryFeed } from '../server/news/query.js';
import { seedDefaults, SEED_BLOCKED } from '../server/seed.js';
import { Ai, type AiTransport } from '../server/ai/gemini.js';
import { setSetting, migrate } from '../server/db.js';
import { MIGRATIONS } from '../server/migrations.js';
import { buildApp } from '../server/app.js';
import type { OidcClient } from '../server/auth.js';
import type { DB } from '../server/db.js';

let fx: Fixture;
beforeAll(async () => { fx = await fixtureServer(); });
afterAll(async () => { await fx.close(); });

let db: DB; let n = 0;
const src = (name: string, o: { local?: boolean; coverage?: 'comprehensive' | 'interest' } = {}) =>
  Number(db.prepare('INSERT INTO sources (name, site_url, is_local, coverage, created_at) VALUES (?,?,?,?,0)').run(name, `https://${name.replace(/\W/g, '')}${++n}.example`, o.local ? 1 : 0, o.coverage ?? 'comprehensive').lastInsertRowid);
/** One story (cluster) with one article, or an extra article in `cluster`. Matches are indexed the way ingestion does. */
function story(source: number, title: string, o: { excerpt?: string; ai?: string | null; cluster?: number; ageMin?: number } = {}) {
  n++;
  const at = Date.now() - (o.ageMin ?? 60) * 60_000;
  const pub = (db.prepare('SELECT name FROM sources WHERE id = ?').get(source) as any).name;
  const a = Number(db.prepare(`INSERT INTO articles (source_id,url,canonical_url,canonical_hash,publisher,title,title_norm,excerpt,published_at,fetched_at,content_hash,availability,summary,summary_kind,ai_category,importance)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,'excerpt',?,?,?,0.5)`).run(source, `https://x.example/${n}`, `https://x.example/${n}`, `h${n}`, pub, title, title.toLowerCase(), o.excerpt ?? `${title}. Extra detail.`, at, at, `c${n}`, o.excerpt ?? `${title}. Extra detail.`, 'excerpt', o.ai ?? null).lastInsertRowid);
  const c = o.cluster ?? Number(db.prepare('INSERT INTO story_clusters (primary_article_id,title,first_published_at,last_published_at,updated_at,created_at) VALUES (?,?,?,?,?,?)').run(a, title, at, at, at, at).lastInsertRowid);
  db.prepare('UPDATE articles SET cluster_id = ? WHERE id = ?').run(c, a);
  db.prepare('INSERT INTO cluster_articles VALUES (?,?,0,?)').run(c, a, at);
  db.prepare('INSERT INTO article_sources VALUES (?,?,?)').run(a, source, at);
  indexArticleBlocks(db, [a]); recomputeCluster(db, c);
  return { cluster: c, article: a };
}
const HOCKEY_WORDS = JSON.stringify(['hockey', 'nhl', 'stanley cup', 'seattle kraken', 'canucks']);
const block = (name: string, o: { keywords?: string; categories?: string[]; enabled?: boolean } = {}) => {
  const id = Number(db.prepare('INSERT INTO blocked_topics (name, description, keywords, categories, enabled, created_at) VALUES (?,?,?,?,?,0)').run(name, name, o.keywords ?? HOCKEY_WORDS, JSON.stringify(o.categories ?? []), o.enabled === false ? 0 : 1).lastInsertRowid);
  reindexBlocks(db, id); return id;
};
const ids = (tab: string, extra: Record<string, string> = {}) => queryFeed(db, { tab, limit: 50, ...extra }).items.map((i) => i.id).sort((a, b) => a - b);
const asc = (...x: number[]) => [...x].sort((a, b) => a - b);
const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
const blockedFor = (article: number) => (db.prepare('SELECT topic_id FROM article_blocks WHERE article_id = ?').all(article) as any[]).length;
beforeEach(() => { db = memDb(); });

describe('natural-language input becomes matching phrases', () => {
  it('splits lists and sentences, strips filler, and refuses generic words on their own', () => {
    expect(parseBlockPhrases('hockey, NHL, Stanley Cup')).toEqual(['hockey', 'NHL', 'Stanley Cup']);
    expect(parseBlockPhrases('hockey news, NHL scores and trades')).toEqual(['hockey', 'NHL scores']); // "news" is filler; "scores" stays; "trades" alone is too generic
    expect(parseBlockPhrases('cricket news, IPL and test matches')).toEqual(['cricket', 'IPL', 'test matches']); // not the over-broad "test"
    expect(parseBlockPhrases('video games')).toEqual(['video games']);
    expect(parseBlockPhrases("I don't want to see any hockey stories anymore")).toEqual(['hockey']);
    expect(parseBlockPhrases('any more NHL please')).toEqual(['NHL']);
    expect(parseBlockPhrases('hockey player news')).toEqual(['hockey player']);
    expect(parseBlockPhrases('Hockey, hockey')).toEqual(['Hockey']); // de-duplicated, case-insensitively
    for (const generic of ['news', 'sports', 'player news', 'scores and trades', 'trades', 'nh', '']) expect(parseBlockPhrases(generic), generic).toEqual([]);
    expect(parseBlockPhrases(Array.from({ length: 50 }, (_, i) => `topic${i}`).join(',')).length).toBe(30);
  });
});

describe('article matching rules', () => {
  it('blocks on a headline hit, two different keywords in the text, or a stored classification; not on a passing mention', () => {
    const g = src('General'); block('Hockey / NHL');
    const t = (title: string, excerpt: string, ai: string | null = null) => blockedFor(story(g, title, { excerpt, ai }).article) > 0;
    expect(t('Seattle Kraken beat Canucks 4-2', 'A late goal decided it.')).toBe(true); // headline
    expect(t('Trade deadline winners and losers', 'Our NHL writers rank every move at the deadline.')).toBe(false); // ONE body mention only
    expect(t('Winners and losers of the deadline', 'Every NHL team made moves, and hockey fans watched closely.')).toBe(true); // two different keywords in the text
    expect(t('City council approves arena parking plan', 'The plan also touches on the new hockey arena.')).toBe(false); // passing mention
    expect(t('Kraken Technologies raises $50 million for its crypto exchange', 'The firm said it will expand.')).toBe(false); // ambiguous nickname alone is not a keyword
    expect(t('New York Jets sign veteran quarterback', 'The NFL club announced the deal.')).toBe(false); // other sport with a similar nickname
  });

  it('whole words only, case-insensitive', () => {
    const g = src('General'); block('Hockey');
    expect(blockedFor(story(g, 'HOCKEY night in the city').article)).toBe(1);
    expect(blockedFor(story(g, 'Hockeyed past the finish line, a made-up word').article)).toBe(0);
  });

  it('reuses stored classifications for category-based topics, with no AI request', () => {
    const g = src('General'); block('All sports', { keywords: '[]', categories: ['sports'] });
    expect(blockedFor(story(g, 'Mariners walk off winners', { ai: 'Sports' }).article)).toBe(1); // 'sports' vs 'Sports'
    expect(blockedFor(story(g, 'Stocks rally on earnings', { ai: 'Business' }).article)).toBe(0);
    expect(blockedFor(story(g, 'Unclassified story', { ai: null }).article)).toBe(0);
  });
});

describe('hard exclusions in the feeds', () => {
  it('REGRESSION: a hockey article from a comprehensive source is hidden in For You, Latest, Local, Explore, Unread and category feeds, but kept in SQLite', () => {
    const general = src('General News'), local = src('Local News', { local: true }); block('Hockey / NHL');
    const keep = story(general, 'City council approves new park budget', { ai: 'Business' }), keepLocal = story(local, 'Library hours extended for summer', { ai: 'Local' });
    const hockey = story(general, 'Seattle Kraken rally past Canucks in overtime', { ai: 'Business' }), hockeyLocal = story(local, 'Hockey fans pack the downtown arena', { ai: 'Local' });
    for (const tab of ['foryou', 'latest', 'explore', 'unread']) expect(ids(tab), tab).toEqual(asc(keep.cluster, keepLocal.cluster));
    expect(ids('local')).toEqual([keepLocal.cluster]);
    expect(ids('topic', { topic: 'Business' })).toEqual([keep.cluster]);
    expect(count('SELECT COUNT(*) n FROM articles')).toBe(4); expect(count('SELECT COUNT(*) n FROM story_clusters')).toBe(4); // nothing deleted
    expect(ids('latest')).not.toContain(hockey.cluster); expect(ids('latest')).not.toContain(hockeyLocal.cluster);
  });

  it('Saved and search still reach blocked stories, and mark them as blocked', () => {
    const g = src('General News'); block('Hockey / NHL');
    const hockey = story(g, 'Seattle Kraken rally past Canucks in overtime'), plain = story(g, 'Harbor repairs finish early');
    db.prepare('INSERT INTO bookmarks VALUES (?,1)').run(hockey.cluster);
    expect(ids('latest')).toEqual([plain.cluster]);
    const saved = queryFeed(db, { tab: 'saved' }).items; expect(saved.map((i) => i.id)).toEqual([hockey.cluster]); expect(saved[0].blockedBy).toEqual(['Hockey / NHL']);
    const found = queryFeed(db, { tab: 'latest', q: 'kraken' }).items; expect(found.map((i) => i.id)).toEqual([hockey.cluster]); expect(found[0].blockedBy).toEqual(['Hockey / NHL']);
    expect(queryFeed(db, { tab: 'foryou', q: 'canucks' }).items.map((i) => i.id)).toEqual([hockey.cluster]); // even from the For You tab
    expect(queryFeed(db, { tab: 'latest', limit: 50 }).items[0].blockedBy).toEqual([]); // ordinary stories carry no label
  });

  it('decides per article: a multi-source story stays visible while another article about it qualifies', () => {
    const a = src('Alpha'), b = src('Beta'); block('Hockey / NHL');
    const mixed = story(a, 'City approves funding for new downtown stadium', { ageMin: 90 });
    story(b, 'NHL arena funding approved as council weighs budget', { cluster: mixed.cluster, ageMin: 30 }); // this article is about hockey
    const allHockey = story(a, 'Canucks fall to Kraken in shootout', { ageMin: 80 });
    story(b, 'Hockey: Kraken edge Canucks in shootout thriller', { cluster: allHockey.cluster, ageMin: 20 });
    const passing = story(a, 'Council passes budget, parking changes', { excerpt: 'Members also discussed the new hockey arena.', ageMin: 70 });
    expect(ids('latest')).toEqual(asc(mixed.cluster, passing.cluster)); // fully blocked story hidden; mixed story and passing mention stay
    const [item] = queryFeed(db, { tab: 'latest', limit: 50 }).items.filter((i) => i.id === mixed.cluster);
    expect(item.articles).toHaveLength(2); expect(item.sourceCount).toBe(2); expect(item.blockedBy).toEqual([]); // still lists both sources; not labelled blocked
    expect(queryFeed(db, { tab: 'latest', q: 'shootout' }).items.map((i) => i.id)).toEqual([allHockey.cluster]); // the hidden one is still searchable
  });

  it('keeps interest-only source filtering working alongside hard exclusions', () => {
    const niche = src('Niche', { coverage: 'interest' }); block('Hockey / NHL');
    story(niche, 'Unrelated niche story'); expect(ids('latest')).toEqual([]); // still not shown: interest-only without a matching interest
  });
});

describe('changes take effect immediately, without a refresh', () => {
  const oidc: OidcClient & { nonce?: string } = { authUrl: ({ state, nonce }) => `https://x/?state=${state}&nonce=${nonce}`, async exchange() { return { sub: 's', email: 'me@example.com', emailVerified: true, name: 'Me', nonce: oidc.nonce ?? null }; } };
  let app: FastifyInstance; let cookie = ''; let csrf = ''; let attempts = 0;
  beforeEach(async () => {
    attempts = 0; setSetting(db, 'last_news_refresh_at', Date.now());
    ({ app } = await buildApp(testConfig(), db, { oidc, logger: false, transport: { async generateJson() { attempts++; throw new Error('Gemini must not be called'); } } }));
    const r1 = await app.inject({ url: '/auth/login' }); const loc = new URL(r1.headers.location as string); oidc.nonce = loc.searchParams.get('nonce')!;
    const r2 = await app.inject({ url: `/auth/callback?code=c&state=${loc.searchParams.get('state')}`, cookies: { oauth_tx: r1.cookies[0].value } });
    cookie = r2.cookies.find((c) => c.name === 'sid')!.value; csrf = (await app.inject({ url: '/api/me', cookies: { sid: cookie } })).json().csrfToken;
  });
  afterEach(async () => { await app.close(); });
  const call = (method: any, url: string, payload?: unknown) => app.inject({ method, url, cookies: { sid: cookie }, headers: { 'x-csrf-token': csrf }, payload: payload as any });
  const feedIds = async (tab = 'latest') => ((await call('GET', `/api/feed?tab=${tab}&limit=50`)).json().items as any[]).map((i) => i.id).sort((a, b) => a - b);

  it('REGRESSION: add, edit, disable, enable and delete re-evaluate already-ingested articles instantly, with zero Gemini requests', async () => {
    const g = src('General'); const hockey = story(g, 'Seattle Kraken win again'), cricket = story(g, 'IPL final: cricket fans celebrate'), plain = story(g, 'Harbor repairs finish early');
    expect(await feedIds()).toEqual(asc(hockey.cluster, cricket.cluster, plain.cluster));

    const add = await call('POST', '/api/blocked-topics', { name: 'Cricket', description: 'cricket news, IPL and test matches' });
    expect(add.statusCode).toBe(201); const t = add.json(); expect(t).toMatchObject({ name: 'Cricket', enabled: true, blockedArticles: 1 }); expect(t.keywords).toEqual(['cricket', 'IPL', 'test matches']);
    expect(await feedIds()).toEqual(asc(hockey.cluster, plain.cluster)); // cricket gone at once

    expect((await call('PUT', `/api/blocked-topics/${t.id}`, { name: 'Cricket', description: '', keywords: ['seattle kraken'], categories: [] })).statusCode).toBe(200);
    expect(await feedIds()).toEqual(asc(cricket.cluster, plain.cluster)); // edited keywords: cricket back, hockey now hidden

    expect((await call('PATCH', `/api/blocked-topics/${t.id}`, { enabled: false })).json()).toMatchObject({ enabled: false });
    expect(await feedIds()).toEqual(asc(hockey.cluster, cricket.cluster, plain.cluster)); // disabled: everything shows
    expect((await call('PATCH', `/api/blocked-topics/${t.id}`, { enabled: true })).statusCode).toBe(200);
    expect(await feedIds()).toEqual(asc(cricket.cluster, plain.cluster)); // enabled again, no recompute needed
    expect((await call('DELETE', `/api/blocked-topics/${t.id}`)).statusCode).toBe(200);
    expect(await feedIds()).toEqual(asc(hockey.cluster, cricket.cluster, plain.cluster));
    expect(count('SELECT COUNT(*) n FROM article_blocks')).toBe(0); expect(count('SELECT COUNT(*) n FROM articles')).toBe(3);
    for (const tab of ['foryou', 'unread', 'explore']) await feedIds(tab);
    expect(attempts).toBe(0); expect(fx.hits.length).toBeGreaterThanOrEqual(0);
  });

  it('validates input, requires sign-in and CSRF, and rejects duplicates', async () => {
    expect((await app.inject({ url: '/api/blocked-topics' })).statusCode).toBe(401);
    expect((await app.inject({ method: 'POST', url: '/api/blocked-topics', cookies: { sid: cookie }, payload: { name: 'x', description: 'cricket' } })).statusCode).toBe(403);
    for (const bad of [{ name: 'x', description: '' }, { name: 'x', description: 'news and scores' }, { name: '', description: 'cricket' }, { name: 'n'.repeat(81), description: 'cricket' }, { name: 'x', description: 'cricket', keywords: ['k'.repeat(61)] }]) {
      expect((await call('POST', '/api/blocked-topics', bad)).statusCode, JSON.stringify(bad).slice(0, 60)).toBe(400);
    }
    expect((await call('POST', '/api/blocked-topics', { name: 'x', description: 'news' })).json()).toMatchObject({ error: 'no_match_terms' });
    expect((await call('POST', '/api/blocked-topics', { name: 'Cricket', description: 'cricket' })).statusCode).toBe(201);
    expect((await call('POST', '/api/blocked-topics', { name: 'Cricket', description: 'ipl' })).statusCode).toBe(409);
    expect((await call('PUT', '/api/blocked-topics/9999', { name: 'x', description: 'cricket' })).statusCode).toBe(404);
    expect((await call('PATCH', '/api/blocked-topics/9999', { enabled: false })).statusCode).toBe(404);
    expect((await call('POST', '/api/blocked-topics', { name: 'Categories only', description: '', categories: ['Sports'] })).statusCode).toBe(201);
  });

  it('suggestion and preview endpoints: helpful, read-only, and no AI', async () => {
    const g = src('General'); const s = story(g, 'Seahawks beat 49ers in overtime thriller at Lumen Field', { ai: 'Sports' }), other = story(g, 'Stocks rally', { ai: 'Other' });
    story(g, 'Seahawks sign a veteran lineman');
    const sug = (await call('GET', `/api/stories/${s.cluster}/block-suggestion`)).json();
    expect(sug).toMatchObject({ category: 'Sports' }); expect(sug.name).toMatch(/^Seahawks/); expect(sug.keywords).toContain('seahawks');
    expect((await call('GET', `/api/stories/${other.cluster}/block-suggestion`)).json().category).toBeNull(); // 'Other' is not a useful suggestion
    expect((await call('GET', '/api/stories/9999/block-suggestion')).statusCode).toBe(404);
    const pv = (await call('POST', '/api/blocked-topics/preview', { description: 'Seahawks' })).json();
    expect(pv).toMatchObject({ keywords: ['Seahawks'], matches: 2 }); expect(pv.samples).toHaveLength(2);
    expect((await call('POST', '/api/blocked-topics/preview', { description: '', categories: ['Sports'] })).json().matches).toBe(1);
    expect((await call('POST', '/api/blocked-topics/preview', { description: 'news' })).json()).toMatchObject({ keywords: [], matches: 0 });
    expect(count('SELECT COUNT(*) n FROM blocked_topics')).toBe(0); expect(attempts).toBe(0); // nothing was saved
  });

  it('keeps hard exclusions separate from soft thumbs-down feedback, and preserves all user data', async () => {
    const a = src('Alpha'), b = src('Beta'); const hockey = story(a, 'Hockey: Kraken edge Canucks'), other = story(b, 'Harbor repairs finish early');
    db.prepare('INSERT INTO bookmarks VALUES (?,5)').run(hockey.cluster); db.prepare('INSERT INTO reading_state (cluster_id, read_at) VALUES (?,9)').run(hockey.cluster); db.prepare('UPDATE story_clusters SET substantive_at = 10 WHERE id = ?').run(hockey.cluster); // read, then materially updated
    expect((await call('POST', `/api/stories/${other.cluster}/feedback`, { rating: -1, reason: 'topic' })).statusCode).toBe(200); // a SOFT dislike
    expect(count('SELECT COUNT(*) n FROM blocked_topics')).toBe(0); // ...does not create a hard block
    expect(await feedIds()).toEqual(asc(hockey.cluster, other.cluster)); // Latest still shows a thumbs-downed story: soft feedback only affects ranking
    expect(ids('foryou')).toEqual([hockey.cluster]); // (For You drops it, a ranking preference, not a topic exclusion)
    const snap = () => JSON.stringify(['bookmarks', 'feedback', 'feedback_sources', 'reading_state', 'cluster_articles', 'article_sources', 'articles', 'sources'].map((t) => db.prepare(`SELECT * FROM ${t}`).all()));
    const before = snap();
    expect((await call('POST', '/api/blocked-topics', { name: 'Hockey', description: 'hockey, kraken, canucks' })).statusCode).toBe(201); // a HARD block
    expect(snap()).toBe(before); // bookmarks, feedback, reading state, source links and articles are exactly as they were
    expect(db.prepare('SELECT rating, reason FROM feedback').all()).toEqual([{ rating: -1, reason: 'topic' }]); // and the hard block did not write feedback
  });
});

describe('seed, startup backfill, ingestion and migration', () => {
  it('seeds Hockey / NHL once, enabled, and never resurrects it after deletion', () => {
    seedDefaults(db); seedDefaults(db);
    const rows = db.prepare('SELECT name, enabled, seed_key, keywords, categories FROM blocked_topics').all() as any[];
    expect(rows).toHaveLength(1); expect(rows[0]).toMatchObject({ name: 'Hockey / NHL', enabled: 1, seed_key: 'hockey', categories: '[]' });
    const kw: string[] = JSON.parse(rows[0].keywords); expect(kw).toEqual(expect.arrayContaining(['hockey', 'nhl', 'stanley cup', 'seattle kraken', 'canucks']));
    for (const ambiguous of ['kraken', 'jets', 'rangers', 'flames', 'avalanche', 'colorado avalanche', 'florida panthers', 'carolina hurricanes', 'kings', 'ducks', 'capitals', 'panthers']) expect(kw, ambiguous).not.toContain(ambiguous);
    expect(SEED_BLOCKED[0].keywords.length).toBe(kw.length);
    db.prepare('DELETE FROM blocked_topics').run(); seedDefaults(db);
    expect(count('SELECT COUNT(*) n FROM blocked_topics')).toBe(0);
  });

  it('the seeded topic blocks hockey news (games, scores, trades, players, teams, commentary) from general sources, but not look-alikes', () => {
    seedDefaults(db); const g = src('General'); reindexBlocks(db);
    const hockey = [
      story(g, 'Kraken Game Recap: Seattle Kraken 3, Boston Bruins 2 (OT)').cluster, story(g, 'NHL trade rumors: who is available before the deadline?').cluster,
      story(g, 'Star forward signs eight-year extension', { excerpt: 'The NHL club confirmed the deal; the hockey world reacted quickly.' }).cluster,
      story(g, 'Oilers goaltender lands on injured reserve').cluster, story(g, 'Stanley Cup odds: why this hockey season feels wide open').cluster,
      story(g, 'Opinion: The Canucks need a new plan').cluster, story(g, 'Vegas Golden Knights stay hot with another win').cluster,
    ];
    const fine = [
      story(g, 'Kraken Technologies raises funds for its crypto exchange').cluster, story(g, 'New York Jets name starting quarterback').cluster, story(g, 'Avalanche warning issued for the Cascades').cluster,
      story(g, 'Florida panthers spotted near Naples as habitat shrinks').cluster, story(g, 'Mariners walk off Rangers in extras').cluster, story(g, 'Hurricanes batter the Carolina coast').cluster,
    ];
    expect(ids('latest')).toEqual(asc(...fine)); for (const h of hockey) expect(ids('latest')).not.toContain(h);
  });

  it('ensureBlockIndex matches already-stored articles once at startup (existing deployments)', () => {
    const g = src('General'); const hockey = story(g, 'Seattle Kraken win in overtime'), plain = story(g, 'Harbor repairs finish early'); // stored before the feature existed: no matches yet
    seedDefaults(db); expect(blockedFor(hockey.article)).toBe(0); expect(ids('latest')).toEqual(asc(hockey.cluster, plain.cluster));
    expect(ensureBlockIndex(db)).toBe(true); expect(ids('latest')).toEqual([plain.cluster]); expect(ensureBlockIndex(db)).toBe(false);
  });

  it('new articles are matched on ingestion and stay stored; a category block applies after Gemini classifies, with no extra request', async () => {
    const mk = (path: string) => Number(db.prepare("INSERT INTO sources (name, site_url, feed_url, kind, created_at) VALUES (?,?,?,'rss',0)").run('General', `${fx.url}/g${path}`, fx.url + path).lastInsertRowid);
    mk('/bt-feed'); block('Hockey', { keywords: HOCKEY_WORDS }); block('Sports category', { keywords: '[]', categories: ['Sports'] });
    fx.routes.set('/bt-feed', { body: rss([
      { title: 'Seattle Kraken beat Canucks in overtime', link: 'https://n.example/1', date: hoursAgo(2), desc: 'A late goal decided it in front of a sold-out crowd tonight.' },
      { title: 'Mariners rally to beat Astros in extra innings', link: 'https://n.example/2', date: hoursAgo(3), desc: 'The home team scored three in the ninth to win a thrilling baseball game.' },
      { title: 'Council approves new park budget', link: 'https://n.example/3', date: hoursAgo(4), desc: 'The council voted on Tuesday to fund three new parks across the city.' },
    ]) });
    let calls = 0;
    const transport: AiTransport = { async generateJson({ prompt }) {
      calls++; const items = [...prompt.matchAll(/<article id="(\d+)"[^>]*>\nTitle: ([^\n]*)/g)].map((m) => ({ id: Number(m[1]), category: /Mariners/.test(m[2]) ? 'Sports' : 'Local', importance: 0.5, summary: null }));
      return { text: JSON.stringify({ items }), inputTokens: 1, outputTokens: 1 };
    } };
    const ai = new Ai(db, 'm', transport, 100); const d = { db, ai, log: logger, fetchOpts: { allowPrivate: true } };
    const got: number[] = []; for (const s of db.prepare('SELECT * FROM sources').all() as SourceRow[]) got.push(...await ingestSource(d, s));
    await processNewArticles(d, got);
    expect(count('SELECT COUNT(*) n FROM articles')).toBe(3); // everything is stored
    expect(calls).toBe(1); // exactly the normal batch classification: blocking added no request
    const shown = queryFeed(db, { tab: 'latest', limit: 20 }).items.map((i) => i.title);
    expect(shown).toEqual(['Council approves new park budget']); // hockey by keyword at ingest; baseball by its fresh 'Sports' classification
    await processNewArticles(d, []); await processNewArticles(d, []); expect(calls).toBe(1);
  });

  it('migration 5 adds the tables without touching existing data, and is idempotent', () => {
    const raw = new Database(':memory:'); raw.pragma('foreign_keys = ON');
    raw.exec('CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)');
    for (const m of MIGRATIONS.filter((x) => x.id <= 4)) { raw.exec(m.sql); raw.prepare('INSERT INTO schema_migrations VALUES (?,?,0)').run(m.id, m.name); }
    raw.prepare("INSERT INTO sources (name, site_url, created_at) VALUES ('S','https://s.example',0)").run();
    raw.prepare("INSERT INTO articles (source_id,url,canonical_url,canonical_hash,publisher,title,title_norm,published_at,fetched_at,content_hash,availability) VALUES (1,'u','u','h','P','T','t',1,1,'c','headline_only')").run();
    const before = JSON.stringify([raw.prepare('SELECT * FROM sources').all(), raw.prepare('SELECT * FROM articles').all()]);
    expect(migrate(raw as DB)).toEqual(MIGRATIONS.filter((x) => x.id >= 5).map((x) => x.id)); // migration 5 and anything after it
    expect(JSON.stringify([raw.prepare('SELECT * FROM sources').all(), raw.prepare('SELECT * FROM articles').all()])).toBe(before);
    expect(raw.prepare("SELECT name FROM sqlite_master WHERE name IN ('blocked_topics','article_blocks') ORDER BY name").all()).toEqual([{ name: 'article_blocks' }, { name: 'blocked_topics' }]);
    raw.prepare("INSERT INTO blocked_topics (name, created_at) VALUES ('x', 1)").run(); raw.prepare('INSERT INTO article_blocks VALUES (1,1)').run();
    raw.prepare('DELETE FROM articles').run(); expect((raw.prepare('SELECT COUNT(*) n FROM article_blocks').get() as any).n).toBe(0); // cascades with the article
    expect(migrate(raw as DB)).toEqual([]);
  });

  it('suggestBlock / previewBlock helpers', () => {
    expect(suggestBlock('How Seahawks beat the 49ers', 'Sports')).toEqual({ name: 'Seahawks', keywords: ['seahawks'], category: 'Sports' });
    expect(suggestBlock('quiet day in the harbor', 'Other')).toEqual({ name: 'This topic', keywords: [], category: null });
    const g = src('General'); story(g, 'Kraken win'); expect(previewBlock(db, { keywords: ['kraken'], categories: [] }).matches).toBe(1);
  });
});

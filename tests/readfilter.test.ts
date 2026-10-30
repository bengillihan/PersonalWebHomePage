import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { memDb, fixtureServer, rss, logger, testConfig, type Fixture } from './helpers.js';
import { ingestSource, processNewArticles, type SourceRow } from '../server/news/ingest.js';
import { recomputeCluster } from '../server/news/cluster.js';
import { queryFeed } from '../server/news/query.js';
import { getPrefs, savePrefs, DEFAULT_PREFS } from '../server/settings.js';
import { setSetting } from '../server/db.js';
import { buildApp } from '../server/app.js';
import type { OidcClient } from '../server/auth.js';
import type { DB } from '../server/db.js';

let fx: Fixture;
beforeAll(async () => { fx = await fixtureServer(); });
afterAll(async () => { await fx.close(); });

let db: DB; let n = 0;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const src = (name: string, o: { local?: boolean } = {}) => Number(db.prepare('INSERT INTO sources (name, site_url, is_local, created_at) VALUES (?,?,?,0)').run(name, `https://${name.replace(/\W/g, '')}${++n}.example`, o.local ? 1 : 0).lastInsertRowid);

function story(source: number, title: string, o: { ai?: string | null; ageMin?: number; importance?: number } = {}) {
  n++;
  const at = Date.now() - (o.ageMin ?? 60) * 60_000;
  const a = Number(db.prepare(`INSERT INTO articles (source_id,url,canonical_url,canonical_hash,publisher,title,title_norm,excerpt,published_at,fetched_at,content_hash,availability,ai_category,importance)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,'excerpt',?,?)`).run(source, `https://x.example/${n}`, `https://x.example/${n}`, `h${n}`, `Pub${source}`, title, title.toLowerCase(), title, at, at, `c${n}`, o.ai ?? null, o.importance ?? 0.3).lastInsertRowid);
  const c = Number(db.prepare('INSERT INTO story_clusters (primary_article_id,title,first_published_at,last_published_at,updated_at,created_at) VALUES (?,?,?,?,?,?)').run(a, title, at, at, at, at).lastInsertRowid);
  db.prepare('UPDATE articles SET cluster_id = ? WHERE id = ?').run(c, a);
  db.prepare('INSERT INTO cluster_articles VALUES (?,?,0,?)').run(c, a, at);
  db.prepare('INSERT INTO article_sources VALUES (?,?,?)').run(a, source, at);
  recomputeCluster(db, c);
  return c;
}
const markRead = (c: number, at = Date.now()) => db.prepare('INSERT INTO reading_state (cluster_id, read_at) VALUES (?,?) ON CONFLICT(cluster_id) DO UPDATE SET read_at = excluded.read_at').run(c, at);
const ids = (tab: string, extra: Record<string, string> = {}) => queryFeed(db, { tab, limit: 50, ...extra }).items.map((i) => i.id).sort((a, b) => a - b);
const asc = (...x: number[]) => [...x].sort((a, b) => a - b);
const showRead = (on: boolean) => savePrefs(db, { ...getPrefs(db), showRead: on });
beforeEach(() => { db = memDb(); });

describe('read stories are hidden from the main feeds by default', () => {
  function world() {
    const general = src('General'), local = src('Local News', { local: true });
    return {
      unread: story(general, 'Unread business story', { ai: 'Business' }), read: story(general, 'Read business story', { ai: 'Business' }),
      unreadLocal: story(local, 'Unread local story', { ai: 'Local' }), readLocal: story(local, 'Read local story', { ai: 'Local' }),
    };
  }

  it('REGRESSION: For You, Latest, Local, Explore and category feeds exclude read stories; Unread shows only unread', () => {
    const w = world(); markRead(w.read); markRead(w.readLocal);
    expect(getPrefs(db).showRead).toBe(false); // default OFF
    expect(ids('latest')).toEqual(asc(w.unread, w.unreadLocal));
    expect(ids('foryou')).toEqual(asc(w.unread, w.unreadLocal));
    expect(ids('explore')).toEqual(asc(w.unread, w.unreadLocal));
    expect(ids('local')).toEqual([w.unreadLocal]);
    expect(ids('topic', { topic: 'Business' })).toEqual([w.unread]);
    expect(ids('unread')).toEqual(asc(w.unread, w.unreadLocal));
  });

  it('Saved keeps read stories visible regardless of read status', () => {
    const w = world(); markRead(w.read); db.prepare('INSERT INTO bookmarks VALUES (?,1)').run(w.read);
    expect(ids('latest')).not.toContain(w.read);
    const saved = queryFeed(db, { tab: 'saved' }).items;
    expect(saved.map((i) => i.id)).toEqual([w.read]); expect(saved[0]).toMatchObject({ isRead: true, bookmarked: true });
  });

  it('search results include read stories so they can be found again', () => {
    const w = world(); markRead(w.read);
    expect(ids('latest', { q: 'business' })).toEqual(asc(w.unread, w.read));
    expect(ids('foryou', { q: 'business' })).toEqual(asc(w.unread, w.read)); // even from the For You tab
    expect(queryFeed(db, { tab: 'latest', q: 'business', limit: 50 }).items.find((i) => i.id === w.read)).toMatchObject({ isRead: true }); // and still marked read
    expect(ids('unread', { q: 'business' })).toEqual([w.unread]); // the Unread tab stays strictly unread
  });

  it('"Show read stories" ON includes read stories everywhere except Unread, flagged read so the UI dims them', () => {
    const w = world(); markRead(w.read); markRead(w.readLocal); showRead(true);
    expect(ids('latest')).toEqual(asc(...Object.values(w)));
    expect(ids('foryou')).toEqual(asc(...Object.values(w))); expect(ids('explore')).toEqual(asc(...Object.values(w)));
    expect(ids('local')).toEqual(asc(w.unreadLocal, w.readLocal)); expect(ids('topic', { topic: 'Business' })).toEqual(asc(w.unread, w.read));
    expect(ids('unread')).toEqual(asc(w.unread, w.unreadLocal));
    const latest = queryFeed(db, { tab: 'latest', limit: 50 }).items;
    expect(latest.find((i) => i.id === w.read)).toMatchObject({ isRead: true, isUpdated: false });
    expect(latest.find((i) => i.id === w.unread)).toMatchObject({ isRead: false });
    showRead(false); expect(ids('latest')).toEqual(asc(w.unread, w.unreadLocal)); // reversible
  });

  it('marking unread brings a story back', () => {
    const w = world(); markRead(w.read); expect(ids('latest')).not.toContain(w.read);
    db.prepare('UPDATE reading_state SET read_at = NULL WHERE cluster_id = ?').run(w.read); expect(ids('latest')).toContain(w.read);
  });
});

describe('pagination, counts and ranking are unaffected by the read filter', () => {
  it('pages through only unread stories with no gaps or duplicates, and totals exclude read stories', () => {
    const g = src('General'); const all = Array.from({ length: 25 }, (_, i) => story(g, `Story number ${i}`, { ageMin: 10 + i, importance: 0.9 }));
    const read = all.filter((_, i) => i % 5 === 0 || i % 7 === 0); read.forEach((c) => markRead(c));
    const unread = all.filter((c) => !read.includes(c));
    const walk = (tab: string, limit: number) => { const seen: number[] = []; let cursor: string | undefined; let first: any;
      for (let guard = 0; guard < 20; guard++) { const p = queryFeed(db, { tab, limit, cursor }); first ??= p; seen.push(...p.items.map((i) => i.id)); cursor = p.nextCursor ?? undefined; if (!cursor) break; } return { seen, first }; };
    const latest = walk('latest', 4); expect(latest.seen).toEqual(unread); // newest first, every unread story exactly once, across 4 pages
    expect(asc(...latest.seen)).toEqual(asc(...unread)); expect(new Set(latest.seen).size).toBe(unread.length);
    const foryou = walk('foryou', 4); expect(asc(...foryou.seen)).toEqual(asc(...unread)); expect(foryou.first.total).toBe(unread.length); // count excludes read stories
    expect(asc(...walk('unread', 6).seen)).toEqual(asc(...unread));
    showRead(true); expect(asc(...walk('latest', 4).seen)).toEqual(asc(...all)); expect(walk('foryou', 4).first.total).toBe(all.length);
  });

  it('keeps ranking order, bookmarks, feedback and source relationships exactly as they were', () => {
    const g = src('General'); const cs = [0.95, 0.9, 0.8, 0.7, 0.6, 0.5].map((imp, i) => story(g, `Ranked story ${i}`, { importance: imp, ageMin: 30 + i * 10 }));
    db.prepare('INSERT INTO bookmarks VALUES (?,7)').run(cs[1]);
    db.prepare("INSERT INTO feedback (cluster_id, rating, reason, category, created_at, updated_at) VALUES (?,1,NULL,NULL,1,1)").run(cs[2]);
    const order = () => queryFeed(db, { tab: 'foryou', limit: 50 }).items.map((i) => i.id);
    const before = order(); expect(before).toHaveLength(6);
    const snap = () => JSON.stringify(['bookmarks', 'feedback', 'cluster_articles', 'article_sources', 'articles'].map((t) => db.prepare(`SELECT * FROM ${t}`).all()));
    const state = snap();
    markRead(cs[0]); markRead(cs[3]);
    expect(order()).toEqual(before.filter((id) => id !== cs[0] && id !== cs[3])); // same relative order, read ones removed
    expect(snap()).toBe(state); // nothing else changed
    showRead(true); expect(order()).toEqual(before);
  });
});

describe('read applies to the whole story; only a material development makes it reappear as Updated', () => {
  const A = { title: 'Boeing strike ends after union approves new contract', link: 'https://alpha.example/1', desc: 'Boeing machinists voted to approve a new four-year contract, ending a strike that lasted several weeks.' };
  const B = { title: 'Union approves new contract, ending Boeing strike', link: 'https://beta.example/9', desc: 'Striking Boeing workers ratified a new contract on Wednesday, ending the walkout that started weeks ago.' };
  const items = (i: { title: string; link: string; desc: string }) => rss([{ ...i, date: new Date(Date.now() - 3_600_000) }]);
  async function refresh() {
    const d = { db, ai: null, log: logger, fetchOpts: { allowPrivate: true } }; const got: number[] = [];
    for (const s of db.prepare('SELECT * FROM sources ORDER BY id').all() as SourceRow[]) got.push(...await ingestSource(d, s));
    await processNewArticles(d, got);
  }
  const mkSrc = (name: string, path: string) => Number(db.prepare("INSERT INTO sources (name, site_url, feed_url, kind, created_at) VALUES (?,?,?,'rss',0)").run(name, `${fx.url}/${name}`, fx.url + path).lastInsertRowid);

  it('REGRESSION: read hides the whole multi-source story; more coverage of the same facts keeps it hidden; cosmetic edits do too; a material correction reopens it', async () => {
    mkSrc('Alpha', '/rf-a'); fx.routes.set('/rf-a', { body: items(A) });
    await refresh();
    const cluster = (db.prepare('SELECT id FROM story_clusters').get() as any).id;
    expect(ids('latest')).toEqual([cluster]);
    markRead(cluster); await sleep(5);
    expect(ids('latest')).toEqual([]); expect(ids('unread')).toEqual([]);

    mkSrc('Beta', '/rf-b'); fx.routes.set('/rf-b', { body: items(B) }); // a second publisher reports the same event
    await refresh();
    expect((db.prepare('SELECT article_count, source_count FROM story_clusters').get() as any)).toEqual({ article_count: 2, source_count: 2 }); // one story, both articles
    expect(ids('latest')).toEqual([]); // before: a second publisher reporting the same facts resurfaced it as "Updated"
    expect(ids('unread')).toEqual([]); expect(queryFeed(db, { tab: 'saved' }).items).toEqual([]);
    expect(queryFeed(db, { tab: 'latest', q: 'boeing' }).items[0]).toMatchObject({ id: cluster, isRead: true, isUpdated: false, sourceCount: 2 }); // the new source joined the story's coverage

    fx.routes.set('/rf-a', { body: items({ ...A, title: A.title.toUpperCase() + '!', desc: A.desc.toUpperCase() }) }); // cosmetic edit only
    await refresh(); expect(ids('latest')).toEqual([]);

    fx.routes.set('/rf-a', { body: items({ ...A, desc: 'Correction: the machinists approved the contract by a narrow 51 percent margin on Thursday, not Wednesday as first reported.' }) });
    await refresh(); expect(queryFeed(db, { tab: 'latest' }).items[0]).toMatchObject({ id: cluster, isRead: true, isUpdated: true }); // substantive change resurfaces it, labelled Updated
    markRead(cluster); await sleep(5); expect(ids('latest')).toEqual([]); // and reading it again hides it again, once
  });
});

describe('via the API: preference persistence, mark read and undo', () => {
  let app: FastifyInstance; let cookie = ''; let csrf = '';
  const oidc: OidcClient & { nonce?: string } = { authUrl: ({ state, nonce }) => `https://x/?state=${state}&nonce=${nonce}`, async exchange() { return { sub: 's', email: 'me@example.com', emailVerified: true, name: 'Me', nonce: oidc.nonce ?? null }; } };
  beforeEach(async () => {
    setSetting(db, 'last_news_refresh_at', Date.now());
    ({ app } = await buildApp(testConfig(), db, { oidc, logger: false, transport: null }));
    const r1 = await app.inject({ url: '/auth/login' }); const loc = new URL(r1.headers.location as string); oidc.nonce = loc.searchParams.get('nonce')!;
    const r2 = await app.inject({ url: `/auth/callback?code=c&state=${loc.searchParams.get('state')}`, cookies: { oauth_tx: r1.cookies[0].value } });
    cookie = r2.cookies.find((c) => c.name === 'sid')!.value; csrf = (await app.inject({ url: '/api/me', cookies: { sid: cookie } })).json().csrfToken;
  });
  afterEach(async () => { await app.close(); });
  const call = (method: any, url: string, payload?: unknown) => app.inject({ method, url, cookies: { sid: cookie }, headers: { 'x-csrf-token': csrf }, payload: payload as any });
  const feedIds = async (tab = 'latest') => ((await call('GET', `/api/feed?tab=${tab}&limit=50`)).json().items as any[]).map((i) => i.id);

  it('"Show read stories" defaults OFF and persists in SQLite; older clients that omit it do not reset it', async () => {
    expect((await call('GET', '/api/prefs')).json().prefs.showRead).toBe(false);
    expect((await call('GET', '/api/feed?tab=latest')).json().showRead).toBe(false);
    const prefs = (await call('GET', '/api/prefs')).json().prefs;
    expect((await call('PUT', '/api/prefs', { ...prefs, showRead: true })).statusCode).toBe(200);
    expect(JSON.parse((db.prepare("SELECT value FROM application_settings WHERE key = 'prefs'").get() as any).value).showRead).toBe(true); // stored in SQLite
    expect((await call('GET', '/api/feed?tab=latest')).json().showRead).toBe(true);
    const { showRead: _s, ...without } = prefs;
    expect((await call('PUT', '/api/prefs', without)).statusCode).toBe(200);
    expect((await call('GET', '/api/prefs')).json().prefs.showRead).toBe(true);
    expect((await call('PUT', '/api/prefs', { ...prefs, showRead: 'yes' })).statusCode).toBe(400);
    expect((await call('PUT', '/api/prefs', { ...prefs, showRead: false })).statusCode).toBe(200);
    expect((await call('GET', '/api/prefs')).json().prefs.showRead).toBe(false);
  });

  it('marking read removes the story from the next feed response, and undo (mark unread) restores it in place', async () => {
    const g = src('General'); const c1 = story(g, 'First story', { ageMin: 10 }), c2 = story(g, 'Second story', { ageMin: 20 }), c3 = story(g, 'Third story', { ageMin: 30 });
    expect(await feedIds()).toEqual([c1, c2, c3]);
    expect((await call('POST', `/api/stories/${c2}/read`, { read: true })).statusCode).toBe(200);
    expect(await feedIds()).toEqual([c1, c3]); expect(await feedIds('unread')).toEqual([c1, c3]);
    expect((await call('POST', `/api/stories/${c2}/read`, { read: false })).statusCode).toBe(200); // Undo
    expect(await feedIds()).toEqual([c1, c2, c3]); // back in its original position
    expect((await call('POST', '/api/stories/99999/read', { read: true })).statusCode).toBe(404);
    expect(getPrefs(db)).toMatchObject({ weights: DEFAULT_PREFS.weights });
  });
});

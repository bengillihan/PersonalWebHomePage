import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { memDb, testConfig } from './helpers.js';
import { recomputeCluster } from '../server/news/cluster.js';
import { queryFeed } from '../server/news/query.js';
import { getPrefs, savePrefs } from '../server/settings.js';
import { setSetting } from '../server/db.js';
import { buildApp } from '../server/app.js';
import type { OidcClient } from '../server/auth.js';
import type { DB } from '../server/db.js';

let db: DB; let n = 0;
const src = (name: string, o: { local?: boolean; coverage?: 'comprehensive' | 'interest' } = {}) =>
  Number(db.prepare('INSERT INTO sources (name, site_url, is_local, coverage, created_at) VALUES (?,?,?,?,0)').run(name, `https://${name.replace(/\W/g, '')}${++n}.example`, o.local ? 1 : 0, o.coverage ?? 'comprehensive').lastInsertRowid);
/** One story with one article, or an extra article in `cluster`. */
function story(source: number, title: string, o: { cluster?: number; ai?: string | null; importance?: number; ageMin?: number } = {}) {
  n++; const at = Date.now() - (o.ageMin ?? 60) * 60_000; const pub = (db.prepare('SELECT name FROM sources WHERE id = ?').get(source) as any).name;
  const a = Number(db.prepare(`INSERT INTO articles (source_id,url,canonical_url,canonical_hash,publisher,title,title_norm,excerpt,published_at,fetched_at,content_hash,availability,summary,summary_kind,ai_category,importance)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,'excerpt',?,?,?,?)`).run(source, `https://x.example/${n}`, `https://x.example/${n}`, `h${n}`, pub, title, title.toLowerCase(), `${title}. Detail.`, at, at, `c${n}`, `${title}. Detail.`, 'excerpt', o.ai ?? null, o.importance ?? 0.9).lastInsertRowid);
  const c = o.cluster ?? Number(db.prepare('INSERT INTO story_clusters (primary_article_id,title,first_published_at,last_published_at,updated_at,created_at) VALUES (?,?,?,?,?,?)').run(a, title, at, at, at, at).lastInsertRowid);
  db.prepare('UPDATE articles SET cluster_id = ? WHERE id = ?').run(c, a); db.prepare('INSERT INTO cluster_articles VALUES (?,?,0,?)').run(c, a, at); db.prepare('INSERT INTO article_sources VALUES (?,?,?)').run(a, source, at);
  recomputeCluster(db, c); return { cluster: c, article: a };
}
const mute = (...names: string[]) => savePrefs(db, { ...getPrefs(db), mutedPublishers: names });
const ids = (tab: string, extra: Record<string, string> = {}) => queryFeed(db, { tab, limit: 50, ...extra }).items.map((i) => i.id).sort((a, b) => a - b);
const asc = (...x: number[]) => [...x].sort((a, b) => a - b);
const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
beforeEach(() => { db = memDb(); });

describe('a muted publisher is excluded from normal feeds, not just ranked lower', () => {
  it('REGRESSION: a muted publisher\'s stories vanish from For You, Latest, Local, Explore, Unread and category tabs, and stay in SQLite', () => {
    const loud = src('Loud Blog'), loudLocal = src('Loud Local', { local: true }), fine = src('General'), fineLocal = src('Calm Local', { local: true });
    const a = story(loud, 'Muted general story', { ai: 'Business' }), b = story(loudLocal, 'Muted local story', { ai: 'Local' }), ok = story(fine, 'Good story', { ai: 'Business' }), okLocal = story(fineLocal, 'Good local story', { ai: 'Local' });
    mute('Loud Blog', 'Loud Local');
    for (const tab of ['foryou', 'latest', 'explore', 'unread']) expect(ids(tab), tab).toEqual(asc(ok.cluster, okLocal.cluster));
    expect(ids('local')).toEqual([okLocal.cluster]); expect(ids('topic', { topic: 'Business' })).toEqual([ok.cluster]);
    expect(count('SELECT COUNT(*) n FROM articles')).toBe(4); expect(count('SELECT COUNT(*) n FROM story_clusters')).toBe(4); // nothing deleted
    expect(ids('latest')).not.toContain(a.cluster); expect(ids('latest')).not.toContain(b.cluster);
  });

  it('Saved and search still reach muted stories, and label them', () => {
    const loud = src('Loud Blog'), fine = src('General'); const m = story(loud, 'Muted story about harbor repairs'), ok = story(fine, 'Other story about budgets'); mute('Loud Blog');
    db.prepare('INSERT INTO bookmarks VALUES (?,1)').run(m.cluster);
    expect(ids('latest')).toEqual([ok.cluster]);
    const saved = queryFeed(db, { tab: 'saved' }).items; expect(saved.map((i) => i.id)).toEqual([m.cluster]); expect(saved[0].articles[0].muted).toBe(true);
    const found = queryFeed(db, { tab: 'latest', q: 'harbor' }).items; expect(found.map((i) => i.id)).toEqual([m.cluster]); expect(found[0]).toMatchObject({ sourceCount: 1 });
    expect(queryFeed(db, { tab: 'foryou', q: 'harbor' }).items.map((i) => i.id)).toEqual([m.cluster]); // even from the For You tab
  });

  it('case and spacing in the saved list do not matter', () => {
    const loud = src('Loud Blog'); const m = story(loud, 'Muted story'); mute('  loud BLOG ');
    expect(ids('latest')).toEqual([]); expect(m.cluster).toBeGreaterThan(0);
  });
});

describe('multi-source stories', () => {
  it('REGRESSION: stay visible while an unmuted publisher covers them; the muted coverage is labelled, not counted', () => {
    const loud = src('Loud Blog'), fine = src('General');
    const first = story(loud, 'Loud headline about the contract', { ageMin: 120 }); // the muted publisher is the primary article
    story(fine, 'General headline on the contract deal', { cluster: first.cluster, ageMin: 30 });
    expect(queryFeed(db, { tab: 'latest', limit: 10 }).items[0]).toMatchObject({ sourceCount: 2 }); // not muted yet
    mute('Loud Blog');
    const [item] = queryFeed(db, { tab: 'latest', limit: 10 }).items;
    expect(item.id).toBe(first.cluster);
    expect(item).toMatchObject({ sourceCount: 1, mutedSources: 1 }); // only the unmuted publisher counts; the muted one is reported separately
    expect(item.articles.map((a) => [a.publisher, a.muted])).toEqual([['Loud Blog', true], ['General', false]]); // still listed in expanded coverage, labelled
    expect(item.primary).toMatchObject({ publisher: 'General' }); expect(item.title).toBe('General headline on the contract deal'); // the headline shown is the unmuted publisher's
  });

  it('a story covered ONLY by muted publishers is hidden from feeds but found by search with its full count', () => {
    const a = src('Loud A'), b = src('Loud B'); const first = story(a, 'Muted pair story on the budget'); story(b, 'Another muted take on the budget', { cluster: first.cluster });
    mute('Loud A', 'Loud B');
    expect(ids('latest')).toEqual([]); expect(ids('foryou')).toEqual([]);
    const [found] = queryFeed(db, { tab: 'latest', q: 'budget' }).items; expect(found).toMatchObject({ id: first.cluster, sourceCount: 2, mutedSources: 0 }); // nothing unmuted to prefer: show the real coverage
  });

  it('only UNMUTED articles can make a story eligible: a muted general article does not rescue an unmatched interest-only one', () => {
    const loud = src('Loud Blog'), niche = src('Niche', { coverage: 'interest' });
    const first = story(loud, 'Shared event headline about the port'); story(niche, 'Niche take on the port', { cluster: first.cluster });
    expect(ids('latest')).toEqual([first.cluster]); // eligible through the (not yet muted) general feed
    mute('Loud Blog'); expect(ids('latest')).toEqual([]); // the remaining article is interest-only with no matching interest
  });
});

describe('changes apply immediately, without re-ingestion or Gemini', () => {
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

  it('REGRESSION: muting and unmuting through preferences re-filters existing stories on the next request', async () => {
    const loud = src('Loud Blog'), fine = src('General'); const m = story(loud, 'Muted story'), ok = story(fine, 'Good story');
    expect(await feedIds()).toEqual(asc(m.cluster, ok.cluster));
    const prefs = (await call('GET', '/api/prefs')).json().prefs;
    expect((await call('PUT', '/api/prefs', { ...prefs, mutedPublishers: ['Loud Blog'] })).statusCode).toBe(200);
    expect(await feedIds()).toEqual([ok.cluster]); expect(await feedIds('foryou')).toEqual([ok.cluster]); // effective at once
    expect((await call('PUT', '/api/prefs', { ...prefs, mutedPublishers: [] })).statusCode).toBe(200);
    expect(await feedIds()).toEqual(asc(m.cluster, ok.cluster)); // and reversible
    expect(attempts).toBe(0); expect(count('SELECT COUNT(*) n FROM articles')).toBe(2);
  });

  it('is separate from hard-blocked topics: neither system touches the other', async () => {
    const loud = src('Loud Blog'), fine = src('General'); const m = story(loud, 'Harbor repairs finish'), k = story(fine, 'Hockey: Kraken win in overtime'), ok = story(fine, 'Good story');
    const before = count('SELECT COUNT(*) n FROM article_blocks'); mute('Loud Blog');
    expect(count('SELECT COUNT(*) n FROM article_blocks')).toBe(before); expect(count('SELECT COUNT(*) n FROM blocked_topics')).toBe(0); // muting creates no topic block
    expect((await call('POST', '/api/blocked-topics', { name: 'Hockey', description: 'hockey, kraken' })).statusCode).toBe(201);
    expect(getPrefs(db).mutedPublishers).toEqual(['Loud Blog']); // blocking a topic does not change the mute list
    expect(await feedIds()).toEqual([ok.cluster]); expect(m.cluster + k.cluster).toBeGreaterThan(0); // both exclusions apply together
  });
});

describe('pagination and totals stay correct with muted publishers filtered out', () => {
  it('pages through only unmuted stories without gaps or duplicates, and totals exclude muted ones', () => {
    const loud = src('Loud Blog'), fine = src('General'); const all: { cluster: number; muted: boolean }[] = [];
    for (let i = 0; i < 12; i++) { const muted = i % 3 === 0; all.push({ cluster: story(muted ? loud : fine, `Story ${i}`, { importance: 0.99 - i * 0.02, ageMin: 10 + i }).cluster, muted }); }
    mute('Loud Blog'); const expected = all.filter((s) => !s.muted).map((s) => s.cluster);
    const walk = (tab: string) => { const seen: number[] = []; let cursor: string | undefined; let first: any; for (let g = 0; g < 10; g++) { const p = queryFeed(db, { tab, limit: 3, cursor }); first ??= p; seen.push(...p.items.map((i) => i.id)); cursor = p.nextCursor ?? undefined; if (!cursor) break; } return { seen, first }; };
    expect(walk('latest').seen).toEqual(expected);
    const fy = walk('foryou'); expect([...fy.seen].sort((a, b) => a - b)).toEqual(asc(...expected)); expect(fy.first.total).toBe(expected.length);
    expect(walk('unread').seen).toEqual(expected);
  });
});

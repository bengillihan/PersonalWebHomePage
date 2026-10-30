import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { memDb, testConfig } from './helpers.js';
import { recomputeCluster } from '../server/news/cluster.js';
import { queryFeed, queryFrontPage, FRONT } from '../server/news/query.js';
import { classify, SECTIONS } from '../server/news/sections.js';
import { DEFAULT_GEO, getPrefs, saveGeo, savePrefs } from '../server/settings.js';
import { setSetting } from '../server/db.js';
import { reindexBlocks } from '../server/news/blocking.js';
import { buildApp } from '../server/app.js';
import type { OidcClient } from '../server/auth.js';
import type { DB } from '../server/db.js';

let db: DB; let n = 0;
const src = (name: string, o: { local?: boolean } = {}) => Number(db.prepare('INSERT INTO sources (name, site_url, is_local, created_at) VALUES (?,?,?,0)').run(name, `https://${name.replace(/\W/g, '')}${++n}.example`, o.local ? 1 : 0).lastInsertRowid);
function story(source: number, title: string, o: { ai?: string | null; ageMin?: number; importance?: number; summary?: string } = {}) {
  n++; const at = Date.now() - (o.ageMin ?? 60) * 60_000;
  const a = Number(db.prepare(`INSERT INTO articles (source_id,url,canonical_url,canonical_hash,publisher,title,title_norm,excerpt,published_at,fetched_at,content_hash,availability,ai_category,importance,summary,summary_kind)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,'excerpt',?,?,?,?)`).run(source, `https://x.example/${n}`, `https://x.example/${n}`, `h${n}`, `Pub${source}`, title, title.toLowerCase(), o.summary ?? title, at, at, `c${n}`, o.ai ?? null, o.importance ?? 0.3, o.summary ?? null, o.summary ? 'excerpt' : null).lastInsertRowid);
  const c = Number(db.prepare('INSERT INTO story_clusters (primary_article_id,title,first_published_at,last_published_at,updated_at,created_at) VALUES (?,?,?,?,?,?)').run(a, title, at, at, at, at).lastInsertRowid);
  db.prepare('UPDATE articles SET cluster_id = ? WHERE id = ?').run(c, a); db.prepare('INSERT INTO cluster_articles VALUES (?,?,0,?)').run(c, a, at); db.prepare('INSERT INTO article_sources VALUES (?,?,?)').run(a, source, at);
  recomputeCluster(db, c); return c;
}
const markRead = (c: number) => db.prepare('INSERT INTO reading_state (cluster_id, read_at) VALUES (?,?) ON CONFLICT(cluster_id) DO UPDATE SET read_at = excluded.read_at').run(c, Date.now());
const ids = (tab: string, extra: Record<string, string> = {}) => queryFeed(db, { tab, limit: 50, ...extra }).items.map((i) => i.id);
const has = (title: string, category: string | null = null, summary: string | null = null, localSource = false) => classify({ title, category, summary, localSource }, DEFAULT_GEO).sections;
beforeEach(() => { db = memDb(); });

describe('classification: sections follow what a story is about', () => {
  it('Local, Regional and Washington are separate, and a story may qualify for several', () => {
    expect([...has('Des Moines council approves marina plan')]).toEqual(['local']);
    expect([...has('Seattle council approves transit levy')]).toEqual(['regional']);
    expect([...has('Olympia lawmakers debate new state tax')]).toEqual(['washington']);
    expect([...has('Federal Way schools to get state funding as Olympia passes budget')].sort()).toEqual(['local', 'washington']);
    expect([...has('Kent warehouse fire closes Highway 167 in King County')].sort()).toEqual(['local', 'regional']);
  });
  it('REGRESSION: the publisher\'s location does not decide the section (a local source\'s national story is not Local)', () => {
    const local = src('Hometown Gazette', { local: true }); const c = story(local, 'Senate passes federal budget bill', { ai: 'Politics' });
    expect(ids('local')).not.toContain(c); expect(ids('us')).toContain(c);
  });
  it('place names elsewhere do not count ("Des Moines, Iowa", "Kent State", "Des Moines Register")', () => {
    for (const t of ['Des Moines, Iowa school board votes', 'Kent State University names new coach', 'Des Moines Register endorses candidate', 'Kent, Ohio festival returns']) expect(has(t).has('local'), t).toBe(false);
    expect(has('Des Moines, WA marina reopens').has('local')).toBe(true);
  });
  it('uses the story\'s existing classification for topical sections, with no AI call', () => {
    expect(has('Chipmaker shares jump', 'Business').has('business')).toBe(true);
    expect(has('New open-source model released', 'Technology').has('technology')).toBe(true);
    expect(has('Mariners win in extras', 'Sports').has('sports')).toBe(true);
    expect(has('Elections held across the region', 'World').has('world')).toBe(true);
    expect(has('Election results in Paris', 'World', 'The White House said it was watching.').has('us')).toBe(false); // a world story that mentions Washington stays World
  });
  it('REGRESSION: Gemini only returns Local / Politics / Sports (never "U.S." or "Regional"), so the places in the text refine them', () => {
    expect([...has('Bellevue light rail extension opens', 'Local')]).toEqual(['regional']); // "Local" but a Seattle-area place: Regional, not Local
    expect([...has('Kent School District adopts new calendar', 'Local')]).toEqual(['local']);
    expect([...has('Library hours extended for summer', 'Local', null, true)]).toEqual(['local']); // no place named, but a local publisher: "Local" stands
    expect([...has('Des Moines, Iowa school board closes two schools', 'Local')]).toEqual([]); // Gemini says "Local" for any town: not enough on its own
    expect([...has('Library hours extended for summer', 'Local')]).toEqual([]);
    expect([...has('Seattle council approves transit levy', 'Politics')]).toEqual(['regional']); // local politics is not U.S. news
    expect([...has('Olympia lawmakers advance new tax bill', 'Politics')]).toEqual(['washington']);
    expect([...has('State Senate passes housing bill in Olympia', 'Politics')]).toEqual(['washington']); // a state Senate is not "the Senate"
    expect([...has('Senate passes federal budget deal', 'Politics')]).toEqual(['us']);
    expect([...has('Seattle delegation urges Congress to fund the airport', 'Politics')].sort()).toEqual(['regional', 'us']);
  });
  it('REGRESSION: sports and entertainment stay in their own sections even when they name a local place', () => {
    expect([...has('Seattle edges San Francisco in overtime', 'Sports')]).toEqual(['sports']);
    expect([...has('Des Moines theater festival returns', 'Entertainment')]).toEqual([]);
  });
  it('every section key is routable', () => { expect(SECTIONS).toEqual(['local', 'regional', 'washington', 'us', 'world', 'business', 'technology', 'sports']); });
});

describe('section feeds', () => {
  it('each section lists only its stories, newest relevance first, and a story can sit in several', () => {
    const s = src('General');
    const both = story(s, 'Federal Way schools get state funding as Olympia passes budget', { ageMin: 30 }), seattle = story(s, 'Seattle council approves transit levy', { ageMin: 20 });
    const biz = story(s, 'Chipmaker shares jump', { ai: 'Business', ageMin: 10 }), tech = story(s, 'New open-source model released', { ai: 'Technology', ageMin: 10 });
    expect(ids('local')).toEqual([both]); expect(ids('regional')).toEqual([seattle]); expect(ids('washington')).toEqual([both]);
    expect(ids('business')).toEqual([biz]); expect(ids('technology')).toEqual([tech]); expect(ids('world')).toEqual([]);
  });
  it('Des Moines and Federal Way stories outrank other Local stories, even older or less important ones', () => {
    const s = src('General');
    const kent = story(s, 'Kent council approves new park budget', { ageMin: 5, importance: 0.9 }), burien = story(s, 'Burien library hours extended', { ageMin: 5, importance: 0.9 });
    const dm = story(s, 'Des Moines marina plan draws crowd', { ageMin: 2000, importance: 0.3 }), fw = story(s, 'Federal Way light rail station opens', { ageMin: 2500, importance: 0.3 });
    const order = ids('local'); expect(order.slice(0, 2).sort()).toEqual([dm, fw].sort()); expect(order.slice(2).sort()).toEqual([kent, burien].sort());
  });
  it('geography is editable: changing the lists changes the sections immediately, with nothing re-fetched', () => {
    const s = src('General'); const c = story(s, 'Normandy Park bluff trail reopens');
    expect(ids('local')).toEqual([c]);
    saveGeo(db, { ...DEFAULT_GEO, local: DEFAULT_GEO.local.filter((x) => x !== 'Normandy Park'), regional: [...DEFAULT_GEO.regional, 'Normandy Park'] });
    expect(ids('local')).toEqual([]); expect(ids('regional')).toEqual([c]);
  });
  it('REGRESSION: blocked subjects (Hockey / NHL), muted publishers and read stories are excluded from every section, as in the other feeds', () => {
    const s = src('General'), loud = src('Loud Blog');
    const ok = story(s, 'Seahawks edge 49ers', { ai: 'Sports' }), mutedStory = story(loud, 'Mariners sign pitcher', { ai: 'Sports' }), read = story(s, 'Sounders draw at home', { ai: 'Sports' });
    const nhl = story(s, 'Kraken beat Canucks in NHL overtime', { ai: 'Sports' });
    reindexBlocks(db, Number(db.prepare('INSERT INTO blocked_topics (name, description, keywords, categories, enabled, created_at) VALUES (?,?,?,?,1,0)').run('Hockey / NHL', 'x', JSON.stringify(['hockey', 'nhl', 'canucks']), '[]').lastInsertRowid));
    markRead(read); savePrefs(db, { ...getPrefs(db), mutedPublishers: ['Pub' + loud] });
    expect(ids('sports')).toEqual([ok]); expect(ids('sports')).not.toContain(nhl);
    savePrefs(db, { ...getPrefs(db), mutedPublishers: [], showRead: true }); expect(ids('sports').sort()).toEqual([ok, mutedStory, read].sort()); expect(ids('sports')).not.toContain(nhl); // blocked stays blocked
  });
  it('pages through a section without repeating or skipping stories', () => {
    const s = src('General'); for (let i = 0; i < 7; i++) story(s, `Business story ${i}`, { ai: 'Business', ageMin: 10 + i });
    const first = queryFeed(db, { tab: 'business', limit: 3 }); const second = queryFeed(db, { tab: 'business', limit: 3, cursor: first.nextCursor! }); const third = queryFeed(db, { tab: 'business', limit: 3, cursor: second.nextCursor! });
    const all = [...first.items, ...second.items, ...third.items].map((i) => i.id); expect(all).toHaveLength(7); expect(new Set(all).size).toBe(7); expect(third.nextCursor).toBeNull();
  });
  it('search and Saved still reach stories regardless of section, and Saved keeps read ones', () => {
    const s = src('General'); const c = story(s, 'Chipmaker shares jump', { ai: 'Business' }); markRead(c); db.prepare('INSERT INTO bookmarks VALUES (?,1)').run(c);
    expect(ids('business')).toEqual([]); expect(ids('latest', { q: 'chipmaker' })).toEqual([c]); expect(ids('saved')).toEqual([c]);
    expect(ids('business', { q: 'chipmaker' })).toEqual([c]); // search ignores the section
  });
});

describe('Front Page', () => {
  it('REGRESSION: every story appears once, across the lead, the secondary stories and every section block', () => {
    const s = src('General');
    for (let i = 0; i < 12; i++) story(s, `Business story ${i}`, { ai: 'Business', importance: 0.5, ageMin: 10 + i });
    for (let i = 0; i < 8; i++) story(s, `Federal Way story ${i}`, { importance: 0.4, ageMin: 20 + i });
    story(s, 'Federal Way schools get state funding as Olympia passes budget', { importance: 0.9, ageMin: 5 });
    const fp = queryFrontPage(db); const all = [fp.lead!, ...fp.secondary, ...fp.sections.flatMap((b) => b.items)].map((x) => x.id);
    expect(fp.lead).not.toBeNull(); expect(new Set(all).size).toBe(all.length);
    expect(fp.secondary.length).toBeLessThanOrEqual(FRONT.secondary); for (const b of fp.sections) expect(b.items.length).toBeLessThanOrEqual(FRONT.perSection);
    expect(fp.sections.map((b) => b.key)).toEqual(expect.arrayContaining(['business', 'local']));
  });
  it('REGRESSION: stories that belong to no section (Health, Automotive, ...) still reach the Front Page, once', () => {
    const s = src('General'); const h = story(s, 'Hospitals report surge in respiratory illnesses', { ai: 'Health', importance: 0.2, ageMin: 900 });
    for (let i = 0; i < 10; i++) story(s, `Business story ${i}`, { ai: 'Business', importance: 0.6, ageMin: 10 + i });
    const fp = queryFrontPage(db); const all = [fp.lead!, ...fp.secondary, ...fp.sections.flatMap((b) => b.items)].map((x) => x.id);
    expect(all).toContain(h); expect(new Set(all).size).toBe(all.length); expect(fp.sections.find((b) => b.key === 'more')!.items.map((x) => x.id)).toEqual([h]);
  });
  it('the lead is the most relevant and important story, and empty sections are omitted', () => {
    const s = src('General'); const minor = story(s, 'Chipmaker shares jump', { ai: 'Business', importance: 0.3, ageMin: 300 }); const major = story(s, 'Kent flood closes schools', { importance: 0.95, ageMin: 20 });
    const fp = queryFrontPage(db); expect(fp.lead!.id).toBe(major); expect(fp.sections.map((b) => b.key)).not.toContain('sports'); expect([fp.lead!.id, ...fp.secondary.map((x) => x.id)]).toContain(minor);
  });
  it('REGRESSION: read, hidden, muted and blocked stories stay off the Front Page, and "Show read stories" brings read ones back', () => {
    const s = src('General'); const keep = story(s, 'Chipmaker shares jump', { ai: 'Business' }), read = story(s, 'Oil prices slip', { ai: 'Business' }), hidden = story(s, 'Bond yields rise', { ai: 'Business' });
    markRead(read); db.prepare('INSERT INTO reading_state (cluster_id, hidden_at) VALUES (?,?)').run(hidden, Date.now());
    const flat = () => { const f = queryFrontPage(db); return [f.lead, ...f.secondary, ...f.sections.flatMap((b) => b.items)].filter(Boolean).map((x) => x!.id).sort(); };
    expect(flat()).toEqual([keep]); savePrefs(db, { ...getPrefs(db), showRead: true }); expect(flat()).toEqual([keep, read].sort());
  });
  it('carries what the cards need: source attribution, link, read/saved state and the Updated flag', () => {
    const s = src('General'); const c = story(s, 'Chipmaker shares jump', { ai: 'Business' }); db.prepare('INSERT INTO bookmarks VALUES (?,1)').run(c);
    const lead = queryFrontPage(db).lead!; expect(lead).toMatchObject({ id: c, bookmarked: true, isRead: false, isUpdated: false, primary: { publisher: expect.any(String), url: expect.stringMatching(/^https:/) } });
  });
  it('an empty database gives an empty page, not an error', () => { expect(queryFrontPage(db)).toEqual({ lead: null, secondary: [], sections: [] }); });
});

describe('API', () => {
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

  it('serves the front page and section tabs, and requires sign-in', async () => {
    const s = src('General'); const c = story(s, 'Chipmaker shares jump', { ai: 'Business' });
    expect((await app.inject({ url: '/api/frontpage' })).statusCode).toBe(401);
    const fp = (await call('GET', '/api/frontpage')).json(); expect(fp.lead.id).toBe(c); expect(fp).toMatchObject({ hasAnyStories: true, showRead: false, status: expect.any(Object) });
    expect(((await call('GET', '/api/feed?tab=business')).json().items as any[]).map((i) => i.id)).toEqual([c]);
  });
  it('geography settings are readable, editable, validated, and resettable', async () => {
    const g = (await call('GET', '/api/geo')).json(); expect(g.geo.localPriority).toEqual(['Des Moines', 'Federal Way']); expect(g.defaults.local).toContain('Normandy Park');
    const next = { ...g.geo, local: ['Des Moines', ' Burien ', 'Burien'] };
    expect((await call('PUT', '/api/geo', next)).json().geo.local).toEqual(['Des Moines', 'Burien']);
    expect((await call('PUT', '/api/geo', { ...next, local: 'nope' })).statusCode).toBe(400);
    expect((await call('PUT', '/api/geo', g.defaults)).json().geo).toEqual(g.defaults);
  });
});

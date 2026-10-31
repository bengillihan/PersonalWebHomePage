import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { memDb, testConfig } from './helpers.js';
import { recomputeCluster } from '../server/news/cluster.js';
import { queryFeed, queryFrontPage, FRONT } from '../server/news/query.js';
import { classify, SECTIONS } from '../server/news/sections.js';
import { SEED_SOURCES } from '../server/seed.js';
import { DEFAULT_GEO, getFrontMix, getGeo, getPrefs, saveGeo, savePrefs } from '../server/settings.js';
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
  it('Local and Washington (which includes Greater Seattle) are separate, and a story may qualify for both', () => {
    expect([...has('Des Moines council approves marina plan')]).toEqual(['local']);
    expect([...has('Seattle council approves transit levy')]).toEqual(['washington']);
    expect([...has('Olympia lawmakers debate new state tax')].sort()).toEqual(['politics', 'washington']);
    expect([...has('Federal Way schools to get state funding as Olympia passes budget')].sort()).toEqual(['local', 'washington']);
    expect([...has('Kent warehouse fire closes Highway 167 in King County')].sort()).toEqual(['local', 'washington']);
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
  it('REGRESSION: Gemini only returns Local / Politics / Sports (never "U.S." or "Washington"), so the places in the text refine them', () => {
    expect([...has('Bellevue light rail extension opens', 'Local')]).toEqual(['washington']); // "Local" but a Seattle-area place: Washington, not Local
    expect([...has('Kent School District adopts new calendar', 'Local')]).toEqual(['local']);
    expect([...has('Library hours extended for summer', 'Local', null, true)]).toEqual(['local']); // no place named, but a local publisher: "Local" stands
    expect([...has('Des Moines, Iowa school board closes two schools', 'Local')]).toEqual([]); // Gemini says "Local" for any town: not enough on its own
    expect([...has('Library hours extended for summer', 'Local')]).toEqual([]);
    expect([...has('Seattle council approves transit levy', 'Politics')].sort()).toEqual(['politics', 'washington']); // local politics is not U.S. news
    expect([...has('Olympia lawmakers advance new tax bill', 'Politics')].sort()).toEqual(['politics', 'washington']);
    expect([...has('State Senate passes housing bill in Olympia', 'Politics')].sort()).toEqual(['politics', 'washington']); // a state Senate is not "the Senate"
    expect([...has('Senate passes federal budget deal', 'Politics')].sort()).toEqual(['politics', 'us']);
    expect([...has('Seattle delegation urges Congress to fund the airport', 'Politics')].sort()).toEqual(['politics', 'us', 'washington']);
  });
  it('REGRESSION: sports and entertainment stay in their own sections even when they name a local place', () => {
    expect([...has('Seattle edges San Francisco in overtime', 'Sports')]).toEqual(['sports']);
    expect([...has('Des Moines theater festival returns', 'Entertainment')]).toEqual([]);
  });
  it('every section key is routable', () => { expect(SECTIONS).toEqual(['local', 'washington', 'us', 'world', 'politics', 'business', 'technology', 'sports', 'outdoors', 'theology']); });
});

describe('Washington now includes the Greater Seattle area', () => {
  it('has one geography list; a list saved while Regional existed is folded into it once, keeping the user\'s edits', () => {
    expect(DEFAULT_GEO).not.toHaveProperty('regional'); expect(DEFAULT_GEO.washington).toEqual(expect.arrayContaining(['Seattle', 'Puget Sound', 'Olympia']));
    setSetting(db, 'geo', { local: ['Kent'], localPriority: ['Kent'], regional: ['Seattle', 'Fife'], washington: ['Olympia', 'Spokane'] });
    expect(getGeo(db)).toEqual({ local: ['Kent'], localPriority: ['Kent'], washington: ['Olympia', 'Spokane', 'Seattle', 'Fife'] });
    expect(JSON.parse((db.prepare("SELECT value FROM application_settings WHERE key = 'geo'").get() as any).value)).not.toHaveProperty('regional'); // rewritten once
    saveGeo(db, { ...getGeo(db), washington: ['Olympia'] }); expect(getGeo(db).washington).toEqual(['Olympia']); // a later edit sticks: nothing comes back
    const s = src('General'); const c = story(s, 'Fife school board votes on levy'); expect(ids('washington')).toEqual([]); saveGeo(db, { ...getGeo(db), washington: ['Fife'] }); expect(ids('washington')).toEqual([c]);
  });
  it('a saved Front Page Mix keeps its Washington weight and ignores the old Regional one', () => {
    setSetting(db, 'front_mix', { weights: { regional: 5, washington: 1, local: 3 }, majorException: true, majorThreshold: 0.8 });
    const m = getFrontMix(db); expect(m.weights).not.toHaveProperty('regional'); expect(m.weights).toMatchObject({ washington: 2, local: 6, theology: 4 }); // saved on the old 0-5 scale: doubled
  });
});

describe('Theology section', () => {
  it('takes religion and Christianity stories by category or headline, and leaves look-alikes alone', () => {
    expect(has('Council approves budget', 'Religion').has('theology')).toBe(true);
    for (const t of ['Pope Leo meets bishops at the Vatican', 'Pastor resigns after sermon controversy', 'Southern Baptist leaders vote on women pastors', 'What the Bible says about money', 'Evangelical colleges report enrollment shift', 'New Catholic church opens in Kent', 'Archbishop calls for prayer after floods', 'Christians gather for Easter Sunday worship'])
      expect(has(t, 'Other').has('theology') && has(t, null).has('theology'), t).toBe(true);
    for (const t of ['Kent church fire displaces families']) expect(has(t, 'Local').has('theology'), t).toBe(true); // a church story is Local and Theology
    for (const t of ['Mariners sign Christian Walker', 'Bishop scores twice in win', 'Church scores 22 in overtime']) expect(has(t, 'Sports').has('theology'), t).toBe(false);
    expect(has('Christian Bale joins new film', 'Entertainment').has('theology')).toBe(false);
    expect(has('Church & Dwight shares rise', 'Business').has('theology')).toBe(false);
    expect(has('Church Street garage lands funding', null).has('theology')).toBe(true); // weak word, no category: accepted rather than missed
    expect(has('Ministry of Finance cuts rates', 'World').has('theology')).toBe(false); expect(has('Christianity Today names editor', 'Business').has('theology')).toBe(true);
  });
  it('REGRESSION: government ministers and ordinary words are not religion; religious ministers still are', () => {
    for (const [t, c] of [['British prime minister meets French president for trade talks', 'World'], ['Finance minister announces budget cuts', 'World'], ['Foreign ministers meet in Geneva', null], ['Interior ministry confirms new rules', 'World'], ['Climate minister resigns', 'Politics'],
      ['The advent of generative AI reshapes newsrooms', 'Technology'], ['The advent of cheap solar changes the grid', null], ['Currency denominations to change next year', 'Business'], ['Bank adds new denominations of bills', null], ['Pope County sheriff seeks funding', 'Local'], ['Parish council in Louisiana approves drainage plan', 'Local']] as const)
      expect(has(t, c).has('theology'), t).toBe(false);
    for (const [t, c] of [['Youth minister arrested after church trip', 'Local'], ['Baptist minister elected moderator', null], ['Ordained minister joins school board', 'Local'], ['Associate minister named at Grace Church', 'Local'], ['Church denominations split over vote', 'World'], ['Pope Leo visits Seattle', 'World'], ['Parishioners rally to save the parish church', 'Local'], ['Advent season begins with candle service', 'Local']] as const)
      expect(has(t, c).has('theology'), t).toBe(true);
    expect([...has('British prime minister meets French president for trade talks', 'World')]).toEqual(['world']);
  });
  it('has its own section feed, Front Page block and Front Page Mix weight, and Gemini can file under Religion', () => {
    const s = src('General');
    const rel = story(s, 'Churches across Washington open doors for Easter Sunday', { ai: 'Religion' }), other = story(s, 'Seahawks edge 49ers', { ai: 'Sports' });
    expect(ids('theology')).toEqual([rel]); expect(ids('sports')).toEqual([other]);
    for (let i = 0; i < 7; i++) story(s, `Pastor ${i} reflects on a decade of sermons`, { ai: 'Religion', ageMin: 10 + i });
    const block = queryFrontPage(db).sections.find((x) => x.key === 'theology'); expect(block!.label).toBe('Theology'); expect(block!.items.length).toBeGreaterThan(0);
  });
  it('seeds Religion News Service, Christianity Today and The Gospel Coalition', () => {
    expect(SEED_SOURCES.filter((x) => x.categories.includes('Religion')).map((x) => x.name).sort()).toEqual(['Christianity Today', 'Religion News Service', 'The Gospel Coalition']);
  });
});

describe('Outdoors section', () => {
  it('takes hiking and outdoor-sports stories by category or headline, and leaves look-alikes alone', () => {
    expect(has('Trail closures announced', 'Outdoors').has('outdoors')).toBe(true);
    for (const t of ['Thru-hikers face early snow on the Pacific Crest Trail', 'Best backpacking tents for 2027', 'Climbers rescued from Mount Rainier', 'Kayakers paddle the Green River', 'National parks see record camping demand', 'Trail running shoes tested'])
      expect(has(t, 'Sports').has('outdoors') || has(t, 'Other').has('outdoors') || has(t, null).has('outdoors'), t).toBe(true);
    for (const t of ['Trail Blazers beat Suns', 'Paper trail leads to indictment', 'Cities consider climbing rents']) expect(has(t, null).has('outdoors'), t).toBe(false);
    expect(has('Camping World shares fall', 'Business').has('outdoors')).toBe(false);
    expect(has('Backpacking gear maker lands funding round', 'Technology').has('outdoors')).toBe(false);
    expect(has('Mariners win in extras', 'Sports').has('outdoors')).toBe(false);
  });
  it('has its own section feed, its own Front Page block and a Front Page Mix weight', () => {
    const s = src('General');
    const hike = story(s, 'Hikers return to the Enchantments after wildfire closure', { ai: 'Outdoors' }), score = story(s, 'Seahawks edge 49ers', { ai: 'Sports' });
    expect(ids('outdoors')).toEqual([hike]); expect(ids('sports')).toEqual([score]);
    for (let i = 0; i < 7; i++) story(s, `Backpackers tackle trail ${i} in the Cascades`, { ai: 'Outdoors', ageMin: 10 + i });
    const block = queryFrontPage(db).sections.find((x) => x.key === 'outdoors'); expect(block!.label).toBe('Outdoors'); expect(block!.items.length).toBeGreaterThan(0);
  });
  it('seeds The Trek, Outside and Backpacker as publisher feeds', () => {
    const names = (SEED_SOURCES.filter((x) => x.categories.includes('Outdoors')).map((x) => [x.name, x.feed])).sort();
    expect(names).toEqual([['Backpacker', 'https://www.backpacker.com/feed/'], ['Outside', 'https://www.outsideonline.com/feed/'], ['The Trek', 'https://thetrek.co/feed/']]);
  });
});

describe('section feeds', () => {
  it('each section lists only its stories, newest relevance first, and a story can sit in several', () => {
    const s = src('General');
    const both = story(s, 'Federal Way schools get state funding as Olympia passes budget', { ageMin: 30 }), seattle = story(s, 'Seattle council approves transit levy', { ageMin: 20 });
    const biz = story(s, 'Chipmaker shares jump', { ai: 'Business', ageMin: 10 }), tech = story(s, 'New open-source model released', { ai: 'Technology', ageMin: 10 });
    expect(ids('local')).toEqual([both]); expect(ids('washington').sort()).toEqual([both, seattle].sort());
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
    saveGeo(db, { ...DEFAULT_GEO, local: DEFAULT_GEO.local.filter((x) => x !== 'Normandy Park'), washington: [...DEFAULT_GEO.washington, 'Normandy Park'] });
    expect(ids('local')).toEqual([]); expect(ids('washington')).toEqual([c]);
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
    expect(fp.secondary.length).toBeLessThanOrEqual(FRONT.secondary); for (const b of fp.sections) expect(b.items.length).toBeLessThanOrEqual(Math.max(...FRONT.quota));
    expect(fp.sections.map((b) => b.key)).toEqual(expect.arrayContaining(['business', 'local']));
  });
  it('REGRESSION: stories that belong to no section (Health, Automotive, ...) still reach the Front Page, once', () => {
    const s = src('General'); const h = story(s, 'Hospitals report surge in respiratory illnesses', { ai: 'Health', importance: 0.2, ageMin: 900 });
    for (let i = 0; i < 10; i++) story(s, `Business story ${i}`, { ai: 'Business', importance: 0.6, ageMin: 10 + i });
    const fp = queryFrontPage(db); const all = [fp.lead!, ...fp.secondary, ...fp.sections.flatMap((b) => b.items)].map((x) => x.id);
    expect(all.filter((x) => x === h)).toHaveLength(1); expect(new Set(all).size).toBe(all.length); // on the page exactly once (as a secondary story or in "More stories")
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

  it('serves the front page and section tabs to the signed-in owner (visitors get the read-only view: see public-view.test.ts)', async () => {
    const s = src('General'); const c = story(s, 'Chipmaker shares jump', { ai: 'Business' });
    expect((await app.inject({ url: '/api/frontpage' })).json().lead.id).toBe(c); // a visitor sees the same stories, without the owner's state
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

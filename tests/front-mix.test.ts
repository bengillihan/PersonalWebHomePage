import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { memDb, testConfig } from './helpers.js';
import { recomputeCluster } from '../server/news/cluster.js';
import { queryFeed, queryFrontPage, FRONT, type FrontPage } from '../server/news/query.js';
import { classify, isPolitical } from '../server/news/sections.js';
import { DEFAULT_FRONT_MIX, DEFAULT_GEO, getFrontMix, getPrefs, saveFrontMix, savePrefs, type FrontMix } from '../server/settings.js';
import { reindexBlocks } from '../server/news/blocking.js';
import { setSetting } from '../server/db.js';
import { buildApp } from '../server/app.js';
import type { OidcClient } from '../server/auth.js';
import type { DB } from '../server/db.js';

let db: DB; let n = 0;
const src = (name: string) => Number(db.prepare('INSERT INTO sources (name, site_url, created_at) VALUES (?,?,0)').run(name, `https://${name.replace(/\W/g, '')}${++n}.example`).lastInsertRowid);
function story(source: number, title: string, o: { ai?: string | null; ageMin?: number; importance?: number } = {}) {
  n++; const at = Date.now() - (o.ageMin ?? 60) * 60_000;
  const a = Number(db.prepare(`INSERT INTO articles (source_id,url,canonical_url,canonical_hash,publisher,title,title_norm,excerpt,published_at,fetched_at,content_hash,availability,ai_category,importance)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,'excerpt',?,?)`).run(source, `https://x.example/${n}`, `https://x.example/${n}`, `h${n}`, `Pub${source}`, title, title.toLowerCase(), title, at, at, `c${n}`, o.ai ?? null, o.importance ?? 0.4).lastInsertRowid);
  const c = Number(db.prepare('INSERT INTO story_clusters (primary_article_id,title,first_published_at,last_published_at,updated_at,created_at) VALUES (?,?,?,?,?,?)').run(a, title, at, at, at, at).lastInsertRowid);
  db.prepare('UPDATE articles SET cluster_id = ? WHERE id = ?').run(c, a); db.prepare('INSERT INTO cluster_articles VALUES (?,?,0,?)').run(c, a, at); db.prepare('INSERT INTO article_sources VALUES (?,?,?)').run(a, source, at);
  recomputeCluster(db, c); return c;
}
const markRead = (c: number) => db.prepare('INSERT INTO reading_state (cluster_id, read_at) VALUES (?,?)').run(c, Date.now());
const mix = (over: Partial<FrontMix['weights']> = {}, rest: Partial<FrontMix> = {}) => saveFrontMix(db, { ...DEFAULT_FRONT_MIX, ...rest, weights: { ...DEFAULT_FRONT_MIX.weights, ...over } });
const all = (fp: FrontPage) => [fp.lead, ...fp.secondary, ...fp.sections.flatMap((b) => b.items)].filter(Boolean).map((x) => x!.id);
const where = (fp: FrontPage, id: number) => fp.lead?.id === id ? 'lead' : fp.secondary.some((x) => x.id === id) ? 'secondary' : fp.sections.find((b) => b.items.some((x) => x.id === id))?.key ?? null;
const ids = (tab: string, extra: Record<string, string> = {}) => queryFeed(db, { tab, limit: 50, ...extra }).items.map((i) => i.id);
const sec = (t: string, c: string | null = null, summary: string | null = null) => [...classify({ title: t, category: c, summary }, DEFAULT_GEO).sections].sort();
beforeEach(() => { db = memDb(); });

describe('Politics classification', () => {
  it('Gemini\'s Politics always counts; political EVENTS in the headline count when the category does not rule it out', () => {
    expect(sec('Senate passes federal budget deal', 'Politics')).toEqual(expect.arrayContaining(['politics', 'us']));
    for (const t of ['Voters head to the polls as the governor’s race tightens', 'Candidates clash in final debate before the primary', 'Lawmakers advance new election security law', 'House Republicans vote to cut agency budget', 'Governor signs transit funding bill in Olympia', 'President signs executive order on tariffs']) expect(isPolitical(t, null), t).toBe(true);
    expect(isPolitical('Brazil election results tighten', 'World')).toBe(true);
  });
  it('REGRESSION: a name alone is not politics; the main event decides', () => {
    for (const [t, c] of [['Senator throws out the first pitch at Mariners opener', 'Sports'], ['Former governor opens a craft brewery in Tacoma', null], ['Council to pay $2 million water bill', 'Local'], ['Bill Gates backs new battery startup', 'Technology'], ['Mayor cuts ribbon on new library', 'Local'], ['Tariffs squeeze automaker profits as earnings fall', 'Business'], ['Candidate for Seattle Seahawks coach list narrows', 'Sports']] as const) expect(isPolitical(t, c), t).toBe(false);
  });
  it('REGRESSION: municipal government decisions stay Local (and may also be Politics only when Gemini says so)', () => {
    expect(sec('Des Moines council approves marina boardwalk repairs', 'Local', null)).toEqual(['local']);
    expect(sec('Federal Way voters to decide school levy this fall', 'Local')).toEqual(['local', 'politics']); // a ballot is a political event
    expect(sec('Federal Way council approves marina budget', 'Politics')).toEqual(expect.arrayContaining(['local', 'politics']));
  });
  it('a story can be Politics and geographic; the Politics tab and the feed agree', () => {
    const s = src('General'); const a = story(s, 'Olympia lawmakers advance new tax bill', { ai: 'Politics' }), b = story(s, 'Chipmaker shares jump', { ai: 'Business' });
    expect(ids('politics')).toEqual([a]); expect(ids('washington')).toEqual([a]); expect(ids('business')).toEqual([b]);
  });
  it('Politics respects blocked topics, muted publishers and read stories like every other tab', () => {
    const s = src('General'), loud = src('Loud'); const ok = story(s, 'Congress returns to a long to-do list', { ai: 'Politics' }), read = story(s, 'Election results tighten', { ai: 'Politics' });
    db.prepare('INSERT INTO blocked_topics (name, description, keywords, categories, enabled, created_at) VALUES (?,?,?,?,1,0)').run('Hockey', 'x', JSON.stringify(['hockey']), '[]');
    const nhl = story(s, 'Hockey fans rally behind a ballot measure for a new arena', { ai: 'Politics' });
    story(loud, 'Senate hearing on tariffs', { ai: 'Politics' }); // from a muted publisher
    reindexBlocks(db, Number((db.prepare('SELECT id FROM blocked_topics').get() as any).id)); // index the stored stories against the block
    markRead(read); savePrefs(db, { ...getPrefs(db), mutedPublishers: ['Pub' + loud] });
    expect(ids('politics')).toEqual([ok]); expect(ids('politics')).not.toContain(nhl);
  });
});

describe('Front Page Mix', () => {
  it('has the suggested defaults and keeps them when nothing is saved', () => {
    expect(getFrontMix(db)).toEqual({ weights: { local: 10, washington: 8, us: 8, world: 8, politics: 4, business: 10, technology: 10, sports: 4, outdoors: 6, theology: 4, other: 4 }, majorException: true, majorThreshold: 0.8 });
  });
  it('REGRESSION: weight 0 removes a category from the Front Page only; its section, Search and Saved still have it', () => {
    const s = src('General'); const sp = story(s, 'Seahawks edge 49ers in overtime', { ai: 'Sports' }), bz = story(s, 'Chipmaker shares jump', { ai: 'Business' });
    db.prepare('INSERT INTO bookmarks VALUES (?,1)').run(sp);
    expect(all(queryFrontPage(db))).toEqual(expect.arrayContaining([sp, bz]));
    mix({ sports: 0 }); const fp = queryFrontPage(db);
    expect(all(fp)).toEqual([bz]); expect(ids('sports')).toEqual([sp]); expect(ids('latest', { q: 'seahawks' })).toEqual([sp]); expect(ids('saved')).toEqual([sp]);
  });
  it('REGRESSION: a story in several categories is placed ONCE, under its main category, whatever the weights', () => {
    const s = src('General'); const c = story(s, 'Federal Way schools get state funding as Olympia passes budget', { ai: 'Politics' }); // local + washington + politics
    let fp = queryFrontPage(db); expect(all(fp).filter((x) => x === c)).toHaveLength(1);
    mix({ washington: 0, politics: 0 }); fp = queryFrontPage(db); expect(all(fp).filter((x) => x === c)).toHaveLength(1); // its main category is Local, which is on
    mix({ local: 0 }); expect(all(queryFrontPage(db))).not.toContain(c); // main category off: it does NOT move to Washington or Politics
    expect(ids('local')).toContain(c); expect(ids('washington')).toContain(c); expect(ids('politics')).toContain(c); // still in every one of its own sections
  });
  it('a placement never repeats a clustered story across lead, secondary and section blocks', () => {
    const s = src('General'); for (let i = 0; i < 14; i++) story(s, `Business story ${i}`, { ai: 'Business', importance: 0.6, ageMin: 10 + i });
    for (let i = 0; i < 6; i++) story(s, `Federal Way story ${i}`, { importance: 0.5, ageMin: 30 + i }); for (let i = 0; i < 6; i++) story(s, `Congress vote ${i}`, { ai: 'Politics', ageMin: 40 + i });
    const list = all(queryFrontPage(db)); expect(new Set(list).size).toBe(list.length);
  });
  it('REGRESSION: one high-volume category cannot take over the page', () => {
    const s = src('General'); for (let i = 0; i < 30; i++) story(s, `Chipmaker story ${i}`, { ai: 'Business', importance: 0.7, ageMin: 5 + i });
    for (let i = 0; i < 3; i++) story(s, `Kent school story ${i}`, { importance: 0.3, ageMin: 600 + i }); story(s, 'Mariners sign veteran starter', { ai: 'Sports', importance: 0.3, ageMin: 700 });
    const fp = queryFrontPage(db); const biz = fp.sections.find((b) => b.key === 'business')?.items.length ?? 0; const bizTop = [fp.lead, ...fp.secondary].filter((x) => x && /Chipmaker/.test(x.title)).length;
    expect(biz).toBeLessThanOrEqual(FRONT.quota[10]); expect(bizTop - 1).toBeLessThanOrEqual(FRONT.secondaryPerCategory); // the lead may be one; secondary stories are capped
    const titles = [fp.lead, ...fp.secondary, ...fp.sections.flatMap((b) => b.items)].map((x) => x!.title); expect(titles.some((t) => /Kent school/.test(t))).toBe(true); expect(titles.some((t) => /Mariners/.test(t))).toBe(true); // the quieter categories still appear
  });
  it('category priority counts alongside relevance: at equal relevance the heavier category leads', () => {
    const s = src('General'); const sp = story(s, 'Seahawks edge 49ers in overtime', { ai: 'Sports', importance: 0.5, ageMin: 30 }), bz = story(s, 'Chipmaker shares jump', { ai: 'Business', importance: 0.5, ageMin: 30 });
    expect(queryFrontPage(db).lead!.id).toBe(bz); mix({ business: 1, sports: 5 }); expect(queryFrontPage(db).lead!.id).toBe(sp);
  });
  it('REGRESSION: a major breaking story gets through a low weight; the exception never beats weight 0 or a blocked topic', () => {
    const s = src('General'); const big = story(s, 'Seahawks stun 49ers in Super Bowl overtime', { ai: 'Sports', importance: 0.95 }), minor = story(s, 'Mariners sign veteran starter', { ai: 'Sports', importance: 0.3 }); story(s, 'Chipmaker shares jump', { ai: 'Business', importance: 0.5 });
    mix({ sports: 1 }, { majorException: false }); expect(where(queryFrontPage(db), big)).not.toBe('lead'); // low weight, no exception
    mix({ sports: 1 }, { majorException: true }); expect(where(queryFrontPage(db), big)).toBe('lead'); // major: treated as at least weight 8
    expect(where(queryFrontPage(db), minor)).not.toBeNull(); // minor story keeps its low weight
    mix({ sports: 0 }, { majorException: true }); expect(all(queryFrontPage(db))).not.toContain(big); // explicit 0 wins
    mix({ sports: 3 }, { majorException: true, majorThreshold: 1 }); expect(getFrontMix(db).majorThreshold).toBe(1);
    mix({ sports: 3 }); reindexBlocks(db, Number(db.prepare('INSERT INTO blocked_topics (name, description, keywords, categories, enabled, created_at) VALUES (?,?,?,?,1,0)').run('Super Bowl', 'x', JSON.stringify(['super bowl']), '[]').lastInsertRowid));
    expect(all(queryFrontPage(db))).not.toContain(big); // hard block wins
  });
  it('local political stories stay in Local on the Front Page, and Des Moines / Federal Way still lead the Local block', () => {
    const s = src('General'); const dm = story(s, 'Des Moines council approves marina boardwalk repairs', { ai: 'Local', importance: 0.3, ageMin: 3000 }), kent = story(s, 'Kent council approves new park budget', { ai: 'Local', importance: 0.5, ageMin: 5 });
    const fw = story(s, 'Federal Way voters to decide school levy', { ai: 'Politics', importance: 0.3, ageMin: 2500 });
    for (let i = 0; i < 8; i++) story(s, `Business story ${i}`, { ai: 'Business', importance: 0.8, ageMin: 5 + i });
    const fp = queryFrontPage(db); const local = fp.sections.find((b) => b.key === 'local')!; expect(local).toBeTruthy();
    expect(['lead', 'secondary', 'local']).toContain(where(fp, fw)); expect(fp.sections.find((b) => b.key === 'politics')?.items.map((x) => x.id) ?? []).not.toContain(fw); // local news first, never filed under Politics
    expect(ids('politics')).toContain(fw); // ...but still in the Politics section
    const order = local.items.map((x) => x.id); const idx = (id: number) => (order.includes(id) ? order.indexOf(id) : -1);
    if (idx(kent) >= 0) for (const p of [dm, fw]) if (idx(p) >= 0) expect(idx(p)).toBeLessThan(idx(kent)); // within the block, Des Moines and Federal Way come first
  });
  it('the existing filters still apply: read, hidden, muted publishers', () => {
    const s = src('General'), loud = src('Loud'); const keep = story(s, 'Chipmaker shares jump', { ai: 'Business' }), read = story(s, 'Oil prices slip', { ai: 'Business' }), hid = story(s, 'Bond yields rise', { ai: 'Business' }); story(loud, 'Stocks rally', { ai: 'Business' });
    markRead(read); db.prepare('INSERT INTO reading_state (cluster_id, hidden_at) VALUES (?,?)').run(hid, Date.now()); savePrefs(db, { ...getPrefs(db), mutedPublishers: ['Pub' + loud] });
    expect(all(queryFrontPage(db)).sort()).toEqual([keep]);
  });
  it('is recomputed from cached rows with every change: saving a mix changes the next Front Page, with no model involved', () => {
    const s = src('General'); const sp = story(s, 'Seahawks edge 49ers', { ai: 'Sports' }); expect(all(queryFrontPage(db))).toContain(sp); mix({ sports: 0 }); expect(all(queryFrontPage(db))).not.toContain(sp); mix(); expect(all(queryFrontPage(db))).toContain(sp);
  });
  it('invalid stored values fall back to the defaults instead of breaking the page', () => {
    setSetting(db, 'front_mix', { scale: 10, weights: { local: 11, sports: 'x', business: 0, us: 7 }, majorThreshold: 3 }); const m = getFrontMix(db);
    expect(m.weights.local).toBe(10); expect(m.weights.sports).toBe(4); expect(m.weights.us).toBe(7); expect(m.weights.business).toBe(0); expect(m.majorThreshold).toBe(0.8);
  });
});

describe('REGRESSION: a weight of 0 never makes another story, or the same story, more prominent', () => {
  const congress = (s: number) => story(s, 'Congress returns to a long to-do list as holiday deadline looms', { ai: 'Politics', importance: 0.6, ageMin: 30 });
  const fill = (s: number) => { for (let i = 0; i < 4; i++) story(s, `Chipmaker story ${i}`, { ai: 'Business', importance: 0.7, ageMin: 10 + i }); story(s, 'Seahawks edge 49ers', { ai: 'Sports', importance: 0.5 }); };
  it('Politics 2 -> 0: a Congress story leaves the Front Page; it is not promoted through its higher U.S. weight', () => {
    const s = src('General'); const c = congress(s); fill(s);
    mix({ politics: 2, us: 4 }); expect(where(queryFrontPage(db), c)).not.toBeNull(); // on the page at weight 2 (secondary or its Politics block)
    mix({ politics: 0, us: 4 }); const fp = queryFrontPage(db); expect(where(fp, c)).toBeNull(); expect(all(fp)).not.toContain(c);
    expect(ids('us')).toContain(c); expect(ids('politics')).toContain(c); // dedicated sections are unaffected
    db.prepare('INSERT INTO bookmarks VALUES (?,1)').run(c); expect(ids('saved')).toEqual([c]); expect(ids('latest', { q: 'congress' })).toEqual([c]);
  });
  it('raising or lowering Politics only moves political stories, in the expected direction', () => {
    const s = src('General'); const c = congress(s); fill(s); const rank = (w: number) => { mix({ politics: w }); const fp = queryFrontPage(db); return fp.lead?.id === c ? 0 : fp.secondary.findIndex((x) => x.id === c) + 1 || (where(fp, c) ? 99 : 100); };
    expect(rank(5)).toBeLessThanOrEqual(rank(2)); expect(rank(2)).toBeLessThanOrEqual(rank(1)); expect(rank(1)).toBeLessThanOrEqual(rank(0)); expect(rank(0)).toBe(100);
  });
  it('an election story that is also World or U.S. stays off the page while Politics is 0', () => {
    const s = src('General'); const e = story(s, 'Election results in Brazil tighten as final ballots are counted', { ai: 'World', importance: 0.7 }); fill(s);
    expect([...classify({ title: 'Election results in Brazil tighten as final ballots are counted', category: 'World', summary: null }, DEFAULT_GEO).sections].sort()).toEqual(['politics', 'world']);
    mix({ politics: 0, world: 5 }); expect(all(queryFrontPage(db))).not.toContain(e); expect(ids('world')).toContain(e);
  });
  it('REGRESSION: business, technology and infrastructure stories that merely mention government stay on the page when Politics is 0', () => {
    const s = src('General'); mix({ politics: 0 });
    const tariff = story(s, 'Tariffs squeeze automaker profits as Senate weighs new rules', { ai: 'Business', importance: 0.7 });
    const ai = story(s, 'Lawmakers question chipmaker over AI export licences', { ai: 'Technology', importance: 0.7 });
    const bridge = story(s, 'Kent bridge repairs delayed as council reviews state grant', { ai: 'Local', importance: 0.6 });
    const fp = queryFrontPage(db); expect(all(fp)).toEqual(expect.arrayContaining([tariff, ai, bridge]));
    expect(classify({ title: 'Tariffs squeeze automaker profits as Senate weighs new rules', category: 'Business', summary: null }, DEFAULT_GEO).sections.has('politics')).toBe(false);
  });
  it('local municipal decisions stay Local (and on the page) with Politics at 0', () => {
    const s = src('General'); const dm = story(s, 'Des Moines council approves marina boardwalk repairs', { ai: 'Local', importance: 0.5 }); mix({ politics: 0 });
    expect(all(queryFrontPage(db))).toContain(dm); expect(ids('local')).toContain(dm);
  });
  it('the major-story exception never overrides an explicit 0, even when the story also fits a heavier category', () => {
    const s = src('General'); const big = story(s, 'Senate passes sweeping federal budget deal hours before shutdown deadline', { ai: 'Politics', importance: 0.97 }); fill(s);
    mix({ politics: 0, us: 5 }, { majorException: true }); expect(all(queryFrontPage(db))).not.toContain(big);
    mix({ politics: 1, us: 5 }, { majorException: true }); expect(where(queryFrontPage(db), big)).toBe('lead'); // exception lifts a LOW weight
  });
});

describe('Front Page Mix 0-10 scale', () => {
  it('a mix saved on the old 0-5 sliders keeps its meaning (doubled, 0 still off), and once saved again is read as 0-10', () => {
    setSetting(db, 'front_mix', { weights: { local: 5, business: 3, sports: 0, us: 1 }, majorException: false, majorThreshold: 0.9 });
    expect(getFrontMix(db).weights).toMatchObject({ local: 10, business: 6, sports: 0, us: 2, world: 8 }); expect(getFrontMix(db).majorException).toBe(false);
    saveFrontMix(db, getFrontMix(db)); expect(getFrontMix(db).weights).toMatchObject({ local: 10, business: 6, sports: 0, us: 2 }); // not doubled again
    expect(JSON.parse((db.prepare("SELECT value FROM application_settings WHERE key = 'front_mix'").get() as any).value).scale).toBe(10);
  });
  it('every step from 1 to 10 is accepted and changes the ranking: a higher weight never ranks a category lower', () => {
    const s = src('General'); const sp = story(s, 'Seahawks edge 49ers in overtime', { ai: 'Sports', importance: 0.5, ageMin: 30 }); for (let i = 0; i < 4; i++) story(s, `Chipmaker story ${i}`, { ai: 'Business', importance: 0.5, ageMin: 30 + i });
    const rank = (w: number) => { mix({ sports: w }); const fp = queryFrontPage(db); return fp.lead?.id === sp ? 0 : (fp.secondary.findIndex((x) => x.id === sp) + 1) || 99; };
    const ranks = Array.from({ length: 10 }, (_, i) => rank(i + 1)); for (let i = 1; i < ranks.length; i++) expect(ranks[i]).toBeLessThanOrEqual(ranks[i - 1]);
    for (let w = 1; w <= 10; w++) { mix({ sports: w }); expect(getFrontMix(db).weights.sports).toBe(w); }
  });
});

describe('Front Page Mix API', () => {
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
  it('reads, saves (in SQLite), validates and resets the mix', async () => {
    expect((await app.inject({ url: '/api/front-mix' })).statusCode).toBe(401);
    const g = (await call('GET', '/api/front-mix')).json(); expect(g.mix).toEqual(DEFAULT_FRONT_MIX); expect(g.defaults).toEqual(DEFAULT_FRONT_MIX);
    const next = { ...g.mix, weights: { ...g.mix.weights, politics: 0, sports: 9 }, majorThreshold: 0.9 };
    expect((await call('PUT', '/api/front-mix', next)).json().mix.weights).toMatchObject({ politics: 0, sports: 9 });
    expect(JSON.parse((db.prepare("SELECT value FROM application_settings WHERE key = 'front_mix'").get() as any).value).weights.politics).toBe(0); // follows the account, stored server-side
    for (const bad of [{ ...next, weights: { ...next.weights, local: 11 } }, { ...next, weights: { ...next.weights, local: 2.5 } }, { ...next, weights: { ...next.weights, local: -1 } }, { ...next, majorThreshold: 0.2 }, { ...next, weights: { local: 1 } }]) expect((await call('PUT', '/api/front-mix', bad)).statusCode).toBe(400);
    expect((await call('PUT', '/api/front-mix', g.defaults)).json().mix).toEqual(DEFAULT_FRONT_MIX);
  });
  it('the front page endpoint uses the saved mix and makes no Gemini request', async () => {
    const s = src('General'); const sp = story(s, 'Seahawks edge 49ers', { ai: 'Sports' }); const bz = story(s, 'Chipmaker shares jump', { ai: 'Business' });
    await call('PUT', '/api/front-mix', { ...DEFAULT_FRONT_MIX, weights: { ...DEFAULT_FRONT_MIX.weights, sports: 0 } });
    const fp = (await call('GET', '/api/frontpage')).json(); const got = [fp.lead, ...fp.secondary, ...fp.sections.flatMap((b: any) => b.items)].filter(Boolean).map((x: any) => x.id); expect(got).toEqual([bz]); expect(got).not.toContain(sp);
    expect(db.prepare("SELECT COUNT(*) n FROM ai_usage").get()).toEqual({ n: 0 });
  });
});

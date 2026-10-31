import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { memDb, testConfig } from './helpers.js';
import { buildApp } from '../server/app.js';
import { recomputeCluster } from '../server/news/cluster.js';
import { getPrefs, savePrefs } from '../server/settings.js';
import { PUBLIC_READ_ROUTES, type OidcClient } from '../server/auth.js';
import type { Refresher } from '../server/news/ingest.js';
import type { DB } from '../server/db.js';

let db: DB; let app: FastifyInstance; let refresher: Refresher; let n = 0; let cookie = ''; let csrf = '';
const oidc: OidcClient & { nonce?: string } = { authUrl: ({ state, nonce }) => `https://x/?state=${state}&nonce=${nonce}`, async exchange() { return { sub: 's', email: 'me@example.com', emailVerified: true, name: 'Me', nonce: oidc.nonce ?? null }; } };
const src = (name: string) => Number(db.prepare('INSERT INTO sources (name, site_url, created_at) VALUES (?,?,0)').run(name, `https://${name}${++n}.example`).lastInsertRowid);
function story(source: number, title: string, o: { ai?: string; ageMin?: number } = {}) {
  n++; const at = Date.now() - (o.ageMin ?? 60) * 60_000;
  const a = Number(db.prepare(`INSERT INTO articles (source_id,url,canonical_url,canonical_hash,publisher,title,title_norm,excerpt,published_at,fetched_at,content_hash,availability,ai_category,importance) VALUES (?,?,?,?,?,?,?,?,?,?,?,'excerpt',?,0.5)`)
    .run(source, `https://x.example/${n}`, `https://x.example/${n}`, `h${n}`, `Pub${source}`, title, title.toLowerCase(), title, at, at, `c${n}`, o.ai ?? null).lastInsertRowid);
  const c = Number(db.prepare('INSERT INTO story_clusters (primary_article_id,title,first_published_at,last_published_at,updated_at,created_at) VALUES (?,?,?,?,?,?)').run(a, title, at, at, at, at).lastInsertRowid);
  db.prepare('UPDATE articles SET cluster_id = ? WHERE id = ?').run(c, a); db.prepare('INSERT INTO cluster_articles VALUES (?,?,0,?)').run(c, a, at); db.prepare('INSERT INTO article_sources VALUES (?,?,?)').run(a, source, at);
  recomputeCluster(db, c); return c;
}
const anon = (url: string, method: any = 'GET', payload?: unknown) => app.inject({ method, url, payload: payload as any });
const owner = (url: string, method: any = 'GET', payload?: unknown) => app.inject({ method, url, cookies: { sid: cookie }, headers: { 'x-csrf-token': csrf }, payload: payload as any });
const ids = (r: { json(): any }) => (r.json().items as { id: number }[]).map((i) => i.id).sort();

beforeEach(async () => {
  db = memDb(); n = 0;
  ({ app, refresher } = await buildApp(testConfig(), db, { oidc, logger: false, transport: null }));
  const r1 = await app.inject({ url: '/auth/login' }); const loc = new URL(r1.headers.location as string); oidc.nonce = loc.searchParams.get('nonce')!;
  const r2 = await app.inject({ url: `/auth/callback?code=c&state=${loc.searchParams.get('state')}`, cookies: { oauth_tx: r1.cookies[0].value } });
  cookie = r2.cookies.find((c) => c.name === 'sid')!.value; csrf = (await app.inject({ url: '/api/me', cookies: { sid: cookie } })).json().csrfToken;
});
afterEach(async () => { await app.close(); });

describe('read-only view for visitors who are not signed in', () => {
  it('may read the news pages and the weather, as an anonymous identity with no token and no email', async () => {
    const s = src('General'); const c = story(s, 'Chipmaker shares jump', { ai: 'Business' });
    expect((await anon('/api/me')).json()).toEqual({ anonymous: true, email: null, name: null, csrfToken: null, theme: 'system' });
    expect((await owner('/api/me')).json()).toMatchObject({ anonymous: false, email: 'me@example.com', csrfToken: csrf });
    for (const u of ['/api/status', '/api/feed?tab=latest', '/api/feed?tab=business', '/api/feed?tab=foryou', '/api/feed?q=chipmaker', '/api/frontpage']) expect((await anon(u)).statusCode, u).toBe(200);
    expect(ids(await anon('/api/feed?tab=latest'))).toEqual([c]); expect((await anon('/api/frontpage')).json().lead.id).toBe(c);
    expect((await anon('/api/feed?tab=latest')).headers['cache-control']).toBe('private, no-store');
  });

  it('cannot reach anything else: settings, sources, interests, markets, saved data, diagnostics, backups or any write', async () => {
    const s = src('General'); const c = story(s, 'Chipmaker shares jump');
    const reads = ['/api/sources', '/api/topics', '/api/prefs', '/api/front-mix', '/api/geo', '/api/blocked-topics', '/api/market', '/api/market/series?symbol=SPX', '/api/watchlist', '/api/watchlist/search?q=spx', '/api/diagnostics', '/api/backup', '/api/export', `/api/stories/${c}/why`, `/api/stories/${c}/block-suggestion`, '/api/weather/search?q=seattle', '/api/nonexistent', '/auth/dev'];
    for (const u of reads.filter((x) => x !== '/auth/dev')) expect((await anon(u)).statusCode, `GET ${u}`).toBe(401);
    const writes: [string, string, unknown?][] = [['POST', `/api/stories/${c}/read`, { read: true }], ['POST', `/api/stories/${c}/hide`, {}], ['POST', `/api/stories/${c}/bookmark`, { on: true }], ['POST', `/api/stories/${c}/feedback`, { rating: 1 }], ['POST', `/api/stories/${c}/ungroup`, {}], ['POST', '/api/clusters/merge', { ids: [1, 2] }],
      ['POST', '/api/refresh'], ['POST', '/api/sources', { url: 'example.com' }], ['POST', '/api/sources/discover', { url: 'example.com' }], ['PATCH', '/api/sources/1', { enabled: false }], ['DELETE', '/api/sources/1'], ['POST', '/api/topics', { name: 'x' }], ['PUT', '/api/prefs', {}], ['PUT', '/api/theme', { theme: 'dark' }], ['PUT', '/api/front-mix', {}], ['PUT', '/api/geo', {}],
      ['PUT', '/api/ai/budget', { budget: 1 }], ['PUT', '/api/weather/location', { zip: '98198' }], ['POST', '/api/watchlist', { symbol: 'X' }], ['POST', '/api/blocked-topics', {}], ['DELETE', '/api/blocked-topics/1']];
    for (const [m, u, b] of writes) expect((await anon(u, m, b)).statusCode, `${m} ${u}`).toBe(401);
    for (const [m, u] of [['POST', '/api/feed'], ['PUT', '/api/feed'], ['DELETE', '/api/feed'], ['POST', '/api/frontpage'], ['POST', '/api/weather'], ['POST', '/api/me']] as const) expect((await anon(u, m, {})).statusCode, `${m} ${u}`).toBe(401); // the public routes are GET/HEAD only
    expect((await app.inject({ method: 'POST', url: `/api/stories/${c}/read`, payload: { read: true }, headers: { 'x-csrf-token': csrf } })).statusCode).toBe(401); // a CSRF token without the session is nothing
    expect((await app.inject({ method: 'POST', url: `/api/stories/${c}/read`, payload: { read: true }, cookies: { sid: 'forged' } })).statusCode).toBe(401);
    const state = () => JSON.stringify([db.prepare('SELECT * FROM reading_state').all(), db.prepare('SELECT * FROM bookmarks').all(), db.prepare('SELECT * FROM feedback').all(), db.prepare('SELECT COUNT(*) FROM sources').get(), db.prepare('SELECT * FROM application_settings').all()]);
    const before = state(); for (const [m, u, b] of writes) await anon(u, m, b); expect(state()).toBe(before); // nothing changed
    expect(PUBLIC_READ_ROUTES.size).toBe(5); // adding a public route is a deliberate act
  });

  it('shows none of the owner\'s private state, and the owner reading a story never hides it from visitors', async () => {
    const s = src('General'); const keep = story(s, 'Chipmaker shares jump', { ai: 'Business' }), read = story(s, 'Mariners sign pitcher', { ai: 'Sports' }), saved = story(s, 'Council approves levy', { ai: 'Local' }), liked = story(s, 'New open-source model released', { ai: 'Technology' });
    await owner(`/api/stories/${read}/read`, 'POST', { read: true }); await owner(`/api/stories/${saved}/bookmark`, 'POST', { on: true }); await owner(`/api/stories/${liked}/feedback`, 'POST', { rating: 1 });
    const mine = (await owner('/api/feed?tab=latest')).json(); expect(mine.items.map((i: any) => i.id)).not.toContain(read); // the owner's own view hides the story they read
    expect(mine.items.find((i: any) => i.id === saved)).toMatchObject({ bookmarked: true }); expect(mine.items.find((i: any) => i.id === liked)).toMatchObject({ rating: 1 });
    const vis = (await anon('/api/feed?tab=latest')).json();
    expect(vis.items.map((i: any) => i.id).sort()).toEqual([keep, read, saved, liked].sort()); expect(vis.showRead).toBe(true);
    for (const it of vis.items) expect(it).toMatchObject({ isRead: false, isUpdated: false, bookmarked: false, rating: 0, blockedBy: [] }); for (const it of vis.items) expect(it).not.toHaveProperty('why');
    const fp = (await anon('/api/frontpage')).json(); const all = [fp.lead, ...fp.secondary, ...fp.sections.flatMap((x: any) => x.items)].filter(Boolean);
    expect(all.map((i: any) => i.id)).toContain(read); for (const it of all) expect(it).toMatchObject({ isRead: false, bookmarked: false, rating: 0 });
    expect(JSON.stringify(vis)).not.toMatch(/me@example\.com|csrf/i);
    const sec = (await anon('/api/feed?tab=sports')).json(); expect(sec.items.map((i: any) => i.id)).toEqual([read]); // a section too
  });

  it('has no Saved or Unread of its own, and a visitor cannot get the owner\'s by asking', async () => {
    const s = src('General'); const c = story(s, 'Council approves levy'); const d = story(s, 'Chipmaker shares jump');
    await owner(`/api/stories/${c}/bookmark`, 'POST', { on: true }); await owner(`/api/stories/${d}/read`, 'POST', { read: true });
    for (const tab of ['saved', 'unread']) { expect((await anon(`/api/feed?tab=${tab}`)).json()).toMatchObject({ items: [], nextCursor: null }); expect(ids(await owner(`/api/feed?tab=${tab}`))).not.toEqual([]); }
    expect((await anon('/api/feed?tab=saved&q=council')).json().items).toEqual([]);
  });

  it('does not reveal muted publishers or blocked topics, and does not apply them to what visitors see of muting', async () => {
    const loud = src('Loud'); const a = story(loud, 'Mariners sign pitcher', { ai: 'Sports' });
    savePrefs(db, { ...getPrefs(db), mutedPublishers: ['Pub' + loud] });
    expect(ids(await owner('/api/feed?tab=latest'))).toEqual([]); // muted for the owner
    const vis = (await anon('/api/feed?tab=latest')).json(); expect(ids({ json: () => vis })).toEqual([a]); expect(vis.items[0]).toMatchObject({ mutedSources: 0 }); expect(vis.items[0].articles[0].muted).toBe(false);
    expect(JSON.stringify(vis)).not.toMatch(/blockedBy":\["/);
  });

  it('never starts a refresh: only the signed-in owner\'s visit can', async () => {
    const s = src('General'); story(s, 'Chipmaker shares jump'); const jobs = () => (db.prepare('SELECT COUNT(*) n FROM processing_jobs').get() as any).n;
    let started = 0; const orig = refresher.trigger.bind(refresher); refresher.trigger = ((r: any) => { started++; return orig(r); }) as any;
    expect(refresher.isStale()).toBe(true);
    for (const u of ['/api/feed?tab=latest', '/api/feed?tab=foryou', '/api/frontpage', '/api/status', '/api/weather']) await anon(u);
    await new Promise((r) => setTimeout(r, 50)); expect(started).toBe(0); expect(jobs()).toBe(0);
    await owner('/api/feed?tab=latest'); await new Promise((r) => setTimeout(r, 50)); expect(started).toBe(1); // the owner's visit still refreshes a stale feed
  });

  it('shows the weather place by name only', async () => {
    const mine = await owner('/api/weather'); const vis = await anon('/api/weather');
    if (mine.statusCode === 200) { expect(mine.json().location.lat).toEqual(expect.any(Number)); expect(vis.statusCode).toBe(200); expect(vis.json().location).toEqual({ label: mine.json().location.label, lat: null, lon: null, zip: null }); }
    expect(vis.statusCode).toBe(200);
  });

  it('limits visitors harder than the owner', async () => {
    const s = src('General'); story(s, 'Chipmaker shares jump');
    let limited = 0; for (let i = 0; i < 70; i++) if ((await anon('/api/feed?tab=latest')).statusCode === 429) limited++; expect(limited).toBeGreaterThan(0);
    for (let i = 0; i < 70; i++) expect((await owner('/api/feed?tab=latest')).statusCode).toBe(200);
  });
});

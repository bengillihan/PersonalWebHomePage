import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { memDb, testConfig, rss, hoursAgo } from './helpers.js';
import { buildApp } from '../server/app.js';
import { seedDefaults } from '../server/seed.js';
import type { OidcClient, OidcIdentity } from '../server/auth.js';

let app: FastifyInstance; let db: ReturnType<typeof memDb>;
let identity: Partial<OidcIdentity>;

const oidc: OidcClient = {
  authUrl: ({ state, nonce }) => `https://accounts.example/auth?state=${state}&nonce=${nonce}`,
  async exchange() { return { sub: 'sub1', email: 'me@example.com', emailVerified: true, name: 'Me', nonce: (oidc as any).nonce, ...identity }; },
};

beforeEach(async () => {
  db = memDb(); seedDefaults(db); identity = {};
  ({ app } = await buildApp(testConfig(), db, { oidc, logger: false, transport: null }));
});
afterEach(async () => { await app.close(); });

async function login(): Promise<{ cookie: string; csrf: string }> {
  const r1 = await app.inject({ method: 'GET', url: '/auth/login' });
  expect(r1.statusCode).toBe(302);
  const loc = new URL(r1.headers.location as string);
  (oidc as any).nonce = loc.searchParams.get('nonce');
  const tx = r1.cookies.find((c) => c.name === 'oauth_tx')!;
  const r2 = await app.inject({ method: 'GET', url: `/auth/callback?code=abc&state=${loc.searchParams.get('state')}`, cookies: { oauth_tx: tx.value } });
  if (r2.statusCode !== 302) return { cookie: '', csrf: '' };
  const sid = r2.cookies.find((c) => c.name === 'sid')!;
  const me = await app.inject({ method: 'GET', url: '/api/me', cookies: { sid: sid.value } });
  return { cookie: sid.value, csrf: me.json().csrfToken };
}

describe('authentication & session security', () => {
  it('blocks every private API route when unauthenticated', async () => {
    for (const [m, u] of [['GET', '/api/feed'], ['GET', '/api/sources'], ['GET', '/api/market'], ['GET', '/api/diagnostics'], ['GET', '/api/export'], ['POST', '/api/refresh'], ['POST', '/api/sources/discover'], ['DELETE', '/api/sources/1'], ['GET', '/api/nonexistent']] as const) {
      const r = await app.inject({ method: m, url: u });
      expect(r.statusCode, `${m} ${u}`).toBe(401);
    }
    expect((await app.inject({ url: '/health' })).statusCode).toBe(200);
  });
  it('login redirects to Google and sets a signed, HttpOnly, short-lived tx cookie', async () => {
    const r = await app.inject({ url: '/auth/login' });
    const c = r.cookies.find((x) => x.name === 'oauth_tx')!;
    expect(c.httpOnly).toBe(true); expect(c.sameSite).toBe('Lax'); expect(c.maxAge).toBe(600); expect(c.value).toContain('.'); // signed
  });
  it('completes login for the allowlisted account; session cookie is HttpOnly/SameSite', async () => {
    const r1 = await app.inject({ url: '/auth/login' }); const loc = new URL(r1.headers.location as string);
    (oidc as any).nonce = loc.searchParams.get('nonce');
    const r2 = await app.inject({ url: `/auth/callback?code=c&state=${loc.searchParams.get('state')}`, cookies: { oauth_tx: r1.cookies[0].value } });
    expect(r2.statusCode).toBe(302);
    const sid = r2.cookies.find((c) => c.name === 'sid')!;
    expect(sid.httpOnly).toBe(true); expect(sid.sameSite).toBe('Lax'); expect(sid.value.length).toBeGreaterThan(30);
    // token itself is not stored: only an HMAC
    expect((db.prepare('SELECT id_hash FROM sessions').get() as any).id_hash).not.toBe(sid.value);
  });
  it('rejects wrong state, missing tx cookie and wrong nonce', async () => {
    const r1 = await app.inject({ url: '/auth/login' }); const loc = new URL(r1.headers.location as string);
    expect((await app.inject({ url: '/auth/callback?code=c&state=WRONG', cookies: { oauth_tx: r1.cookies[0].value } })).statusCode).toBe(400);
    expect((await app.inject({ url: `/auth/callback?code=c&state=${loc.searchParams.get('state')}` })).statusCode).toBe(400);
    (oidc as any).nonce = 'different';
    expect((await app.inject({ url: `/auth/callback?code=c&state=${loc.searchParams.get('state')}`, cookies: { oauth_tx: r1.cookies[0].value } })).statusCode).toBe(400);
    expect((db.prepare('SELECT COUNT(*) n FROM sessions').get() as any).n).toBe(0);
  });
  it('denies any account that is not the allowlisted email or is unverified', async () => {
    identity = { email: 'attacker@example.com' };
    expect((await login()).cookie).toBe('');
    identity = { emailVerified: false };
    expect((await login()).cookie).toBe('');
    identity = { email: 'ME@Example.com' }; // case-insensitive match of the allowed account
    expect((await login()).cookie).not.toBe('');
  });
  it('forged / expired session cookies do not authenticate', async () => {
    expect((await app.inject({ url: '/api/me', cookies: { sid: 'forged-token' } })).statusCode).toBe(401);
    const { cookie } = await login();
    db.prepare('UPDATE sessions SET expires_at = 1').run();
    expect((await app.inject({ url: '/api/me', cookies: { sid: cookie } })).statusCode).toBe(401);
  });
  it('allowlist is re-checked per request (changed email revokes access)', async () => {
    const { cookie } = await login();
    db.prepare("UPDATE users SET email = 'someone@else.com'").run();
    expect((await app.inject({ url: '/api/me', cookies: { sid: cookie } })).statusCode).toBe(401);
  });
  it('requires CSRF token and same origin on state-changing requests', async () => {
    const { cookie, csrf } = await login();
    const post = (headers: Record<string, string>) => app.inject({ method: 'POST', url: '/api/watchlist', cookies: { sid: cookie }, headers, payload: { symbol: 'AAPL', name: 'Apple', type: 'equity' } });
    expect((await post({})).statusCode).toBe(403);
    expect((await post({ 'x-csrf-token': 'wrong' })).statusCode).toBe(403);
    expect((await post({ 'x-csrf-token': csrf, origin: 'https://evil.example' })).statusCode).toBe(403);
    expect((await post({ 'x-csrf-token': csrf, origin: 'http://localhost:3000' })).statusCode).toBe(201);
  });
  it('logout destroys the server-side session', async () => {
    const { cookie, csrf } = await login();
    expect((await app.inject({ method: 'POST', url: '/auth/logout', cookies: { sid: cookie }, headers: { 'x-csrf-token': csrf } })).statusCode).toBe(200);
    expect((await app.inject({ url: '/api/me', cookies: { sid: cookie } })).statusCode).toBe(401);
  });
});

describe('API validation & behavior', () => {
  let sess: { cookie: string; csrf: string } | null = null;
  beforeEach(() => { sess = null; });
  const call = async (method: any, url: string, payload?: unknown) => {
    const { cookie, csrf } = (sess ??= await login());
    return app.inject({ method, url, cookies: { sid: cookie }, headers: { 'x-csrf-token': csrf }, payload: payload as any });
  };
  it('rejects invalid input with 400 and readable issues', async () => {
    expect((await call('POST', '/api/watchlist', { symbol: 'bad symbol!', name: 'x', type: 'equity' })).statusCode).toBe(400);
    expect((await call('POST', '/api/topics', { name: '' })).statusCode).toBe(400);
    expect((await call('PUT', '/api/prefs', { weights: { interests: 5 } })).statusCode).toBe(400);
    expect((await call('POST', '/api/stories/abc/read', { read: true })).statusCode).toBe(400);
    expect((await call('GET', '/api/feed?tab=foryou&limit=9999')).statusCode).toBe(400);
  });
  it('rejects SSRF source URLs', async () => {
    for (const url of ['http://169.254.169.254/latest/meta-data', 'http://localhost:3000/', 'file:///etc/passwd', 'http://10.0.0.5/feed'])
      expect((await call('POST', '/api/sources/discover', { url })).statusCode, url).toBe(422);
    expect((await call('POST', '/api/sources', { url: 'http://127.0.0.1/', feedUrl: 'http://127.0.0.1/feed' })).statusCode).toBe(422);
  });
  it('adds a labeled aggregator source, rejects duplicates, and edits/deletes sources', async () => {
    const r = await call('POST', '/api/sources', { url: 'https://example.org/news', aggregator: true, priority: 'high' });
    expect(r.statusCode).toBe(201);
    expect((await call('POST', '/api/sources', { url: 'https://example.org/news', aggregator: true })).statusCode).toBe(409);
    const list = (await call('GET', '/api/sources')).json();
    const added = list.find((s: any) => s.siteUrl.includes('example.org'));
    expect(added.kind).toBe('aggregator'); expect(added.aggregatorLabel).toMatch(/Google News/); expect(added.priority).toBe('high');
    expect((await call('PATCH', `/api/sources/${added.id}`, { enabled: false, priority: 'low', coverage: 'interest', categories: ['Tech'] })).statusCode).toBe(200);
    const after = (await call('GET', '/api/sources')).json().find((s: any) => s.id === added.id);
    expect(after).toMatchObject({ enabled: false, priority: 'low', coverage: 'interest', categories: ['Tech'] });
    expect((await call('DELETE', `/api/sources/${added.id}`)).statusCode).toBe(200);
  });
  it('persists reading state, bookmarks, reversible feedback and hide', async () => {
    const s = Number(db.prepare("SELECT id FROM sources LIMIT 1").get()!.valueOf() && (db.prepare('SELECT id FROM sources LIMIT 1').get() as any).id);
    db.prepare(`INSERT INTO articles (source_id,url,canonical_url,canonical_hash,publisher,title,title_norm,published_at,fetched_at,content_hash,availability) VALUES (?,?,?,?,?,?,?,?,?,?,'headline_only')`).run(s, 'https://x.com/1', 'https://x.com/1', 'h1', 'Pub', 'A headline', 'a headline', Date.now(), Date.now(), 'c1');
    db.prepare("INSERT INTO story_clusters (primary_article_id,title,first_published_at,last_published_at,updated_at,created_at,category) VALUES (1,'A headline',?,?,?,?,'Business')").run(Date.now(), Date.now(), Date.now(), Date.now());
    db.prepare('UPDATE articles SET cluster_id = 1 WHERE id = 1').run(); db.prepare('INSERT INTO cluster_articles VALUES (1,1,0,0)').run();
    const feed = async (tab: string) => (await call('GET', `/api/feed?tab=${tab}`)).json();
    expect((await feed('unread')).items).toHaveLength(1);
    await call('POST', '/api/stories/1/read', { read: true });
    expect((await feed('unread')).items).toHaveLength(0);
    expect((await feed('latest')).items[0].isRead).toBe(true);
    await call('POST', '/api/stories/1/bookmark', { on: true });
    expect((await feed('saved')).items).toHaveLength(1);
    await call('POST', '/api/stories/1/feedback', { rating: -1, reason: 'topic' });
    expect((await feed('latest')).items[0].rating).toBe(-1);
    await call('POST', '/api/stories/1/feedback', { rating: 0 });
    expect((await feed('latest')).items[0].rating).toBe(0); // reversible
    await call('POST', '/api/stories/1/hide', { hidden: true });
    expect((await feed('latest')).items).toHaveLength(0);
    expect((await feed('saved')).items).toHaveLength(1);
    expect((await call('POST', '/api/stories/999/read', { read: true })).statusCode).toBe(404);
    expect((await call('GET', '/api/stories/1/why')).json().reasons.length).toBeGreaterThan(0);
  });
  it('feed responds immediately with cached data (and "stale" flag) without waiting for refresh', async () => {
    const t = Date.now();
    const r = await call('GET', '/api/feed?tab=foryou');
    expect(r.statusCode).toBe(200); expect(Date.now() - t).toBeLessThan(2000);
    const j = r.json(); expect(j.hasAnyStories).toBe(false); expect(j.status.stale).toBe(true);
  });
  it('diagnostics reports counts, db size, and no secrets', async () => {
    const j = (await call('GET', '/api/diagnostics')).json();
    expect(j.counts).toHaveProperty('articles'); expect(j.db.approxSizeMB).toBeGreaterThan(0); expect(j.sources).toHaveLength(4);
    expect(JSON.stringify(j)).not.toMatch(/sec|x{20}/); // no client secret / session secret
  });
  it('security headers are set and API responses are not cacheable', async () => {
    const h = await app.inject({ url: '/health' });
    expect(h.headers['content-security-policy']).toContain("default-src 'self'"); expect(h.headers['x-content-type-options']).toBe('nosniff');
    expect((await call('GET', '/api/status')).headers['cache-control']).toBe('private, no-store');
  });
  it('rss helper sanity (keeps fixture helper exercised)', () => { expect(rss([{ title: 't', link: 'https://x', date: hoursAgo(1) }])).toContain('<item>'); });
});

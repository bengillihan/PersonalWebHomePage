import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Database from 'better-sqlite3';
import type { FastifyInstance } from 'fastify';
import { memDb, fixtureServer, rss, logger, testConfig, type Fixture } from './helpers.js';
import { ingestSource, Refresher } from '../server/news/ingest.js';
import { activeHoursBetween, DEFAULT_FRESHNESS_HOURS, evaluateSource, refreshHealth, type HealthRow } from '../server/news/health.js';
import { buildApp } from '../server/app.js';
import { migrate } from '../server/db.js';
import { MIGRATIONS } from '../server/migrations.js';
import type { OidcClient } from '../server/auth.js';
import type { DB } from '../server/db.js';

let fx: Fixture;
beforeAll(async () => { fx = await fixtureServer(); });
afterAll(async () => { await fx.close(); });

const H = 3_600_000;
const T0 = Date.parse('2026-10-28T19:00:00Z'); // Wednesday 12:00 PDT
const EXC = 'A real excerpt that is long enough to count as an actual summary of this story for the reader.';
const story = (title: string, link: string, at: number) => ({ title, link, date: new Date(at), desc: EXC });

const mk = (db: DB, name: string, path: string, o: { local?: boolean; enabled?: boolean; hours?: number | null } = {}) =>
  Number(db.prepare("INSERT INTO sources (name, site_url, feed_url, kind, is_local, enabled, freshness_hours, created_at) VALUES (?,?,?,'rss',?,?,?,0)")
    .run(name, `${fx.url}/site-${name}`, fx.url + path, o.local ? 1 : 0, o.enabled === false ? 0 : 1, o.hours ?? null).lastInsertRowid);
const row = (db: DB, id: number) => db.prepare('SELECT * FROM sources WHERE id = ?').get(id) as any;
const check = (db: DB, id: number, now: number) => ingestSource({ db, ai: null, log: logger, fetchOpts: { allowPrivate: true } }, row(db, id), now);
const ok200 = (path: string, items: ReturnType<typeof story>[]) => fx.routes.set(path, { body: rss(items), headers: { etag: '"v1"' } });
const notModified = (path: string) => fx.routes.set(path, { status: 304, body: '' });
const hits = (path: string) => fx.hits.filter((h) => h === path).length;
const articles = (db: DB) => (db.prepare('SELECT COUNT(*) n FROM articles').get() as any).n;

describe('freshness is evaluated on every check, including HTTP 304', () => {
  it('a fresh feed returning 304 stays healthy, and the 304 is not recorded as a new article', async () => {
    const db = memDb(); const id = mk(db, 'a', '/h1');
    ok200('/h1', [story('Fresh story headline', 'https://a.example/1', T0 - 2 * H)]);
    await check(db, id, T0);
    notModified('/h1'); await check(db, id, T0 + 6 * H);
    expect(row(db, id)).toMatchObject({ health: 'ok', last_checked_at: T0 + 6 * H, last_success_at: T0 + 6 * H, last_item_at: T0 - 2 * H, last_error: null });
    expect(articles(db)).toBe(1); expect(hits('/h1')).toBe(2);
    expect(evaluateSource(row(db, id), T0 + 6 * H).status).toBe('ok');
  });

  it('REGRESSION: a stale feed returning 304 is reported stale (before: stayed "ok" forever), with connection and publication times kept apart', async () => {
    const db = memDb(); const id = mk(db, 'a', '/h2');
    ok200('/h2', [story('Old story headline', 'https://a.example/1', T0 - 2 * H)]);
    await check(db, id, T0);
    notModified('/h2'); await check(db, id, T0 + 30 * H); // Thursday 18:00: newest article is 32h old, major news expects 24h
    const r = row(db, id);
    expect(r.health).toBe('stale');
    expect(r.last_success_at).toBe(T0 + 30 * H); // the connection did succeed...
    expect(r.last_item_at).toBe(T0 - 2 * H); // ...but nothing newer was published: a 304 never moves the publication date
    expect(r.last_error).toBeNull(); // stale is not an error
    expect(evaluateSource(r, T0 + 30 * H)).toMatchObject({ status: 'stale', reason: expect.stringMatching(/Newest article is 32h old \(expected within 24h/) });
  });

  it('REGRESSION: HTTP 200 with nothing new is judged by the newest article date, not by "now"', async () => {
    const db = memDb(); const id = mk(db, 'a', '/h3');
    const first = story('First story headline', 'https://a.example/1', T0 - 2 * H);
    ok200('/h3', [first]); await check(db, id, T0);
    await check(db, id, T0 + 30 * H); // server ignored If-None-Match and resent the same feed
    expect(row(db, id)).toMatchObject({ health: 'stale', last_item_at: T0 - 2 * H }); expect(articles(db)).toBe(1);
    const fresh = story('A brand new story headline', 'https://a.example/2', T0 + 30 * H);
    ok200('/h3', [fresh, first]); await check(db, id, T0 + 31 * H);
    expect(row(db, id)).toMatchObject({ health: 'ok', last_item_at: T0 + 30 * H }); expect(articles(db)).toBe(2);
  });

  it('a feed with no valid publication dates is an error, not a healthy or merely stale source', async () => {
    const db = memDb(); const id = mk(db, 'a', '/h4');
    fx.routes.set('/h4', { body: '<rss version="2.0"><channel><title>x</title><item><title>No date at all</title><link>https://a.example/nd</link></item></channel></rss>' });
    await check(db, id, T0);
    expect(row(db, id)).toMatchObject({ health: 'error', last_item_at: null, last_success_at: T0 });
    expect(row(db, id).last_error).toMatch(/no valid dated items/i);
    expect(evaluateSource(row(db, id), T0).status).toBe('error');
  });

  it('freshness needs no network: evaluating costs zero requests', async () => {
    const db = memDb(); const id = mk(db, 'a', '/h5');
    ok200('/h5', [story('Some story headline', 'https://a.example/1', T0 - 2 * H)]); await check(db, id, T0);
    const before = fx.hits.length;
    for (let i = 0; i < 50; i++) { evaluateSource(row(db, id), T0 + i * H); refreshHealth(db, id, T0 + i * H); }
    expect(fx.hits.length).toBe(before);
  });
});

describe('thresholds, weekends and statuses', () => {
  it('defaults are 24h for major news and 72h for local, and each is checked against the same feed', async () => {
    expect(DEFAULT_FRESHNESS_HOURS).toEqual({ major: 24, local: 72 });
    const db = memDb(); const major = mk(db, 'major', '/h6'); const local = mk(db, 'local', '/h6', { local: true });
    ok200('/h6', [story('Shared headline', 'https://a.example/1', T0 - 2 * H)]);
    await check(db, major, T0); await check(db, local, T0);
    const at = (id: number, h: number) => evaluateSource(row(db, id), T0 + h * H);
    expect(at(major, 30)).toMatchObject({ status: 'stale', thresholdHours: 24 }); expect(at(local, 30)).toMatchObject({ status: 'ok', thresholdHours: 72 });
    expect(at(local, 100).status).toBe('ok'); // Sunday afternoon: Saturday and Sunday don't count against a local site
    expect(at(local, 120).status).toBe('stale'); // Monday noon: 74 active hours
    expect(at(major, 100).status).toBe('stale');
  });

  it('thresholds can be overridden per source, in both directions', async () => {
    const db = memDb(); const local = mk(db, 'local', '/h7', { local: true }); const major = mk(db, 'major', '/h7');
    ok200('/h7', [story('Shared headline', 'https://a.example/1', T0 - 2 * H)]);
    await check(db, local, T0); await check(db, major, T0);
    expect(evaluateSource({ ...row(db, local), freshness_hours: 12 }, T0 + 14 * H)).toMatchObject({ status: 'stale', thresholdHours: 12 });
    expect(evaluateSource(row(db, local), T0 + 14 * H).status).toBe('ok');
    expect(evaluateSource({ ...row(db, major), freshness_hours: 48 }, T0 + 30 * H).status).toBe('ok');
  });

  it('weekend inactivity does not make a feed stale', () => {
    const friEvening = Date.parse('2026-10-31T00:00:00Z'); // Friday 17:00 PDT
    const row0: HealthRow = { enabled: 1, is_local: 0, freshness_hours: null, last_checked_at: 1, last_error: null, last_item_at: friEvening };
    const sat = Date.parse('2026-10-31T19:00:00Z'), monMorning = Date.parse('2026-11-02T17:00:00Z') /* Mon 09:00 PST */, monNight = Date.parse('2026-11-03T04:00:00Z') /* Mon 20:00 PST */;
    expect((monMorning - friEvening) / H).toBeGreaterThan(24); // by the clock this would look dead
    expect(evaluateSource(row0, sat).status).toBe('ok');
    expect(evaluateSource(row0, monMorning).status).toBe('ok'); // 16 active hours (Fri 17-24 + Mon 0-9), across the DST change
    expect(evaluateSource(row0, monNight)).toMatchObject({ status: 'stale', reason: expect.stringMatching(/27h old/) });
    expect(activeHoursBetween(friEvening, monMorning)).toBe(16);
    expect(activeHoursBetween(monNight, friEvening)).toBe(0);
  });

  it('a failed check is an error (not stale), keeps the last good timestamps, and recovers to the content status', async () => {
    const db = memDb(); const id = mk(db, 'a', '/h8');
    ok200('/h8', [story('Old story headline', 'https://a.example/1', T0 - 2 * H)]);
    await check(db, id, T0); await check(db, id, T0 + 30 * H);
    expect(row(db, id).health).toBe('stale');
    fx.routes.set('/h8', { status: 404, body: 'gone' });
    await check(db, id, T0 + 31 * H);
    expect(row(db, id)).toMatchObject({ health: 'error', last_error: 'HTTP 404', last_success_at: T0 + 30 * H, last_item_at: T0 - 2 * H, last_checked_at: T0 + 31 * H });
    expect(evaluateSource(row(db, id), T0 + 40 * H).status).toBe('error');
    ok200('/h8', [story('Old story headline', 'https://a.example/1', T0 - 2 * H)]);
    await check(db, id, T0 + 41 * H);
    expect(row(db, id)).toMatchObject({ health: 'stale', last_error: null, last_success_at: T0 + 41 * H });
  });

  it('disabled sources are "disabled" regardless of errors or staleness, are never fetched, and keep their stored status', async () => {
    const db = memDb(); const id = mk(db, 'off', '/h9', { enabled: false });
    ok200('/h9', [story('Some story headline', 'https://a.example/1', T0 - 2 * H)]);
    db.prepare("UPDATE sources SET health = 'stale', last_checked_at = 1, last_error = 'HTTP 500', last_item_at = 1 WHERE id = ?").run(id);
    expect(evaluateSource(row(db, id), T0).status).toBe('disabled');
    expect(refreshHealth(db, id, T0)).toBe('disabled'); expect(row(db, id).health).toBe('stale');
    const before = hits('/h9');
    await new Refresher({ db, ai: null, log: logger, fetchOpts: { allowPrivate: true } }).trigger('manual');
    expect(hits('/h9')).toBe(before);
  });

  it('never-checked sources are "unknown", and a source with only unreadable dates on record is stale, not healthy', () => {
    const base: HealthRow = { enabled: 1, is_local: 0, freshness_hours: null, last_checked_at: null, last_error: null, last_item_at: null };
    expect(evaluateSource(base).status).toBe('unknown');
    expect(evaluateSource({ ...base, last_checked_at: 5 })).toMatchObject({ status: 'stale', reason: expect.stringMatching(/No article with a publication date/) });
  });
});

describe('API, migration and compatibility', () => {
  const oidc: OidcClient & { nonce?: string } = { authUrl: ({ state, nonce }) => `https://x/?state=${state}&nonce=${nonce}`, async exchange() { return { sub: 's', email: 'me@example.com', emailVerified: true, name: 'Me', nonce: oidc.nonce ?? null }; } };

  it('sources report status evaluated now (even for legacy rows), editable thresholds, and a "disabled" status', async () => {
    const db = memDb(); const now = Date.now();
    // legacy-style rows: stored health 'ok' from the old logic, never re-evaluated
    const legacy = (name: string, o: { item: number; local?: boolean }) => {
      const id = mk(db, name, '/none', { local: o.local });
      db.prepare("UPDATE sources SET health = 'ok', last_checked_at = ?, last_success_at = ?, last_item_at = ? WHERE id = ?").run(now, now, o.item, id); return id;
    };
    const stale = legacy('Stale Major', { item: now - 100 * H }), fresh = legacy('Fresh Major', { item: now - 1000 }), oldLocal = legacy('Old Local', { item: now - 40 * 24 * H, local: true });
    const { app } = await buildApp(testConfig(), db, { oidc, logger: false, transport: null }) as { app: FastifyInstance };
    const r1 = await app.inject({ url: '/auth/login' }); const loc = new URL(r1.headers.location as string); oidc.nonce = loc.searchParams.get('nonce')!;
    const r2 = await app.inject({ url: `/auth/callback?code=c&state=${loc.searchParams.get('state')}`, cookies: { oauth_tx: r1.cookies[0].value } });
    const cookie = r2.cookies.find((c) => c.name === 'sid')!.value; const csrf = (await app.inject({ url: '/api/me', cookies: { sid: cookie } })).json().csrfToken;
    const call = (method: any, url: string, payload?: unknown) => app.inject({ method, url, cookies: { sid: cookie }, headers: { 'x-csrf-token': csrf }, payload: payload as any });
    const get = async (id: number) => ((await call('GET', '/api/sources')).json() as any[]).find((s) => s.id === id);

    expect(await get(stale)).toMatchObject({ health: 'stale', freshnessHours: null, freshnessDefaultHours: 24, statusReason: expect.stringMatching(/Newest article is \d+h old/), lastError: null });
    expect(await get(fresh)).toMatchObject({ health: 'ok', statusReason: null });
    expect(await get(oldLocal)).toMatchObject({ health: 'stale', freshnessDefaultHours: 72 });
    expect(((await call('GET', '/api/diagnostics')).json() as any).sources.find((s: any) => s.id === stale).health).toBe('stale'); // Diagnostics sees it too

    for (const bad of [0, 337, 1.5, 'x']) expect((await call('PATCH', `/api/sources/${stale}`, { freshnessHours: bad })).statusCode, String(bad)).toBe(400);
    expect((await call('PATCH', `/api/sources/${stale}`, { freshnessHours: 336 })).statusCode).toBe(200);
    expect(await get(stale)).toMatchObject({ health: 'ok', freshnessHours: 336 }); expect(row(db, stale).freshness_hours).toBe(336);
    expect(row(db, stale).health).toBe('ok'); // stored snapshot refreshed locally too
    expect((await call('PATCH', `/api/sources/${stale}`, { freshnessHours: null })).statusCode).toBe(200);
    expect(await get(stale)).toMatchObject({ health: 'stale', freshnessHours: null });
    expect((await call('PATCH', `/api/sources/${fresh}`, { enabled: false })).statusCode).toBe(200);
    expect(await get(fresh)).toMatchObject({ health: 'disabled', enabled: false });
    await app.close();
  });

  it('migration 4 adds freshness_hours without touching existing sources, enforces its range, and is idempotent', () => {
    const raw = new Database(':memory:');
    raw.exec('CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)');
    for (const m of MIGRATIONS.filter((x) => x.id <= 3)) { raw.exec(m.sql); raw.prepare('INSERT INTO schema_migrations VALUES (?,?,0)').run(m.id, m.name); }
    raw.prepare("INSERT INTO sources (name, site_url, feed_url, priority, health, last_checked_at, last_item_at, categories, created_at) VALUES ('Old','https://old.example','https://old.example/feed',2,'ok',5,6,'[\"X\"]',1)").run();
    const before = raw.prepare('SELECT * FROM sources').all();
    expect(migrate(raw as DB)).toEqual(MIGRATIONS.filter((x) => x.id >= 4).map((x) => x.id)); // migration 4 and anything after it
    const after = raw.prepare('SELECT * FROM sources').all() as any[];
    expect(after[0].freshness_hours).toBeNull(); const { freshness_hours: _f, access: _a, ...rest } = after[0]; expect([rest]).toEqual(before);
    expect(() => raw.prepare('UPDATE sources SET freshness_hours = 0').run()).toThrow(/CHECK/);
    expect(() => raw.prepare('UPDATE sources SET freshness_hours = 400').run()).toThrow(/CHECK/);
    raw.prepare('UPDATE sources SET freshness_hours = 336').run();
    expect(migrate(raw as DB)).toEqual([]);
  });
});

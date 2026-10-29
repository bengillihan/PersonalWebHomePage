import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { memDb, testConfig } from './helpers.js';
import { MarketService } from '../server/market/service.js';
import type { Bar, MarketProvider } from '../server/market/provider.js';
import { buildApp } from '../server/app.js';
import type { OidcClient } from '../server/auth.js';
import type { DB } from '../server/db.js';

let db: DB; let calls: string[]; let pending: { symbol: string; ok(b: Bar[]): void; fail(e: Error): void }[]; let auto: boolean;
/** Each instrument gets its own price level, so a price can be traced back to the provider symbol that produced it. */
const LEVEL: Record<string, number> = { OLD: 100, B: 150, NEW: 200, C: 300 };
const barsFor = (s: string): Bar[] => [{ date: '2026-10-27', close: LEVEL[s] }, { date: '2026-10-28', close: LEVEL[s] + 1 }];
const provider = (): MarketProvider => ({ name: 'T', configured: true, async search() { return []; }, dailySeries(symbol) {
  calls.push(symbol);
  if (auto) return Promise.resolve({ symbol, currency: 'USD', type: null, bars: barsFor(symbol) });
  return new Promise((res, rej) => pending.push({ symbol, ok: (bars) => res({ symbol, currency: 'USD', type: null, bars }), fail: rej }));
} });
const until = async (f: () => boolean) => { for (let i = 0; i < 200 && !f(); i++) await new Promise((r) => setTimeout(r, 5)); expect(f()).toBe(true); };
const add = (symbol: string, providerSymbol: string, position = 1) => db.prepare('INSERT INTO watchlist (symbol, name, instrument_type, provider_symbol, position) VALUES (?,?,?,?,?)').run(symbol, symbol + ' fund', 'etf', providerSymbol, position);
/** What PATCH /api/watchlist does for a real remap. */
const remap = (svc: MarketService, symbol: string, providerSymbol: string) => {
  db.prepare('UPDATE watchlist SET provider_symbol = ? WHERE symbol = ?').run(providerSymbol, symbol);
  db.prepare("DELETE FROM market_prices WHERE symbol = ?").run(symbol); return svc.mappingChanged();
};
const q = (svc: MarketService, s: string) => svc.quotes().find((x) => x.symbol === s)!;
beforeEach(() => { db = memDb(); db.prepare('DELETE FROM watchlist').run(); calls = []; pending = []; auto = false; });

describe('a remapped watchlist entry never receives the old instrument\'s data', () => {
  it('REGRESSION: OLD is in flight, the entry is remapped to NEW, OLD answers late: its price is discarded and NEW\'s quote is fetched', async () => {
    add('X', 'OLD'); const svc = new MarketService(db, provider());
    const run = svc.refreshIfNeeded(); await until(() => pending.length === 1);
    const replacement = remap(svc, 'X', 'NEW');
    pending[0].ok(barsFor('OLD')); // the stale answer arrives after the new mapping was saved
    await until(() => pending.length === 2); expect(pending[1].symbol).toBe('NEW');
    expect(q(svc, 'X').last).toBeNull(); // before the fix: 101 (OLD's price) was shown under X
    pending[1].ok(barsFor('NEW')); await Promise.all([run, replacement]);
    expect(q(svc, 'X')).toMatchObject({ last: 201, providerSymbol: 'NEW', error: null }); expect(calls).toEqual(['OLD', 'NEW']);
  });

  it('REGRESSION: old history cannot appear under the new mapping either', async () => {
    add('X', 'OLD'); const svc = new MarketService(db, provider());
    const run = svc.refreshIfNeeded(); await until(() => pending.length === 1);
    remap(svc, 'X', 'NEW'); pending[0].ok(barsFor('OLD')); await until(() => pending.length === 2);
    expect(svc.series('X', '1D').bars).toEqual([]);
    pending[1].ok(barsFor('NEW')); await run;
    expect(svc.series('X', '1D').bars.every((b) => b.close >= 200)).toBe(true);
  });

  it('REGRESSION: a failure of the old request is not recorded against the new mapping', async () => {
    add('X', 'OLD'); const svc = new MarketService(db, provider());
    const run = svc.refreshIfNeeded(); await until(() => pending.length === 1);
    remap(svc, 'X', 'NEW'); pending[0].fail(new Error('OLD exploded')); await until(() => pending.length === 2);
    expect(q(svc, 'X').error).toBeNull(); pending[1].ok(barsFor('NEW')); await run;
    expect(q(svc, 'X')).toMatchObject({ last: 201, error: null });
  });

  it('multiple rapid changes: only the final mapping is fetched, and nothing from the intermediate ones is stored', async () => {
    add('X', 'OLD'); const svc = new MarketService(db, provider());
    const run = svc.refreshIfNeeded(); await until(() => pending.length === 1);
    remap(svc, 'X', 'B'); remap(svc, 'X', 'NEW'); remap(svc, 'X', 'C');
    pending[0].ok(barsFor('OLD')); await until(() => pending.length === 2);
    expect(pending[1].symbol).toBe('C'); pending[1].ok(barsFor('C')); await run;
    expect(q(svc, 'X')).toMatchObject({ last: 301, providerSymbol: 'C' }); expect(calls).toEqual(['OLD', 'C']); // no wasted credits on B or NEW
  });

  it('a remap back to the same provider symbol keeps the in-flight answer valid (it is still that instrument\'s data)', async () => {
    add('X', 'OLD'); const svc = new MarketService(db, provider());
    const run = svc.refreshIfNeeded(); await until(() => pending.length === 1);
    db.prepare("UPDATE watchlist SET provider_symbol = 'NEW' WHERE symbol = 'X'").run(); db.prepare("UPDATE watchlist SET provider_symbol = 'OLD' WHERE symbol = 'X'").run();
    pending[0].ok(barsFor('OLD')); await run;
    expect(q(svc, 'X')).toMatchObject({ last: 101, providerSymbol: 'OLD' }); expect(calls).toEqual(['OLD']);
  });

  it('an entry removed while its request is pending is not resurrected in the cache', async () => {
    add('X', 'OLD'); const svc = new MarketService(db, provider());
    const run = svc.refreshIfNeeded(); await until(() => pending.length === 1);
    db.prepare("DELETE FROM watchlist WHERE symbol = 'X'").run(); db.prepare("DELETE FROM market_prices WHERE symbol = 'X'").run();
    pending[0].ok(barsFor('OLD')); await run;
    expect(db.prepare("SELECT COUNT(*) n FROM market_prices WHERE symbol = 'X'").get()).toEqual({ n: 0 });
  });

  it('an entry remapped before its turn in the run is fetched once, under the new mapping', async () => {
    add('A', 'B', 1); add('X', 'OLD', 2); const svc = new MarketService(db, provider());
    const run = svc.refreshIfNeeded(); await until(() => pending.length === 1); // A (provider B) is in flight; X has not started
    remap(svc, 'X', 'NEW'); pending[0].ok(barsFor('B')); await until(() => pending.length === 2);
    expect(pending[1].symbol).toBe('NEW'); pending[1].ok(barsFor('NEW')); await run;
    expect(calls).toEqual(['B', 'NEW']); expect(q(svc, 'X').last).toBe(201); expect(q(svc, 'A').last).toBe(151);
  });

  it('unchanged mappings work normally: one request each, data under the right symbol, order preserved', async () => {
    auto = true; add('X', 'OLD', 2); add('Y', 'NEW', 1); const svc = new MarketService(db, provider());
    await svc.refreshIfNeeded(); await svc.refreshIfNeeded();
    expect(svc.quotes().map((x) => [x.symbol, x.last])).toEqual([['Y', 201], ['X', 101]]); expect(calls).toEqual(['NEW', 'OLD']); // second refresh is served from cache
  });
});

describe('PATCH /api/watchlist', () => {
  const oidc: OidcClient & { nonce?: string } = { authUrl: ({ state, nonce }) => `https://x/?state=${state}&nonce=${nonce}`, async exchange() { return { sub: 's', email: 'me@example.com', emailVerified: true, name: 'Me', nonce: oidc.nonce ?? null }; } };
  let app: FastifyInstance; let cookie = ''; let csrf = '';
  beforeEach(async () => {
    auto = true; ({ app } = await buildApp(testConfig(), db, { oidc, logger: false, transport: null, provider: provider() }));
    const r1 = await app.inject({ url: '/auth/login' }); const loc = new URL(r1.headers.location as string); oidc.nonce = loc.searchParams.get('nonce')!;
    const r2 = await app.inject({ url: `/auth/callback?code=c&state=${loc.searchParams.get('state')}`, cookies: { oauth_tx: r1.cookies[0].value } });
    cookie = r2.cookies.find((c) => c.name === 'sid')!.value; csrf = (await app.inject({ url: '/api/me', cookies: { sid: cookie } })).json().csrfToken;
  });
  afterEach(async () => { await app.close(); });
  const patch = (id: number, body: unknown) => app.inject({ method: 'PATCH', url: `/api/watchlist/${id}`, cookies: { sid: cookie }, headers: { 'x-csrf-token': csrf }, payload: body as any });
  const post = (symbol: string, providerSymbol: string) => app.inject({ method: 'POST', url: '/api/watchlist', cookies: { sid: cookie }, headers: { 'x-csrf-token': csrf }, payload: { symbol, name: symbol + ' fund', type: 'etf', providerSymbol } });
  const market = async () => (await app.inject({ url: '/api/market', cookies: { sid: cookie } })).json().quotes as any[];

  it('REGRESSION: remapping drops the old price and fetches the new mapping; the entry keeps its place and name', async () => {
    await post('X', 'OLD'); await until(() => calls.length === 1); await post('Z', 'B'); await until(() => calls.length === 2);
    await new Promise((r) => setTimeout(r, 30)); calls.length = 0;
    const id = (db.prepare("SELECT id FROM watchlist WHERE symbol = 'X'").get() as any).id;
    expect((await patch(id, { providerSymbol: 'NEW' })).statusCode).toBe(200);
    await until(() => calls.length === 1); expect(calls).toEqual(['NEW']); // only the remapped entry costs a credit
    await until(() => (db.prepare("SELECT last_value v FROM market_prices WHERE symbol = 'X'").get() as any)?.v === 201);
    const quotes = await market(); expect(quotes.map((x) => x.symbol)).toEqual(['X', 'Z']);
    expect(quotes[0]).toMatchObject({ name: 'X fund', providerSymbol: 'NEW', last: 201 });
  });

  it('a rename or type-preserving edit keeps cached data and makes no provider request', async () => {
    await post('X', 'OLD'); await until(() => calls.length === 1); await new Promise((r) => setTimeout(r, 30)); calls.length = 0;
    const id = (db.prepare("SELECT id FROM watchlist WHERE symbol = 'X'").get() as any).id;
    expect((await patch(id, { name: 'Renamed' })).statusCode).toBe(200);
    await new Promise((r) => setTimeout(r, 50)); expect(calls).toEqual([]);
    expect((await market())[0]).toMatchObject({ name: 'Renamed', last: 101 });
  });
});

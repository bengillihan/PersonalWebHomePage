import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { fixtureServer, memDb, type Fixture } from './helpers.js';
import { MarketService } from '../server/market/service.js';
import { createTwelveData, CreditLimiter, ProviderError } from '../server/market/provider.js';
import type { DB } from '../server/db.js';

let db: DB; let fx: Fixture;
/** Saturday, markets closed, last bar Friday: nothing is "due" for a refresh once cached, so every extra request would be a real regression. */
const T0 = Date.parse('2026-10-31T12:00:00Z');
const BARS = JSON.stringify({ meta: { currency: 'USD', type: 'ETF' }, status: 'ok', values: [{ datetime: '2026-10-30', close: '101' }, { datetime: '2026-10-29', close: '100' }] });
const SEARCH = JSON.stringify({ data: [{ symbol: 'SPY', instrument_name: 'SPDR', exchange: 'NYSE', instrument_type: 'ETF', currency: 'USD' }] });
const ok = (path: string, body: string, headers: Record<string, string> = {}) => fx.routes.set(path, { type: 'application/json', body, headers });
const provider = (limiter = new CreditLimiter(db)) => createTwelveData('KEY', fx.url, { allowPrivate: true }, limiter);
const add = (symbol: string, type = 'etf', position = 1) => db.prepare('INSERT INTO watchlist (symbol, name, instrument_type, provider_symbol, position) VALUES (?,?,?,?,?)').run(symbol, symbol + ' name', type, symbol, position);
const hits = () => fx.hits.length;
const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);
beforeEach(async () => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(T0); db = memDb(); db.prepare('DELETE FROM watchlist').run(); fx = await fixtureServer(); ok('/time_series', BARS); ok('/symbol_search', SEARCH); });
afterEach(async () => { vi.useRealTimers(); await fx.close(); });

describe('CreditLimiter (one rolling window)', () => {
  it('allows the configured credits per minute, then says exactly when the oldest frees up', () => {
    const l = new CreditLimiter(db, 8); for (let i = 0; i < 8; i++) { expect(l.reserve(1)).toEqual({ ok: true }); advance(1000); }
    expect(l.used()).toBe(8); const r = l.reserve(1); expect(r.ok).toBe(false); expect((r as any).retryAfterMs).toBe(60_000 - 8_000 + 1_000 - 1_000); // oldest spent 8s ago
    advance(52_000); expect(l.reserve(1)).toEqual({ ok: true });
  });

  it('the allowance is configurable and defaults to 8', () => {
    const d = new CreditLimiter(db); for (let i = 0; i < 8; i++) d.reserve(1); expect(d.reserve(1).ok).toBe(false);
    const small = new CreditLimiter(null, 2); small.reserve(1); small.reserve(1); expect(small.reserve(1).ok).toBe(false);
  });

  it('multi-credit requests reserve their full weight, and free up in the order they were spent', () => {
    const l = new CreditLimiter(db, 8); expect(l.reserve(3).ok).toBe(true); advance(10_000); expect(l.reserve(5).ok).toBe(true);
    expect(l.reserve(1).ok).toBe(false); // 8 used
    const need3 = l.reserve(3) as any; expect(need3).toMatchObject({ ok: false, retryAfterMs: 50_000 }); // frees when the 3-credit request ages out
    advance(50_000); expect(l.reserve(3)).toEqual({ ok: true }); expect(l.used()).toBe(8);
    expect(new CreditLimiter(null, 8).reserve(20)).toEqual({ ok: true }); // a call heavier than the whole allowance is capped, never stuck forever
  });

  it('RESTART: usage survives a new process (same SQLite), and a clock that jumps backwards cannot mint credits', () => {
    const a = new CreditLimiter(db, 8); for (let i = 0; i < 8; i++) a.reserve(1);
    const afterRestart = new CreditLimiter(db, 8); expect(afterRestart.used()).toBe(8); expect(afterRestart.reserve(1).ok).toBe(false);
    advance(-30_000); expect(new CreditLimiter(db, 8).reserve(1).ok).toBe(false);
    advance(30_000 + 61_000); expect(new CreditLimiter(db, 8).reserve(1)).toEqual({ ok: true }); // a long sleep: the window has simply passed
  });
});

describe('every Twelve Data request goes through it', () => {
  it('REGRESSION: two consecutive refreshes share one allowance: 8 requests, the rest deferred, cached prices untouched, then eligible after the window', async () => {
    const symbols = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'A7', 'A8', 'A9', 'A10']; symbols.forEach((s, i) => add(s, i === 3 ? 'mutual_fund' : 'etf', i + 1));
    const svc = new MarketService(db, provider());
    await svc.refreshIfNeeded(); expect(hits()).toBe(8); // before the fix: 7 per refresh, and the counter reset on every refresh
    await svc.refreshIfNeeded(true); expect(hits()).toBe(8); // second refresh in the same minute: nothing more is sent
    const q = (s: string) => svc.quotes().find((x) => x.symbol === s)!;
    expect(q('A1')).toMatchObject({ last: 101, error: null }); expect(q('A8')).toMatchObject({ last: 101, error: null });
    expect(q('A9')).toMatchObject({ last: null, error: null }); expect(q('A10').error).toBeNull(); // deferred is not an error
    expect((db.prepare('SELECT COUNT(*) n FROM market_prices').get() as any).n).toBe(8);
    advance(61_000); await svc.refreshIfNeeded(); expect(hits()).toBe(10); // only the two never fetched; the cached ones (including the mutual fund NAV) are not due
    expect(q('A10')).toMatchObject({ last: 101 });
  });

  it('REGRESSION: concurrent symbol searches and price refreshes can never exceed the allowance together', async () => {
    for (let i = 1; i <= 7; i++) add('S' + i, 'etf', i);
    const p = provider(); const svc = new MarketService(db, p);
    const results = await Promise.allSettled([svc.refreshIfNeeded(), ...Array.from({ length: 6 }, (_, i) => p.search('spy' + i))]);
    expect(hits()).toBe(8); // 6 searches + 2 prices fit; nothing past 8
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[]; expect(rejected).toHaveLength(0); // the refresh simply stopped early
    const spent = (db.prepare("SELECT COUNT(*) n FROM market_prices").get() as any).n; expect(spent).toBe(2);
    expect(await p.search('late').catch((e) => e)).toMatchObject({ kind: 'rate_limit' }); expect(hits()).toBe(8);
  });

  it('eight credits already consumed: the next request is deferred without being sent, with the wait it needs', async () => {
    const l = new CreditLimiter(db, 8); const p = provider(l); for (let i = 0; i < 8; i++) l.reserve(1);
    const e = await p.search('spy').catch((x) => x); expect(e).toBeInstanceOf(ProviderError); expect(e).toMatchObject({ kind: 'rate_limit', retryAfterMs: 60_000 }); expect(hits()).toBe(0);
    await expect(p.dailySeries('SPY', 10)).rejects.toMatchObject({ kind: 'rate_limit' }); expect(hits()).toBe(0);
    advance(60_001); await expect(p.search('spy')).resolves.toHaveLength(1); expect(hits()).toBe(1); // eventually eligible
  });

  it('RESTART: a fresh provider on the same database still honours credits spent just before the restart', async () => {
    const before = provider(); for (let i = 0; i < 8; i++) await before.search('x' + i); expect(hits()).toBe(8);
    const afterRestart = provider(new CreditLimiter(db)); await expect(afterRestart.search('y')).rejects.toMatchObject({ kind: 'rate_limit' }); expect(hits()).toBe(8);
    advance(61_000); await expect(afterRestart.search('y')).resolves.toBeDefined(); expect(hits()).toBe(9);
  });

  it('retries spend credits too: a failed attempt plus its one retry cost two, and a retry the allowance cannot cover is not sent', async () => {
    const l = new CreditLimiter(db, 8); fx.routes.set('/symbol_search', { status: 500, type: 'application/json', body: '{}' });
    await expect(provider(l).search('spy')).rejects.toMatchObject({ kind: 'network' }); expect(hits()).toBe(2); expect(l.used()).toBe(2); // not 1: before the fix retries were invisible
    const tight = new CreditLimiter(null, 1); const before = hits(); await expect(provider(tight).search('spy')).rejects.toMatchObject({ kind: 'network' }); expect(hits() - before).toBe(1); expect(tight.used()).toBe(1);
  });

  it('a provider-reported limit (HTTP 429 or error body) stops further sends for the rest of the window', async () => {
    const l = new CreditLimiter(db, 8); fx.routes.set('/time_series', { type: 'application/json', body: JSON.stringify({ status: 'error', code: 429, message: 'run out of API credits' }) });
    const p = provider(l); await expect(p.dailySeries('SPY', 10)).rejects.toMatchObject({ kind: 'rate_limit' }); expect(l.used()).toBe(8);
    await expect(p.search('spy')).rejects.toMatchObject({ kind: 'rate_limit', retryAfterMs: expect.any(Number) }); expect(hits()).toBe(1);
  });

  it('syncs with the credits the provider says are left (usage by anything else on the same key)', async () => {
    const l = new CreditLimiter(db, 8); ok('/symbol_search', SEARCH, { 'api-credits-left': '2' }); const p = provider(l);
    await p.search('spy'); expect(l.used()).toBe(6); await p.search('spy'); expect(l.used()).toBe(7); // the local count is never lowered (conservative); the header only ever raises it
    ok('/symbol_search', SEARCH); await p.search('spy'); await expect(p.search('spy')).rejects.toMatchObject({ kind: 'rate_limit' });
  });
});

describe('the service when deferred', () => {
  it('REGRESSION: a deferred refresh keeps cached prices and timestamps, records no error, schedules nothing, and resumes by itself on the next trigger', async () => {
    add('OLD1', 'etf', 1); add('OLD2', 'etf', 2); const l = new CreditLimiter(db, 8); const svc = new MarketService(db, provider(l));
    await svc.refreshIfNeeded(); const fetchedAt = svc.quotes().map((q) => q.fetchedAt); expect(hits()).toBe(2);
    for (let i = 0; i < 6; i++) l.reserve(1); // allowance used up by something else
    advance(2 * 3_600_000 + 61_000); vi.setSystemTime(Date.parse('2026-11-03T15:00:00Z')); // Tuesday, market open: both are due again
    const p2 = l; for (let i = 0; i < 8; i++) p2.reserve(1);
    const timers = vi.getTimerCount(); await svc.refreshIfNeeded(); expect(hits()).toBe(2); expect(vi.getTimerCount()).toBe(timers); // nothing sent, no timer
    expect(svc.quotes().map((q) => [q.last, q.error])).toEqual([[101, null], [101, null]]); expect(svc.quotes().map((q) => q.fetchedAt)).toEqual(fetchedAt);
    advance(61_000); await svc.refreshIfNeeded(); expect(hits()).toBe(4); // eligible again
  });

  it('symbol remapping safeguards still hold with the limiter in front', async () => {
    add('X', 'etf', 1); db.prepare("UPDATE watchlist SET provider_symbol = 'OLD' WHERE symbol = 'X'").run();
    fx.routes.set('/time_series', { type: 'application/json', body: BARS }); const svc = new MarketService(db, provider());
    const run = svc.refreshIfNeeded(); db.prepare("UPDATE watchlist SET provider_symbol = 'NEW' WHERE symbol = 'X'").run(); db.prepare('DELETE FROM market_prices WHERE symbol = ?').run('X'); void svc.mappingChanged();
    await run; await vi.waitFor(() => expect(svc.quotes()[0].last).toBe(101)); expect(svc.quotes()[0].providerSymbol).toBe('NEW');
    expect(fx.hits.some((h) => h.includes('symbol=NEW'))).toBe(true);
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { memDb, testConfig } from './helpers.js';
import { MarketService, periodReturns, RANGES, HISTORY_DAYS, type Range } from '../server/market/service.js';
import { isBusinessDay } from '../server/market/schedule.js';
import type { Bar, MarketProvider } from '../server/market/provider.js';
import { buildApp } from '../server/app.js';
import type { OidcClient } from '../server/auth.js';
import type { DB } from '../server/db.js';

let db: DB; let providerCalls: { symbol: string; days: number }[];
const provider = (): MarketProvider => ({ name: 'T', configured: true, async search() { return []; }, async dailySeries(symbol, days) { providerCalls.push({ symbol, days }); return { symbol, currency: 'USD', type: null, bars: tradingBars('2025-01-02', '2026-10-28') }; } });
const day = (iso: string, d: number) => new Date(Date.parse(iso + 'T00:00:00Z') + d * 86_400_000).toISOString().slice(0, 10);
/** Daily closes on real trading days only (weekends and NYSE holidays skipped), rising 1.00 per bar from 100. */
function tradingBars(from: string, to: string, start = 100): Bar[] {
  const out: Bar[] = []; for (let d = from; d <= to; d = day(d, 1)) if (isBusinessDay(d)) out.push({ date: d, close: start + out.length });
  return out;
}
function seed(symbol: string, type: 'equity' | 'etf' | 'mutual_fund' | 'index', bars: Bar[], name = symbol) {
  db.prepare('INSERT INTO watchlist (symbol, name, instrument_type, position) VALUES (?,?,?,0)').run(symbol, name, type);
  db.prepare("INSERT INTO market_prices (symbol, range, fetched_at, series) VALUES (?, 'daily', ?, ?)").run(symbol, Date.now(), JSON.stringify(bars));
}
const svc = () => new MarketService(db, provider());
const quote = (s: MarketService, sym: string) => s.quotes().find((q) => q.symbol === sym)!;
beforeEach(() => { db = memDb(); providerCalls = []; });

describe('chart periods and return periods are the same period', () => {
  it('REGRESSION: the 1D view is one daily-close comparison (2 points), not five closes next to a one-day change', () => {
    seed('SPY', 'etf', tradingBars('2026-09-01', '2026-10-28'));
    const s = svc(); const one = s.series('SPY', '1D'); const q = quote(s, 'SPY');
    expect(one.bars).toHaveLength(2); // before the fix: 5 daily closes labelled 1D
    expect(one.bars[1].close - one.bars[0].close).toBeCloseTo(q.changes.find((c) => c.range === '1D')!.change); // the chart spans exactly the period that was calculated
    expect(one.basis).toMatch(/daily close/i); expect(one.basis).toMatch(/no intraday/i); // honest: not presented as intraday
  });

  it('REGRESSION: two data points cannot produce weekly, monthly, YTD or yearly returns', () => {
    seed('NEW', 'etf', [{ date: '2026-10-27', close: 50 }, { date: '2026-10-28', close: 51 }]);
    const q = quote(svc(), 'NEW');
    expect(q.changes.map((c) => c.range)).toEqual(['1D']); // before the fix: 1D, 1W and 1M all "available" and identical
    for (const r of ['1W', '1M', 'YTD', '1Y'] as Range[]) expect(q.ranges.find((x) => x.range === r), r).toMatchObject({ available: false, reason: 'Not enough history', change: null, pct: null });
    expect(q.ranges.find((x) => x.range === '1D')).toMatchObject({ available: true, change: 1 });
    expect(svc().series('NEW', '1M')).toMatchObject({ bars: [], available: false, reason: 'Not enough history' }); // and no misleading chart either
  });

  it.each(RANGES)('for %s the chart starts at the base of the calculated return and ends at the latest observation', (range) => {
    seed('SPY', 'etf', tradingBars('2025-01-02', '2026-10-28')); const s = svc();
    const p = quote(s, 'SPY').ranges.find((r) => r.range === range)!; const ser = s.series('SPY', range);
    expect(p.available).toBe(true); expect(ser.available).toBe(true);
    expect(ser.bars[0].date).toBe(p.fromDate); expect(ser.bars.at(-1)!.date).toBe(p.toDate); expect(p.toDate).toBe('2026-10-28');
    expect(ser.bars.at(-1)!.close - ser.bars[0].close).toBeCloseTo(p.change!);
    expect(((ser.bars.at(-1)!.close - ser.bars[0].close) / ser.bars[0].close) * 100).toBeCloseTo(p.pct!);
  });
});

describe('periods follow the calendar and the trading calendar', () => {
  const r = (bars: Bar[], range: Range) => periodReturns(bars).find((x) => x.range === range)!;
  it('1W, 1M, YTD and 1Y are measured against the close on or before the matching calendar date', () => {
    const bars = tradingBars('2025-01-02', '2026-10-28'); // last bar Wed 2026-10-28
    expect(r(bars, '1W')).toMatchObject({ fromDate: '2026-10-21', toDate: '2026-10-28' });
    expect(r(bars, '1M')).toMatchObject({ fromDate: '2026-09-28' });
    expect(r(bars, 'YTD')).toMatchObject({ fromDate: '2025-12-31' });
    expect(r(bars, '1Y')).toMatchObject({ fromDate: '2025-10-28' });
  });
  it('a target date that falls on a weekend or market holiday uses the prior trading day', () => {
    const feb = tradingBars('2025-12-01', '2026-02-19'); // last bar Thu 2026-02-19; 1M target = Mon 2026-01-19 = Martin Luther King Jr. Day (closed)
    expect(r(feb, '1M').fromDate).toBe('2026-01-16');
    const nov = tradingBars('2025-09-01', '2026-11-03'); // 1M target = Sat 2026-10-03
    expect(r(nov, '1M').fromDate).toBe('2026-10-02');
    const ytd = tradingBars('2022-11-01', '2023-03-01'); // Dec 31 2022 was a Saturday: the year-end base is Fri Dec 30
    expect(r(ytd, 'YTD').fromDate).toBe('2022-12-30');
    expect(r(tradingBars('2026-10-01', '2026-11-27'), '1W').fromDate).toBe('2026-11-20'); // across Thanksgiving (Nov 26 closed)
  });
  it('a market closure only means the latest bar is older; returns are as of that bar, not "now"', () => {
    const bars = tradingBars('2025-01-02', '2026-11-25'); // data ends before Thanksgiving; nothing for the holiday
    expect(r(bars, '1D')).toMatchObject({ available: true, toDate: '2026-11-25', fromDate: '2026-11-24' });
  });
  it('a hole in the data larger than a week at the start of a period means unavailable, not a stretched return', () => {
    const bars = [...tradingBars('2025-01-02', '2026-08-25'), ...tradingBars('2026-09-14', '2026-10-05', 500)]; // nothing between Aug 25 and Sep 14
    expect(r(bars, '1M')).toMatchObject({ available: false, reason: 'Not enough history' }); // 1M target Sep 5 falls in the hole: the nearest earlier close is 11 days stale
    expect(r(bars, '1W')).toMatchObject({ available: true, fromDate: '2026-09-28' }); // periods the data does cover still work
  });
  it('YTD needs a prior-year close; with data starting in January it is unavailable', () => {
    expect(r(tradingBars('2026-01-05', '2026-10-28'), 'YTD')).toMatchObject({ available: false, reason: 'Not enough history' });
    expect(r(tradingBars('2025-12-22', '2026-10-28'), 'YTD')).toMatchObject({ available: true, fromDate: '2025-12-31' });
  });
  it('short history supports only what it covers', () => {
    const bars = tradingBars('2026-10-12', '2026-10-28'); // ~13 sessions
    expect(periodReturns(bars).map((x) => [x.range, x.available])).toEqual([['1D', true], ['1W', true], ['1M', false], ['YTD', false], ['1Y', false]]);
    expect(periodReturns([]).every((x) => !x.available)).toBe(true); expect(periodReturns([{ date: '2026-10-28', close: 5 }]).every((x) => !x.available)).toBe(true);
  });
  it('1Y needs a full year of history, and the fetch now asks for enough of it at no extra credit cost', () => {
    expect(r(tradingBars('2025-10-29', '2026-10-28'), '1Y').available).toBe(false); // one day short
    expect(r(tradingBars('2025-10-24', '2026-10-28'), '1Y').available).toBe(true);
    expect(HISTORY_DAYS).toBeGreaterThanOrEqual(265); // 260 sessions fall a few days short of a calendar year
  });
  it('a zero or missing base close never yields a return', () => {
    expect(periodReturns([{ date: '2026-10-27', close: 0 }, { date: '2026-10-28', close: 5 }]).find((x) => x.range === '1D')).toMatchObject({ available: false });
  });
});

describe('what is being measured is stated honestly', () => {
  it('mutual funds use published daily NAV: labelled NAV, compared with the previous published NAV, never intraday', () => {
    seed('VTWAX', 'mutual_fund', tradingBars('2025-01-02', '2026-10-28'), 'Vanguard Total World Stock Index Admiral'); const s = svc();
    const q = quote(s, 'VTWAX');
    expect(q).toMatchObject({ changeKind: 'nav', isDailyNav: true, includesDistributions: false }); expect(q.note).toMatch(/not an intraday/);
    expect(s.series('VTWAX', '1D').basis).toMatch(/published NAV/i); expect(s.series('VTWAX', '1D').basis).not.toMatch(/intraday quote|live/i); expect(s.series('VTWAX', '1D').bars).toHaveLength(2);
  });
  it('price and NAV changes are never presented as total return', () => {
    seed('SPY', 'etf', tradingBars('2025-01-02', '2026-10-28')); seed('VTSAX', 'mutual_fund', tradingBars('2025-01-02', '2026-10-28'));
    const s = svc();
    for (const sym of ['SPY', 'VTSAX']) { const q = quote(s, sym); expect(q.includesDistributions).toBe(false); expect(s.series(sym, '1Y').disclaimer).toMatch(/not total return/i); expect(s.series(sym, '1Y').disclaimer).toMatch(/dividend|distribution/i); }
    expect(quote(s, 'SPY').changeKind).toBe('price'); expect(s.series('SPY', '1Y').kind).toBe('price'); expect(s.series('VTSAX', '1Y').kind).toBe('nav');
  });
});

describe('cached history only', () => {
  it('reading quotes and charts makes no provider call; a refresh is still one request per symbol', async () => {
    seed('SPY', 'etf', tradingBars('2025-01-02', '2026-10-28')); const s = svc();
    for (let i = 0; i < 5; i++) { s.quotes(); for (const r of RANGES) s.series('SPY', r); }
    expect(providerCalls).toEqual([]);
    db.prepare("DELETE FROM market_prices WHERE symbol = 'SPY'").run(); await s.refreshIfNeeded(true);
    expect(providerCalls).toEqual([{ symbol: 'SPY', days: HISTORY_DAYS }]); // one request, and it asks for enough history for every period
  });
});

describe('via the API', () => {
  const oidc: OidcClient & { nonce?: string } = { authUrl: ({ state, nonce }) => `https://x/?state=${state}&nonce=${nonce}`, async exchange() { return { sub: 's', email: 'me@example.com', emailVerified: true, name: 'Me', nonce: oidc.nonce ?? null }; } };
  it('exposes per-period availability and the series metadata', async () => {
    seed('NEW', 'etf', [{ date: '2026-10-27', close: 50 }, { date: '2026-10-28', close: 51 }]);
    const { app } = await buildApp(testConfig(), db, { oidc, logger: false, transport: null, provider: provider() });
    const r1 = await app.inject({ url: '/auth/login' }); const loc = new URL(r1.headers.location as string); oidc.nonce = loc.searchParams.get('nonce')!;
    const r2 = await app.inject({ url: `/auth/callback?code=c&state=${loc.searchParams.get('state')}`, cookies: { oauth_tx: r1.cookies[0].value } });
    const cookie = r2.cookies.find((c) => c.name === 'sid')!.value;
    const m = (await app.inject({ url: '/api/market', cookies: { sid: cookie } })).json(); const q = m.quotes.find((x: any) => x.symbol === 'NEW');
    expect(q.ranges.map((x: any) => [x.range, x.available])).toEqual([['1D', true], ['1W', false], ['1M', false], ['YTD', false], ['1Y', false]]);
    const ser = (await app.inject({ url: '/api/market/series?symbol=NEW&range=1M', cookies: { sid: cookie } })).json();
    expect(ser).toMatchObject({ available: false, reason: 'Not enough history', bars: [], kind: 'price' }); expect(providerCalls).toEqual([]);
    await app.close();
  });
});

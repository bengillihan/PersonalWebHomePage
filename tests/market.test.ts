import { describe, it, expect } from 'vitest';
import { memDb } from './helpers.js';
import { parseTwelveDataSeries, ProviderError, mapInstrumentType, type MarketProvider, type Series } from '../server/market/provider.js';
import { changesFromBars, sliceRange, MarketService } from '../server/market/service.js';
import { needsRefresh, nyseHolidays, isBusinessDay, marketOpen, latestExpectedDate, etParts } from '../server/market/schedule.js';
import { seedDefaults } from '../server/seed.js';

const navFixture = { meta: { symbol: 'VTWAX', interval: '1day', currency: 'USD', exchange: 'NASDAQ', type: 'Mutual Fund' }, status: 'ok',
  values: [{ datetime: '2026-10-28', open: '0', high: '0', low: '0', close: '161.42', volume: '0' }, { datetime: '2026-10-27', close: '160.10' }, { datetime: '2026-10-26', close: '159.00' }] };

function bars(n: number, start = 100, endDate = '2026-10-28') {
  const out = []; const end = Date.parse(endDate + 'T00:00:00Z');
  for (let i = n - 1; i >= 0; i--) out.push({ date: new Date(end - i * 86_400_000).toISOString().slice(0, 10), close: start + (n - 1 - i) });
  return out;
}

describe('market quote parsing', () => {
  it('parses Twelve Data time_series fixtures into ascending bars', () => {
    const s = parseTwelveDataSeries(navFixture, 'VTWAX');
    expect(s.bars.map((b) => b.date)).toEqual(['2026-10-26', '2026-10-27', '2026-10-28']); expect(s.bars.at(-1)!.close).toBe(161.42); expect(s.type).toBe('Mutual Fund');
  });
  it('maps documented error shapes to honest provider errors', () => {
    const kind = (b: any) => { try { parseTwelveDataSeries(b, 'X'); } catch (e) { return (e as ProviderError).kind; } };
    expect(kind({ status: 'error', code: 429, message: 'limit' })).toBe('rate_limit');
    expect(kind({ status: 'error', code: 401, message: 'bad key' })).toBe('no_key');
    expect(kind({ status: 'error', code: 403, message: 'upgrade your plan' })).toBe('plan');
    expect(kind({ status: 'error', code: 404, message: 'symbol not found' })).toBe('not_found');
    expect(kind({ status: 'ok', values: [] })).toBe('not_found');
    expect(kind({ status: 'ok', values: [{ datetime: 'x', close: 'nan' }] })).toBe('bad_response');
  });
  it('maps instrument types', () => { expect(mapInstrumentType('Mutual Fund')).toBe('mutual_fund'); expect(mapInstrumentType('ETF')).toBe('etf'); expect(mapInstrumentType('Common Stock')).toBe('equity'); expect(mapInstrumentType('Index')).toBe('index'); expect(mapInstrumentType('Crypto')).toBeNull(); });
  it('computes absolute/percent change per CALENDAR period, only where history covers it', () => {
    const b = bars(400); // one bar per calendar day ending 2026-10-28, rising 1.00 per day
    const ch = Object.fromEntries(changesFromBars(b).map((c) => [c.range, c]));
    expect(ch['1D'].change).toBe(1); expect(ch['1W'].change).toBe(7); expect(ch['1M'].change).toBe(30); // 7 and 30 calendar days back, not 5 and 21 bars
    expect(ch.YTD.change).toBe(301); expect(ch['1Y'].change).toBe(365); expect(ch['1D'].pct).toBeGreaterThan(0);
    expect(changesFromBars(bars(330)).map((c) => c.range)).toEqual(['1D', '1W', '1M', 'YTD']); // 330 days is not a year: no 1Y return
    expect(changesFromBars(bars(30)).map((c) => c.range)).toEqual(['1D', '1W']);
    expect(sliceRange(b, '1M')).toHaveLength(31); // the chart spans exactly the month the return covers
    expect(sliceRange(b, '1D')).toHaveLength(2);
  });
});

describe('mutual fund NAV + market schedule behavior', () => {
  it('knows NYSE holidays and weekends', () => {
    expect(nyseHolidays(2026).has('2026-11-26')).toBe(true); // Thanksgiving
    expect(nyseHolidays(2026).has('2026-12-25')).toBe(true); expect(nyseHolidays(2026).has('2026-04-03')).toBe(true); // Good Friday
    expect(isBusinessDay('2026-10-31')).toBe(false); expect(isBusinessDay('2026-10-28')).toBe(true);
  });
  it('mutual funds: no provider call on weekends/holidays once the latest NAV is cached; one call after publication', () => {
    const sat = Date.parse('2026-10-31T16:00:00Z');
    expect(needsRefresh('mutual_fund', { fetchedAt: sat - 5 * 3_600_000, lastBarDate: '2026-10-30', hadError: false }, sat)).toBe(false);
    const thanksgiving = Date.parse('2026-11-26T18:00:00Z');
    expect(needsRefresh('mutual_fund', { fetchedAt: thanksgiving - 9 * 3_600_000, lastBarDate: '2026-11-25', hadError: false }, thanksgiving)).toBe(false);
    // Wed 2026-10-28 22:00 ET = 02:00Z next day: NAV for 10-28 should now exist, cache only has 10-27
    const eveningAfter = Date.parse('2026-10-29T02:00:00Z');
    expect(latestExpectedDate(eveningAfter, 'nav')).toBe('2026-10-28');
    expect(needsRefresh('mutual_fund', { fetchedAt: eveningAfter - 6 * 3_600_000, lastBarDate: '2026-10-27', hadError: false }, eveningAfter)).toBe(true);
    // intraday Wed: NAV is only expected for Tuesday, so no refetch if we already have it
    const midday = Date.parse('2026-10-28T17:00:00Z');
    expect(needsRefresh('mutual_fund', { fetchedAt: midday - 3_600_000 * 6, lastBarDate: '2026-10-27', hadError: false }, midday)).toBe(false);
  });
  it('equities refresh every ~10 min only while the market is open', () => {
    const open = Date.parse('2026-10-28T15:00:00Z'); // 11:00 ET
    expect(marketOpen(open)).toBe(true); expect(etParts(open).hh).toBe(11);
    expect(needsRefresh('etf', { fetchedAt: open - 5 * 60_000, lastBarDate: '2026-10-28', hadError: false }, open)).toBe(false);
    expect(needsRefresh('etf', { fetchedAt: open - 11 * 60_000, lastBarDate: '2026-10-28', hadError: false }, open)).toBe(true);
    const night = Date.parse('2026-10-29T03:00:00Z');
    expect(marketOpen(night)).toBe(false);
    expect(needsRefresh('etf', { fetchedAt: night - 3_600_000, lastBarDate: '2026-10-28', hadError: false }, night)).toBe(false);
  });
  it('service labels NAV and money-market funds honestly and never fabricates quotes without a provider', async () => {
    const db = memDb(); seedDefaults(db);
    const none: MarketProvider = { name: 'T', configured: false, async dailySeries() { throw new ProviderError('x', 'no_key'); }, async search() { return []; } };
    const svc = new MarketService(db, none);
    const q = svc.quotes();
    expect(q).toHaveLength(6); expect(q.every((x) => x.last === null && x.errorKind === 'no_key')).toBe(true);
    const calls: string[] = [];
    const prov: MarketProvider = { name: 'T', configured: true, async search() { return []; }, async dailySeries(sym): Promise<Series> { calls.push(sym); if (sym === 'SPX') throw new ProviderError('Not available on your provider plan: upgrade', 'plan'); return { symbol: sym, currency: 'USD', type: null, bars: bars(260, 100) }; } };
    const live = new MarketService(db, prov);
    await live.refreshIfNeeded(true);
    const quotes = Object.fromEntries(live.quotes().map((x) => [x.symbol, x]));
    expect(quotes.VTWAX.isDailyNav).toBe(true); expect(quotes.VTWAX.note).toMatch(/not an intraday/);
    expect(quotes.VMFXX.isMoneyMarket).toBe(true); expect(quotes.VMFXX.note).toMatch(/Yield is a separate figure/);
    expect(quotes.SPX.last).toBeNull(); expect(quotes.SPX.errorKind).toBe('plan'); expect(quotes.SPX.error).toMatch(/plan/);
    expect(quotes.VTWAX.changes.map((c) => c.range)).toEqual(['1D', '1W', '1M']); // 260 days of history supports these; YTD and 1Y are honestly unavailable
    expect(quotes.VTWAX.ranges.filter((r) => !r.available).map((r) => r.range)).toEqual(['YTD', '1Y']);
    const before = calls.length; await live.refreshIfNeeded(); expect(calls.length).toBe(before); // cached: no new calls
  });
});

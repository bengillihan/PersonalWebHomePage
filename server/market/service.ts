import type { DB } from '../db.js';
import { needsRefresh } from './schedule.js';
import { ProviderError, type Bar, type InstrumentType, type MarketProvider } from './provider.js';

export type Range = '1D' | '1W' | '1M' | 'YTD' | '1Y';
export const RANGES: Range[] = ['1D', '1W', '1M', 'YTD', '1Y'];
/** Daily bars requested per refresh. One request per symbol regardless of length, so this costs no extra credits; ~275 sessions covers a full calendar year. */
export const HISTORY_DAYS = 275;

export type ChangeKind = 'price' | 'nav';
export interface RangeChange { range: Range; change: number; pct: number }
/** One period's return. Unavailable (with a reason) rather than approximated when history does not cover the period. */
export interface PeriodResult { range: Range; available: boolean; reason: string | null; fromDate: string | null; toDate: string | null; change: number | null; pct: number | null }
export interface QuoteDto {
  symbol: string; name: string; type: InstrumentType; providerSymbol: string;
  last: number | null; asOf: string | null; fetchedAt: number | null; isDailyNav: boolean; isMoneyMarket: boolean;
  changes: RangeChange[]; // only the periods that are actually available
  ranges: PeriodResult[]; // every period, with availability
  changeKind: ChangeKind; includesDistributions: false; // price/NAV change only: never a total return
  error: string | null; errorKind: string | null;
  note: string | null;
}

const NOT_ENOUGH = 'Not enough history';
const MAX_BASE_GAP_DAYS = 7; // the base close may be at most a week before the calendar date it stands for (weekends, holidays, short data gaps)
const ms = (d: string) => Date.parse(d + 'T00:00:00Z');
const iso = (t: number) => new Date(t).toISOString().slice(0, 10);
const daysBetween = (from: string, to: string) => Math.round((ms(to) - ms(from)) / 86_400_000);
function monthsBack(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number); const t = new Date(Date.UTC(y, m - 1 - months, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  return iso(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), Math.min(d, last)));
}

/** The calendar date each period starts from (as of the latest observation). 1D is handled separately: it compares consecutive closes. */
function targetDate(range: Exclude<Range, '1D'>, last: string): string {
  if (range === '1W') return iso(ms(last) - 7 * 86_400_000);
  if (range === '1M') return monthsBack(last, 1);
  if (range === 'YTD') return `${Number(last.slice(0, 4)) - 1}-12-31`;
  return monthsBack(last, 12);
}

/** Index of the bar a period starts from, or null if the history does not support it. Bars must be ascending trading-day observations. */
function baseIndex(bars: Bar[], range: Range): number | null {
  if (bars.length < 2) return null;
  const lastIdx = bars.length - 1; const last = bars[lastIdx];
  if (range === '1D') return daysBetween(bars[lastIdx - 1].date, last.date) <= MAX_BASE_GAP_DAYS ? lastIdx - 1 : null; // previous published close
  const target = targetDate(range, last.date);
  for (let i = lastIdx - 1; i >= 0; i--) { // the latest close ON OR BEFORE the target date: a weekend/holiday target uses the prior trading day
    if (bars[i].date <= target) return daysBetween(bars[i].date, target) <= MAX_BASE_GAP_DAYS ? i : null;
  }
  return null; // history starts after the target date
}

/** Returns for every period, calendar-based and only where real history covers them. */
export function periodReturns(bars: Bar[]): PeriodResult[] {
  const none = (range: Range, reason: string): PeriodResult => ({ range, available: false, reason, fromDate: null, toDate: null, change: null, pct: null });
  return RANGES.map((range) => {
    const i = baseIndex(bars, range);
    if (i === null) return none(range, NOT_ENOUGH);
    const base = bars[i], last = bars[bars.length - 1];
    if (!(base.close > 0) || !Number.isFinite(last.close)) return none(range, 'No valid base price');
    return { range, available: true, reason: null, fromDate: base.date, toDate: last.date, change: last.close - base.close, pct: ((last.close - base.close) / base.close) * 100 };
  });
}

/** Available periods only (kept for callers that just want numbers). */
export function changesFromBars(bars: Bar[]): RangeChange[] {
  return periodReturns(bars).filter((p) => p.available).map((p) => ({ range: p.range, change: p.change!, pct: p.pct! }));
}

/** The observations a period's chart shows: from its base close to the latest, i.e. exactly the span the return was calculated over. */
export function sliceRange(bars: Bar[], range: Range): Bar[] {
  const i = baseIndex(bars, range);
  return i === null ? [] : bars.slice(i);
}

const DISCLAIMER = {
  price: 'Price change only: excludes dividends and distributions; not total return.',
  nav: 'NAV change only: excludes distributions that a total return would add back; not total return.',
} as const;

function basisText(range: Range, kind: ChangeKind, p: PeriodResult): string {
  if (!p.available) return NOT_ENOUGH;
  if (range === '1D') return kind === 'nav' ? 'Latest published NAV vs the previous published NAV (daily data; no intraday movement).' : 'Latest daily close vs the previous daily close (daily data only; no intraday data).';
  return `${kind === 'nav' ? 'Published NAV' : 'Daily close'} on ${p.fromDate} vs ${p.toDate}.`;
}

export interface SeriesDto { symbol: string; range: Range; bars: Bar[]; available: boolean; reason: string | null; fromDate: string | null; toDate: string | null; change: number | null; pct: number | null; kind: ChangeKind; basis: string; disclaimer: string }

export class MarketService {
  private inflight: Promise<void> | null = null;
  /** Set when a result was discarded or a mapping changed mid-run: one follow-up pass fetches the replacement (cache and rate limits still apply). */
  private rerun = false;
  /** When our rate limiter last deferred a call, until when. Until then refreshes return immediately (no DB scan, no timers); the cache keeps serving. */
  private deferredUntil = 0;
  constructor(private db: DB, private provider: MarketProvider) {}

  get providerInfo() { return { name: this.provider.name, configured: this.provider.configured }; }

  /** What a stored price depends on: the provider symbol (and type, which decides NAV handling). A result is only valid for the mapping it was requested under. */
  static mappingKey(w: { symbol: string; provider_symbol?: string | null; instrument_type: string }) { return `${w.provider_symbol || w.symbol}|${w.instrument_type}`; }
  private row(symbol: string) { return this.db.prepare('SELECT * FROM watchlist WHERE symbol = ?').get(symbol) as any | undefined; }
  /** Called after a watchlist mapping edit/removal: makes sure a replacement fetch happens even if a run is already in flight. */
  mappingChanged(): Promise<void> { if (this.inflight) this.rerun = true; return this.refreshIfNeeded(); }

  private rows() { return this.db.prepare('SELECT * FROM watchlist ORDER BY position, id').all() as any[]; }

  quotes(): QuoteDto[] {
    const cached = new Map((this.db.prepare("SELECT * FROM market_prices WHERE range = 'daily'").all() as any[]).map((r) => [r.symbol, r]));
    return this.rows().map((w) => {
      const c = cached.get(w.symbol);
      const bars: Bar[] = c?.series ? JSON.parse(c.series) : [];
      const last = bars[bars.length - 1];
      const isMM = /money market/i.test(w.name) || w.symbol === 'VMFXX';
      const isNav = w.instrument_type === 'mutual_fund';
      let error: string | null = c?.error ?? null; let errorKind: string | null = null;
      if (!this.provider.configured) { error = 'Market data provider not configured (set TWELVEDATA_API_KEY)'; errorKind = 'no_key'; }
      else if (c?.error) errorKind = /plan/i.test(c.error) ? 'plan' : /rate limit/i.test(c.error) ? 'rate_limit' : 'error';
      return {
        symbol: w.symbol, name: w.name, type: w.instrument_type, providerSymbol: w.provider_symbol || w.symbol,
        last: last?.close ?? null, asOf: last?.date ?? null, fetchedAt: c?.fetched_at ?? null, isDailyNav: isNav,
        isMoneyMarket: isMM, changes: changesFromBars(bars), ranges: periodReturns(bars), changeKind: isNav ? 'nav' : 'price', includesDistributions: false,
        error: last ? (errorKind === 'no_key' ? error : null) : error, errorKind,
        note: isMM ? 'Stable NAV (typically $1.00). Yield is a separate figure and is not shown here.' : isNav ? 'Daily published NAV, not an intraday quote.' : null,
      };
    });
  }

  /** The chart for one period, from cached history only (no provider call). Spans exactly the period the return is calculated over. */
  series(symbol: string, range: Range): SeriesDto {
    const c = this.db.prepare("SELECT series FROM market_prices WHERE symbol = ? AND range = 'daily'").get(symbol) as any;
    const type = (this.db.prepare('SELECT instrument_type t FROM watchlist WHERE symbol = ?').get(symbol) as { t: string } | undefined)?.t;
    const kind: ChangeKind = type === 'mutual_fund' ? 'nav' : 'price';
    const bars: Bar[] = c?.series ? JSON.parse(c.series) : [];
    const p = periodReturns(bars).find((x) => x.range === range)!;
    return { symbol, range, bars: sliceRange(bars, range), available: p.available, reason: p.reason, fromDate: p.fromDate, toDate: p.toDate, change: p.change, pct: p.pct, kind, basis: basisText(range, kind, p), disclaimer: DISCLAIMER[kind] };
  }

  /** Refreshes only instruments whose schedule says new data should exist. Serial, spaced to respect per-minute limits. */
  refreshIfNeeded(force = false): Promise<void> {
    if (!this.provider.configured) return Promise.resolve();
    if (this.inflight) return this.inflight;
    if (Date.now() < this.deferredUntil) return Promise.resolve();
    this.inflight = (async () => {
      await this.run(force);
      for (let i = 0; i < 3 && this.rerun; i++) { this.rerun = false; await this.run(false); }
      this.rerun = false;
    })().finally(() => { this.inflight = null; });
    return this.inflight;
  }
  get running() { return this.inflight !== null; }

  private async run(force: boolean) {
    const now = Date.now();
    const put = this.db.prepare(`INSERT INTO market_prices (symbol, range, fetched_at, last_value, change_abs, change_pct, as_of, is_daily_nav, series, error)
      VALUES (?, 'daily', ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(symbol, range) DO UPDATE SET fetched_at=excluded.fetched_at, last_value=excluded.last_value,
      change_abs=excluded.change_abs, change_pct=excluded.change_pct, as_of=excluded.as_of, is_daily_nav=excluded.is_daily_nav, series=COALESCE(excluded.series, market_prices.series), error=excluded.error`);
    for (const listed of this.rows()) {
      // Re-read the entry and its cache right before deciding: the user may have remapped it since this run began.
      const w = this.row(listed.symbol); if (!w) continue;
      const c = this.db.prepare("SELECT * FROM market_prices WHERE symbol = ? AND range = 'daily'").get(w.symbol) as any;
      const hadError = Boolean(c?.error);
      const lastBar = c?.series ? (JSON.parse(c.series) as Bar[]).at(-1)?.date ?? null : null;
      if (!force && !needsRefresh(w.instrument_type, { fetchedAt: c?.fetched_at ?? null, lastBarDate: lastBar, hadError }, now)) continue;
      if (force && c && now - c.fetched_at < 60_000) continue;
      const key = MarketService.mappingKey(w); // captured before the request
      const current = () => { const n = this.row(w.symbol); return n !== undefined && MarketService.mappingKey(n) === key; };
      try {
        const s = await this.provider.dailySeries(w.provider_symbol || w.symbol, HISTORY_DAYS);
        if (!current()) { this.rerun = true; continue; } // remapped or removed while in flight: this answer belongs to a different instrument
        const ch = changesFromBars(s.bars).find((r) => r.range === '1D');
        const last = s.bars[s.bars.length - 1];
        put.run(w.symbol, Date.now(), last.close, ch?.change ?? null, ch?.pct ?? null, last.date, w.instrument_type === 'mutual_fund' ? 1 : 0, JSON.stringify(s.bars), null);
      } catch (e) {
        // Our shared limiter deferred this call: nothing was sent, so nothing is recorded (cached prices and their timestamps stay as they were) and the
        // rest of the run is skipped. The next user-triggered refresh after the window tries again; no timer is set.
        if (e instanceof ProviderError && e.kind === 'rate_limit' && e.retryAfterMs !== undefined) { this.deferredUntil = Date.now() + e.retryAfterMs; break; }
        if (!current()) { this.rerun = true; continue; }
        const msg = (e as Error).message;
        put.run(w.symbol, Date.now(), null, null, null, null, w.instrument_type === 'mutual_fund' ? 1 : 0, null, msg);
        if (e instanceof ProviderError && (e.kind === 'rate_limit' || e.kind === 'no_key')) break;
      }
    }
  }

  lastFetch(): number | null {
    return (this.db.prepare("SELECT MAX(fetched_at) m FROM market_prices WHERE error IS NULL").get() as any).m ?? null;
  }
}

import type { DB } from '../db.js';
import { needsRefresh } from './schedule.js';
import { ProviderError, type Bar, type InstrumentType, type MarketProvider } from './provider.js';

export type Range = '1D' | '1W' | '1M' | 'YTD' | '1Y';
export const RANGES: Range[] = ['1D', '1W', '1M', 'YTD', '1Y'];
const HISTORY_DAYS = 260;

export interface RangeChange { range: Range; change: number; pct: number }
export interface QuoteDto {
  symbol: string; name: string; type: InstrumentType; providerSymbol: string;
  last: number | null; asOf: string | null; fetchedAt: number | null; isDailyNav: boolean; isMoneyMarket: boolean;
  changes: RangeChange[]; error: string | null; errorKind: string | null;
  note: string | null;
}

export function changesFromBars(bars: Bar[]): RangeChange[] {
  if (bars.length < 2) return [];
  const last = bars[bars.length - 1];
  const out: RangeChange[] = [];
  const back = (n: number) => bars[Math.max(0, bars.length - 1 - n)];
  const targets: [Range, Bar][] = [['1D', back(1)], ['1W', back(5)], ['1M', back(21)], ['1Y', bars[0]]];
  const ytdBase = [...bars].reverse().find((b) => b.date < `${last.date.slice(0, 4)}-01-01`);
  if (ytdBase) targets.splice(3, 0, ['YTD', ytdBase]);
  for (const [range, base] of targets) {
    if (base === last || !base.close) continue;
    if (range === '1Y' && bars.length < 200) continue; // not enough history to claim a year
    out.push({ range, change: last.close - base.close, pct: ((last.close - base.close) / base.close) * 100 });
  }
  return out;
}

export function sliceRange(bars: Bar[], range: Range): Bar[] {
  if (!bars.length) return [];
  const n = { '1D': 5, '1W': 6, '1M': 22, '1Y': HISTORY_DAYS, YTD: 0 }[range];
  if (range === 'YTD') {
    const year = bars[bars.length - 1].date.slice(0, 4);
    const base = [...bars].reverse().find((b) => b.date < `${year}-01-01`);
    return bars.filter((b) => b.date >= `${year}-01-01` || b === base);
  }
  return bars.slice(-n);
}

export class MarketService {
  private inflight: Promise<void> | null = null;
  constructor(private db: DB, private provider: MarketProvider) {}

  get providerInfo() { return { name: this.provider.name, configured: this.provider.configured }; }

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
        isMoneyMarket: isMM, changes: changesFromBars(bars), error: last ? (errorKind === 'no_key' ? error : null) : error, errorKind,
        note: isMM ? 'Stable NAV (typically $1.00). Yield is a separate figure and is not shown here.' : isNav ? 'Daily published NAV, not an intraday quote.' : null,
      };
    });
  }

  series(symbol: string, range: Range): { symbol: string; range: Range; bars: Bar[] } {
    const c = this.db.prepare("SELECT series FROM market_prices WHERE symbol = ? AND range = 'daily'").get(symbol) as any;
    const bars: Bar[] = c?.series ? JSON.parse(c.series) : [];
    return { symbol, range, bars: sliceRange(bars, range) };
  }

  /** Refreshes only instruments whose schedule says new data should exist. Serial, spaced to respect per-minute limits. */
  refreshIfNeeded(force = false): Promise<void> {
    if (!this.provider.configured) return Promise.resolve();
    if (this.inflight) return this.inflight;
    this.inflight = this.run(force).finally(() => { this.inflight = null; });
    return this.inflight;
  }
  get running() { return this.inflight !== null; }

  private async run(force: boolean) {
    const now = Date.now();
    const cached = new Map((this.db.prepare("SELECT * FROM market_prices WHERE range = 'daily'").all() as any[]).map((r) => [r.symbol, r]));
    const put = this.db.prepare(`INSERT INTO market_prices (symbol, range, fetched_at, last_value, change_abs, change_pct, as_of, is_daily_nav, series, error)
      VALUES (?, 'daily', ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(symbol, range) DO UPDATE SET fetched_at=excluded.fetched_at, last_value=excluded.last_value,
      change_abs=excluded.change_abs, change_pct=excluded.change_pct, as_of=excluded.as_of, is_daily_nav=excluded.is_daily_nav, series=COALESCE(excluded.series, market_prices.series), error=excluded.error`);
    let calls = 0;
    for (const w of this.rows()) {
      const c = cached.get(w.symbol);
      const hadError = Boolean(c?.error);
      const lastBar = c?.series ? (JSON.parse(c.series) as Bar[]).at(-1)?.date ?? null : null;
      if (!force && !needsRefresh(w.instrument_type, { fetchedAt: c?.fetched_at ?? null, lastBarDate: lastBar, hadError }, now)) continue;
      if (force && c && now - c.fetched_at < 60_000) continue;
      if (calls >= 7) break; // stay under the 8 credits/minute free tier; the rest refresh on the next request
      calls++;
      try {
        const s = await this.provider.dailySeries(w.provider_symbol || w.symbol, HISTORY_DAYS);
        const ch = changesFromBars(s.bars).find((r) => r.range === '1D');
        const last = s.bars[s.bars.length - 1];
        put.run(w.symbol, Date.now(), last.close, ch?.change ?? null, ch?.pct ?? null, last.date, w.instrument_type === 'mutual_fund' ? 1 : 0, JSON.stringify(s.bars), null);
      } catch (e) {
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

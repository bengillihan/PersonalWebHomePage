import type { DB } from '../db.js';
import { getSetting, setSetting } from '../db.js';
import { FetchError, safeFetch } from '../net/safeFetch.js';

export type InstrumentType = 'equity' | 'etf' | 'mutual_fund' | 'index';
export interface Bar { date: string; close: number }
export interface Series { symbol: string; currency: string | null; type: string | null; bars: Bar[] /* ascending */ }
export interface SymbolMatch { symbol: string; name: string; exchange: string | null; type: InstrumentType | null; currency: string | null }

export class ProviderError extends Error {
  /** `retryAfterMs` is set only when OUR limiter deferred the call (nothing was sent, nothing was spent); it is absent for a limit the provider reported. */
  constructor(message: string, public kind: 'no_key' | 'plan' | 'rate_limit' | 'not_found' | 'network' | 'bad_response', public retryAfterMs?: number) { super(message); }
}

/** Credits one Twelve Data call costs. Per its documentation /time_series and /symbol_search are 1 credit per request (per symbol); weights live here so a heavier endpoint is a one-line change. */
export const CREDIT_COST = { time_series: 1, symbol_search: 1 } as const;
export const DEFAULT_CREDITS_PER_MINUTE = 8; // Twelve Data Basic plan
const WINDOW_MS = 60_000;

export type Reservation = { ok: true } | { ok: false; retryAfterMs: number };

/**
 * ONE rolling-window credit limiter shared by every Twelve Data request (refreshes, searches, retries). Credits are reserved synchronously BEFORE the
 * request is sent, so concurrent callers cannot overshoot, and the log is kept in SQLite (application_settings) so a restart cannot forget what was spent
 * in the last minute. Nothing here schedules work: a deferred caller just learns when credits free up and the next user-triggered refresh tries again.
 */
export class CreditLimiter {
  constructor(private db: DB | null, public perMinute = DEFAULT_CREDITS_PER_MINUTE, private now: () => number = Date.now) {}
  private static KEY = 'twelvedata_credit_log';
  private load(): [number, number][] {
    const t = this.now();
    const log = this.db ? getSetting<[number, number][]>(this.db, CreditLimiter.KEY, []) : this.mem;
    return (Array.isArray(log) ? log : []).filter((e) => Array.isArray(e) && Number.isFinite(e[0]) && Number.isFinite(e[1]))
      .map(([ts, c]): [number, number] => [Math.min(ts, t), c]) // a clock that moved backwards cannot create credits out of thin air
      .filter(([ts]) => t - ts < WINDOW_MS);
  }
  private mem: [number, number][] = [];
  private save(log: [number, number][]) { if (this.db) setSetting(this.db, CreditLimiter.KEY, log); else this.mem = log; }
  /** Credits spent in the current window. */
  used(): number { return this.load().reduce((n, [, c]) => n + c, 0); }
  /** Atomically reserves `cost` credits, or says how long until that many are free. */
  reserve(cost: number): Reservation {
    const need = Math.min(Math.max(1, cost), this.perMinute); // a single call can never need more than the whole allowance
    const log = this.load(); const t = this.now();
    let used = log.reduce((n, [, c]) => n + c, 0);
    if (used + need <= this.perMinute) { log.push([t, need]); this.save(log); return { ok: true }; }
    for (const [ts, c] of [...log].sort((a, b) => a[0] - b[0])) { used -= c; if (used + need <= this.perMinute) return { ok: false, retryAfterMs: Math.max(1, ts + WINDOW_MS - t) }; }
    return { ok: false, retryAfterMs: WINDOW_MS };
  }
  /** The provider said it is rate limiting us (or reported fewer credits left than we think): treat the rest of the window as spent. */
  penalize(creditsLeft = 0): void {
    const log = this.load(); const t = this.now(); const used = log.reduce((n, [, c]) => n + c, 0); const target = this.perMinute - Math.max(0, creditsLeft);
    if (target > used) { log.push([t, target - used]); this.save(log); }
  }
}

export interface MarketProvider {
  readonly name: string;
  readonly configured: boolean;
  dailySeries(providerSymbol: string, days: number): Promise<Series>;
  search(query: string): Promise<SymbolMatch[]>;
}

export function mapInstrumentType(t: string | null | undefined): InstrumentType | null {
  const s = (t ?? '').toLowerCase();
  if (s.includes('mutual')) return 'mutual_fund';
  if (s === 'etf' || s.includes('exchange-traded') || s.includes('exchange traded')) return 'etf';
  if (s.includes('index')) return 'index';
  if (s.includes('stock') || s.includes('equity') || s.includes('adr') || s.includes('reit')) return 'equity';
  return null;
}

/** Parses a Twelve Data /time_series body. Throws ProviderError for documented error shapes. */
export function parseTwelveDataSeries(body: any, symbol: string): Series {
  if (!body || typeof body !== 'object') throw new ProviderError('Empty provider response', 'bad_response');
  if (body.status === 'error') {
    const code = Number(body.code);
    const msg = String(body.message ?? 'Provider error').slice(0, 240);
    if (code === 429) throw new ProviderError('Provider rate limit reached; will retry later', 'rate_limit');
    if (code === 401) throw new ProviderError('Provider API key is invalid', 'no_key');
    if (code === 403 || /plan|upgrade|grow|pro\b/i.test(msg)) throw new ProviderError(`Not available on your provider plan: ${msg}`, 'plan');
    if (code === 404 || /not found|symbol/i.test(msg)) throw new ProviderError(`Symbol not found: ${msg}`, 'not_found');
    throw new ProviderError(msg, 'bad_response');
  }
  const values: any[] = body.values;
  if (!Array.isArray(values) || !values.length) throw new ProviderError('No price history returned', 'not_found');
  const bars: Bar[] = [];
  for (const v of values) {
    const close = Number(v.close);
    const date = String(v.datetime ?? '').slice(0, 10);
    if (Number.isFinite(close) && /^\d{4}-\d{2}-\d{2}$/.test(date)) bars.push({ date, close });
  }
  if (!bars.length) throw new ProviderError('Price history had no valid rows', 'bad_response');
  bars.sort((a, b) => a.date.localeCompare(b.date));
  return { symbol, currency: body.meta?.currency ?? null, type: body.meta?.type ?? null, bars };
}

export function createTwelveData(apiKey: string, base = 'https://api.twelvedata.com', fetchOpts: { allowPrivate?: boolean } = {}, limiter: CreditLimiter = new CreditLimiter(null)): MarketProvider {
  const get = async (path: string, params: Record<string, string>, cost: number) => {
    const u = new URL(base + path);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    u.searchParams.set('apikey', apiKey);
    // Every HTTP attempt, including the one retry, reserves credits first and is deferred (not sent) when the allowance is used up.
    let lastErr: Error | null = null;
    for (let attempt = 0; ; attempt++) {
      const r = limiter.reserve(cost);
      if (!r.ok && lastErr) throw new ProviderError(`Market data request failed: ${lastErr.message.replace(apiKey, '***')}`, 'network'); // the retry could not be afforded: report the real failure, not a deferral
      if (!r.ok) throw new ProviderError(`Market data rate limit (${limiter.perMinute} credits/minute) reached; deferred ${Math.ceil(r.retryAfterMs / 1000)}s`, 'rate_limit', r.retryAfterMs);
      try {
        const res = await safeFetch(u.toString(), { timeoutMs: 10_000, maxBytes: 1_500_000, ...fetchOpts });
        const left = Number(res.headers['api-credits-left']); if (Number.isFinite(left) && res.headers['api-credits-left'] !== undefined) limiter.penalize(left); // sync with what the provider says remains
        if (res.status === 429) { limiter.penalize(0); throw new ProviderError('Provider rate limit reached; will retry later', 'rate_limit'); }
        if (res.status >= 500) throw new FetchError(`HTTP ${res.status}`, 'http_error', res.status);
        const body = JSON.parse(res.text()); if (body?.code === 429) limiter.penalize(0); return body;
      } catch (e) {
        if (e instanceof ProviderError) throw e;
        const code = (e as FetchError).code;
        const transient = !['blocked_ip', 'blocked_host', 'blocked_port', 'invalid_url', 'invalid_scheme', 'too_large', 'too_many_redirects'].includes(code) && !(e instanceof SyntaxError);
        if (transient && attempt === 0) { lastErr = e as Error; continue; }
        // never echo the URL: it contains the API key
        throw new ProviderError(`Market data request failed: ${(e as Error).message.replace(apiKey, '***')}`, 'network');
      }
    }
  };
  return {
    name: 'Twelve Data',
    configured: Boolean(apiKey),
    async dailySeries(symbol, days) {
      if (!apiKey) throw new ProviderError('No market data API key configured', 'no_key');
      const body = await get('/time_series', { symbol, interval: '1day', outputsize: String(days), order: 'desc' }, CREDIT_COST.time_series);
      return parseTwelveDataSeries(body, symbol);
    },
    async search(q) {
      if (!apiKey) throw new ProviderError('No market data API key configured', 'no_key');
      const body = await get('/symbol_search', { symbol: q, outputsize: '12' }, CREDIT_COST.symbol_search);
      if (body?.status === 'error') parseTwelveDataSeries(body, q);
      return (body?.data ?? []).map((d: any) => ({ symbol: String(d.symbol), name: String(d.instrument_name ?? d.symbol), exchange: d.exchange ?? null, type: mapInstrumentType(d.instrument_type), currency: d.currency ?? null }));
    },
  };
}

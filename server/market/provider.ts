import { fetchWithRetry } from '../net/safeFetch.js';

export type InstrumentType = 'equity' | 'etf' | 'mutual_fund' | 'index';
export interface Bar { date: string; close: number }
export interface Series { symbol: string; currency: string | null; type: string | null; bars: Bar[] /* ascending */ }
export interface SymbolMatch { symbol: string; name: string; exchange: string | null; type: InstrumentType | null; currency: string | null }

export class ProviderError extends Error {
  constructor(message: string, public kind: 'no_key' | 'plan' | 'rate_limit' | 'not_found' | 'network' | 'bad_response') { super(message); }
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

export function createTwelveData(apiKey: string, base = 'https://api.twelvedata.com', fetchOpts: { allowPrivate?: boolean } = {}): MarketProvider {
  const get = async (path: string, params: Record<string, string>) => {
    const u = new URL(base + path);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    u.searchParams.set('apikey', apiKey);
    try {
      const res = await fetchWithRetry(u.toString(), { timeoutMs: 10_000, maxBytes: 1_500_000, retries: 1, ...fetchOpts });
      return JSON.parse(res.text());
    } catch (e) {
      // never echo the URL: it contains the API key
      throw new ProviderError(`Market data request failed: ${(e as Error).message.replace(apiKey, '***')}`, 'network');
    }
  };
  return {
    name: 'Twelve Data',
    configured: Boolean(apiKey),
    async dailySeries(symbol, days) {
      if (!apiKey) throw new ProviderError('No market data API key configured', 'no_key');
      const body = await get('/time_series', { symbol, interval: '1day', outputsize: String(days), order: 'desc' });
      return parseTwelveDataSeries(body, symbol);
    },
    async search(q) {
      if (!apiKey) throw new ProviderError('No market data API key configured', 'no_key');
      const body = await get('/symbol_search', { symbol: q, outputsize: '12' });
      if (body?.status === 'error') parseTwelveDataSeries(body, q);
      return (body?.data ?? []).map((d: any) => ({ symbol: String(d.symbol), name: String(d.instrument_name ?? d.symbol), exchange: d.exchange ?? null, type: mapInstrumentType(d.instrument_type), currency: d.currency ?? null }));
    },
  };
}

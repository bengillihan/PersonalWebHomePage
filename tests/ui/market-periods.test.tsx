// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import Market from '../../web/src/components/Market';

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const range = (r: string, available: boolean, change: number | null = null, from: string | null = null) => ({ range: r, available, reason: available ? null : 'Not enough history', fromDate: from, toDate: available ? '2026-10-28' : null, change, pct: change === null ? null : change });
const quote = (symbol: string, over: Record<string, unknown> = {}) => ({
  symbol, name: symbol, type: 'etf', providerSymbol: symbol, last: 51, asOf: '2026-10-28', fetchedAt: Date.now(), isDailyNav: false, isMoneyMarket: false,
  changes: [{ range: '1D', change: 1, pct: 2 }], ranges: [range('1D', true, 1, '2026-10-27'), range('1W', false), range('1M', false), range('YTD', false), range('1Y', false)],
  changeKind: 'price', includesDistributions: false, error: null, errorKind: null, note: null, ...over,
});
const series = (over: Record<string, unknown> = {}) => ({ symbol: 'NEW', range: '1D', bars: [{ date: '2026-10-27', close: 50 }, { date: '2026-10-28', close: 51 }], available: true, reason: null, fromDate: '2026-10-27', toDate: '2026-10-28', change: 1, pct: 2, kind: 'price',
  basis: 'Latest daily close vs the previous daily close (daily data only; no intraday data).', disclaimer: 'Price change only: excludes dividends and distributions; not total return.', ...over });
let quotes: any[]; let requested: string[];

beforeEach(() => {
  requested = []; quotes = [quote('NEW')];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (url === '/api/market') return json({ provider: { name: 'Twelve Data', configured: true }, quotes, lastFetchedAt: Date.now(), refreshing: false });
    if (url.startsWith('/api/market/series')) { requested.push(url); const r = new URL('http://x' + url).searchParams.get('range')!; return json(r === '1D' ? series() : series({ range: r, bars: [], available: false, reason: 'Not enough history', change: null, pct: null, fromDate: null, toDate: null, basis: 'Not enough history' })); }
    return json({ error: 'unexpected ' + url }, 500);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const open = async (symbol = 'NEW') => { render(<Market version={0} onOpenSettings={() => {}} />); fireEvent.click(await screen.findByRole('button', { name: new RegExp(symbol) })); };

describe('market chart periods', () => {
  it('REGRESSION: the 1D view says it compares daily closes (not intraday) and labels the figure as a price change, not a total return', async () => {
    await open(); fireEvent.click(await screen.findByRole('tab', { name: '1D' }));
    expect(await screen.findByText(/Price change over 1D: \+1\.00 \(\+2\.00%\)/)).toBeTruthy();
    expect(screen.getByText(/Latest daily close vs the previous daily close/)).toBeTruthy(); expect(screen.getByText(/no intraday data/)).toBeTruthy();
    expect(screen.getByText(/not total return/)).toBeTruthy(); expect(screen.getByRole('img').getAttribute('aria-label')).toBe('NEW daily close chart for 1D');
  });

  it('REGRESSION: a period the history cannot support shows "Not enough history", no chart and no return, and its tab is marked', async () => {
    await open();
    expect(screen.getByRole('tab', { name: '1M' }).getAttribute('title')).toBe('Not enough history'); expect(screen.getByRole('tab', { name: '1D' }).getAttribute('title')).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: '1Y' }));
    expect((await screen.findByRole('status')).textContent).toMatch(/Not enough history for 1Y/); expect(screen.queryByRole('img')).toBeNull(); expect(screen.queryByText(/Price change over 1Y/)).toBeNull();
  });

  it('mutual funds are labelled NAV, compared with the previous published NAV, and not as intraday movement', async () => {
    quotes = [quote('VTWAX', { type: 'mutual_fund', isDailyNav: true, changeKind: 'nav', note: 'Daily published NAV, not an intraday quote.' })];
    (fetch as any).mockImplementation(async (url: string) => url === '/api/market' ? json({ provider: { name: 'Twelve Data', configured: true }, quotes, lastFetchedAt: 1, refreshing: false })
      : json(series({ symbol: 'VTWAX', kind: 'nav', basis: 'Latest published NAV vs the previous published NAV (daily data; no intraday movement).', disclaimer: 'NAV change only: excludes distributions that a total return would add back; not total return.' })));
    await open('VTWAX'); fireEvent.click(await screen.findByRole('tab', { name: '1D' }));
    expect(await screen.findByText(/NAV change over 1D/)).toBeTruthy(); expect(screen.getByText(/previous published NAV/)).toBeTruthy(); expect(screen.getByText(/NAV change only/)).toBeTruthy();
    expect(screen.getByTitle('1D: latest published NAV vs the previous published NAV')).toBeTruthy(); // the watchlist tile explains its figure too
  });

  it('every range switch is one request to cached data (no polling)', async () => {
    await open(); for (const r of ['1D', '1W', '1M']) fireEvent.click(screen.getByRole('tab', { name: r }));
    await waitFor(() => expect(requested.length).toBeGreaterThanOrEqual(3)); const n = requested.length; await new Promise((r) => setTimeout(r, 120)); expect(requested.length).toBe(n);
  });
});

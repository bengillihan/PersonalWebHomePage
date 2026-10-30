import { lazy, Suspense, useEffect, useState } from 'react';
import { api, timeAgo } from '../api';
import type { Quote } from '../types';

const Chart = lazy(() => import('./Chart'));
interface MarketResponse { provider: { name: string; configured: boolean }; quotes: Quote[]; lastFetchedAt: number | null; refreshing: boolean }
const RANGES = ['1D', '1W', '1M', 'YTD', '1Y'];
const fmt = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** `compact` shrinks the watchlist tiles for the newspaper Front Page; the chart panel still opens on click. */
export default function Market({ version, onOpenSettings, compact = false }: { version: number; onOpenSettings: (p: string) => void; compact?: boolean }) {
  const [data, setData] = useState<MarketResponse | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [range, setRange] = useState('1M');

  useEffect(() => {
    let live = true; let timer: ReturnType<typeof setTimeout>;
    const tick = async (n: number) => {
      try { const d = await api<MarketResponse>('/api/market'); if (!live) return; setData(d); if (d.refreshing && n < 10) timer = setTimeout(() => tick(n + 1), 4000); } catch { /* keep last */ }
    };
    void tick(0); return () => { live = false; clearTimeout(timer); };
  }, [version]);

  if (!data) return <div className="card flex gap-4 p-3">{[0, 1, 2, 3].map((i) => <div key={i} className="skeleton h-12 w-36" />)}</div>;
  const q = data.quotes.find((x) => x.symbol === sel);
  const noKey = !data.provider.configured;

  return (
    <section aria-label="Market watchlist" className={`card ${compact ? 'p-2' : 'p-3'}`}>
      <div className="flex items-center justify-between px-1 pb-2 text-xs text-slate-500">
        <span>Markets · {data.provider.name}{data.refreshing && ' · updating…'}</span>
        <span>{data.lastFetchedAt ? `prices fetched ${timeAgo(data.lastFetchedAt)}` : 'no prices yet'}</span>
      </div>
      {noKey && <p className="mb-2 rounded-lg bg-amber-50 p-2 text-sm text-amber-900 dark:bg-amber-900/30 dark:text-amber-100">No market data key configured, so no prices are shown. Set <code>TWELVEDATA_API_KEY</code> (see README). <button className="underline" onClick={() => onOpenSettings('watchlist')}>Edit watchlist</button></p>}
      <div className="flex gap-2 overflow-x-auto pb-1">
        {data.quotes.map((x) => {
          const d = x.changes.find((c) => c.range === '1D');
          const up = (d?.change ?? 0) >= 0;
          return (
            <button key={x.symbol} onClick={() => setSel(sel === x.symbol ? null : x.symbol)} aria-pressed={sel === x.symbol}
              className={`${compact ? 'min-w-[7.5rem] px-2 py-1' : 'min-w-[9.5rem] px-3 py-2'} flex-none rounded-xl border text-left transition ${sel === x.symbol ? 'border-indigo-500 bg-indigo-50 dark:bg-indigo-950/40' : 'border-slate-200 hover:bg-slate-50 dark:border-slate-800 dark:hover:bg-slate-800/60'}`}>
              <div className="flex items-baseline justify-between gap-2"><span className="text-sm font-semibold">{x.symbol}</span>{x.isDailyNav && <span className="text-[10px] uppercase tracking-wide text-slate-400">NAV</span>}</div>
              {x.last != null ? (<>
                <div className="text-base font-semibold tabular-nums">{fmt(x.last)}</div>
                {d && !x.isMoneyMarket ? <div title={x.isDailyNav ? '1D: latest published NAV vs the previous published NAV' : '1D: latest daily close vs the previous daily close'} className={`text-xs tabular-nums ${up ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>{up ? '▲' : '▼'} {fmt(Math.abs(d.change))} ({d.pct >= 0 ? '+' : ''}{d.pct.toFixed(2)}%)</div> : <div className="text-xs text-slate-400">{x.isMoneyMarket ? 'stable NAV' : '—'}</div>}
              </>) : <div className="mt-1 text-xs text-slate-500" title={x.error ?? ''}>{x.errorKind === 'plan' ? 'Not on your plan' : x.errorKind === 'no_key' ? 'No data source' : x.error ? 'Unavailable' : 'Loading…'}</div>}
            </button>
          );
        })}
      </div>
      {q && (
        <div className="mt-3 border-t border-slate-100 pt-3 dark:border-slate-800">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div><div className="font-semibold">{q.name}</div><div className="text-xs text-slate-500">{q.last != null ? `${q.isDailyNav ? 'Daily NAV' : 'Last close/price'} as of ${q.asOf}` : 'No data'}</div></div>
            <div className="flex gap-1" role="tablist">{RANGES.map((r) => { const ok = q.ranges.find((x) => x.range === r)?.available !== false; return <button key={r} role="tab" aria-selected={range === r} title={ok ? undefined : 'Not enough history'} className={`btn !py-1 text-xs ${range === r ? 'btn-primary' : 'btn-ghost'} ${!ok && range !== r ? 'opacity-50' : ''}`} onClick={() => setRange(r)}>{r}</button>; })}</div>
          </div>
          {q.note && <p className="mt-1 text-xs text-slate-500">{q.note}</p>}
          {q.error && q.last == null ? <p className="mt-2 text-sm text-amber-700 dark:text-amber-300">{q.error}. You can map this symbol to a different provider symbol in Settings → Watchlist.</p> : (
            <Suspense fallback={<div className="skeleton mt-2 h-36 w-full" />}><Chart symbol={q.symbol} range={range} /></Suspense>
          )}
        </div>
      )}
    </section>
  );
}

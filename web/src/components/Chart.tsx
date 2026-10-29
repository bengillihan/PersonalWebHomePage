import { useEffect, useState } from 'react';
import { api } from '../api';

interface Bar { date: string; close: number }
interface Series { bars: Bar[]; available: boolean; reason: string | null; change: number | null; pct: number | null; kind: 'price' | 'nav'; basis: string; disclaimer: string; fromDate: string | null; toDate: string | null }
const money = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** One period's chart. It spans exactly the period the return is calculated over, and says what is being compared and what is not included. */
export default function Chart({ symbol, range }: { symbol: string; range: string }) {
  const [s, setS] = useState<Series | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => { let live = true; setS(null); api<Series>(`/api/market/series?symbol=${encodeURIComponent(symbol)}&range=${range}`).then((r) => live && setS(r)).catch(() => live && setS(null)); return () => { live = false; }; }, [symbol, range]);
  if (!s) return <div className="skeleton mt-2 h-36 w-full" />;
  if (!s.available || s.bars.length < 2) return <p className="mt-2 rounded-lg bg-slate-50 p-3 text-sm text-slate-600 dark:bg-slate-800/60 dark:text-slate-300" role="status">{s.reason ?? 'Not enough history'} for {range}. A return is only shown when real history covers the whole period.</p>;
  const bars = s.bars; const W = 640, H = 150, P = 6;
  const lo = Math.min(...bars.map((b) => b.close)), hi = Math.max(...bars.map((b) => b.close)), span = hi - lo || 1;
  const x = (i: number) => P + (i / (bars.length - 1)) * (W - 2 * P), y = (v: number) => H - P - ((v - lo) / span) * (H - 2 * P);
  const path = bars.map((b, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(b.close).toFixed(1)}`).join('');
  const up = (s.change ?? 0) >= 0; const color = up ? '#059669' : '#e11d48';
  const h = hover != null ? bars[hover] : bars[bars.length - 1];
  const label = s.kind === 'nav' ? 'NAV change' : 'Price change';
  return (
    <div className="mt-2">
      <div className="flex flex-wrap justify-between gap-x-3 text-xs text-slate-500">
        <span>{h.date}</span><span className="tabular-nums font-medium text-slate-700 dark:text-slate-200">{money(h.close)}</span>
        <span className={up ? 'text-emerald-600' : 'text-rose-600'}>{label} over {range}: {s.change! >= 0 ? '+' : ''}{money(s.change!)} ({s.pct! >= 0 ? '+' : ''}{s.pct!.toFixed(2)}%)</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-36 w-full" role="img" aria-label={`${symbol} ${s.kind === 'nav' ? 'NAV' : 'daily close'} chart for ${range}`}
        onMouseMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); setHover(Math.min(bars.length - 1, Math.max(0, Math.round(((e.clientX - r.left) / r.width) * (bars.length - 1))))); }} onMouseLeave={() => setHover(null)}>
        <path d={`${path}L${x(bars.length - 1)},${H}L${x(0)},${H}Z`} fill={color} opacity="0.1" />
        <path d={path} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
        {bars.length <= 3 && bars.map((b, i) => <circle key={b.date} cx={x(i)} cy={y(b.close)} r="3.5" fill={color} />)}
        {hover != null && <circle cx={x(hover)} cy={y(bars[hover].close)} r="4" fill={color} />}
      </svg>
      <p className="text-xs text-slate-500">{s.basis}</p>
      <p className="text-[11px] text-slate-400">{s.disclaimer}</p>
    </div>
  );
}

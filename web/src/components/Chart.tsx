import { useEffect, useState } from 'react';
import { api } from '../api';

interface Bar { date: string; close: number }
export default function Chart({ symbol, range, change }: { symbol: string; range: string; change?: { change: number; pct: number } }) {
  const [bars, setBars] = useState<Bar[] | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  useEffect(() => { let live = true; setBars(null); api<{ bars: Bar[] }>(`/api/market/series?symbol=${encodeURIComponent(symbol)}&range=${range}`).then((r) => live && setBars(r.bars)).catch(() => live && setBars([])); return () => { live = false; }; }, [symbol, range]);
  if (!bars) return <div className="skeleton mt-2 h-36 w-full" />;
  if (bars.length < 2) return <p className="mt-2 text-sm text-slate-500">Not enough history for this range.</p>;
  const W = 640, H = 150, P = 6;
  const lo = Math.min(...bars.map((b) => b.close)), hi = Math.max(...bars.map((b) => b.close)), span = hi - lo || 1;
  const x = (i: number) => P + (i / (bars.length - 1)) * (W - 2 * P), y = (v: number) => H - P - ((v - lo) / span) * (H - 2 * P);
  const path = bars.map((b, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(b.close).toFixed(1)}`).join('');
  const up = bars[bars.length - 1].close >= bars[0].close;
  const color = up ? '#059669' : '#e11d48';
  const h = hover != null ? bars[hover] : bars[bars.length - 1];
  return (
    <div className="mt-2">
      <div className="flex justify-between text-xs text-slate-500"><span>{h.date}</span><span className="tabular-nums font-medium text-slate-700 dark:text-slate-200">{h.close.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>{change && <span className={up ? 'text-emerald-600' : 'text-rose-600'}>{change.pct >= 0 ? '+' : ''}{change.pct.toFixed(2)}% over {range}</span>}</div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-36 w-full" role="img" aria-label={`${symbol} price chart for ${range}`}
        onMouseMove={(e) => { const r = e.currentTarget.getBoundingClientRect(); setHover(Math.min(bars.length - 1, Math.max(0, Math.round(((e.clientX - r.left) / r.width) * (bars.length - 1))))); }} onMouseLeave={() => setHover(null)}>
        <path d={`${path}L${x(bars.length - 1)},${H}L${x(0)},${H}Z`} fill={color} opacity="0.1" />
        <path d={path} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
        {hover != null && <circle cx={x(hover)} cy={y(bars[hover].close)} r="4" fill={color} />}
      </svg>
    </div>
  );
}

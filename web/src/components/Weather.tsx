import { useEffect, useState } from 'react';
import { api, timeAgo } from '../api';
import type { WeatherLocation, WeatherView } from '../types';

const dayLabel = (date: string, i: number) => (i === 0 ? 'Today' : new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short' }));
const shortDate = (date: string) => new Date(`${date}T12:00:00`).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' });

export default function Weather({ version }: { version: number }) {
  const [w, setW] = useState<WeatherView | null>(null);
  const [failed, setFailed] = useState(false);
  const [editing, setEditing] = useState(false);
  const [q, setQ] = useState(''); const [results, setResults] = useState<WeatherLocation[] | null>(null);
  const [msg, setMsg] = useState<string | null>(null); const [busy, setBusy] = useState(false);

  // One load per visit/refresh. Only while a first fetch is still running do we re-check a few times (user-initiated, bounded).
  useEffect(() => {
    let live = true; let timer: ReturnType<typeof setTimeout>;
    const load = async (n: number) => {
      try { const r = await api<WeatherView>('/api/weather'); if (!live) return; setW(r); setFailed(false); if (r.refreshing && !r.forecast && n < 5) timer = setTimeout(() => load(n + 1), 3000); }
      catch { if (live) setFailed(true); }
    };
    void load(0); return () => { live = false; clearTimeout(timer); };
  }, [version]);

  const search = async () => {
    setBusy(true); setMsg(null); setResults(null);
    try { const r = await api<WeatherLocation[]>(`/api/weather/search?q=${encodeURIComponent(q.trim())}`); setResults(r); if (!r.length) setMsg('No matches. Try a 5-digit US ZIP or a city name.'); }
    catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };
  const choose = async (loc: WeatherLocation) => {
    setBusy(true); setMsg(null);
    try { setW(await api<WeatherView>('/api/weather/location', { method: 'PUT', body: loc.zip ? { zip: loc.zip } : { label: loc.label, lat: loc.lat, lon: loc.lon } })); setEditing(false); setQ(''); setResults(null); }
    catch (e) { setMsg((e as Error).message); } finally { setBusy(false); }
  };

  if (!w) return failed ? null : <div className="card flex gap-3 p-3">{[0, 1, 2, 3, 4].map((i) => <div key={i} className="skeleton h-16 flex-1" />)}</div>;
  const f = w.forecast;

  return (
    <section aria-label="5-day weather forecast" className="card p-3">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-1 pb-2 text-xs text-slate-500">
        <span className="min-w-0 truncate"><b className="font-semibold text-slate-700 dark:text-slate-200">{w.location.label}</b>
          {f && <> · <span className="text-sm font-semibold text-slate-800 dark:text-slate-100">{f.current.icon} {f.current.tempF}°F</span> {f.current.description}</>}</span>
        <span className="flex items-center gap-2">
          {w.fetchedAt ? `updated ${timeAgo(w.fetchedAt)}` : w.refreshing ? 'loading…' : 'no data yet'}
          <button className="underline hover:text-slate-700 dark:hover:text-slate-200" onClick={() => setEditing(!editing)} aria-expanded={editing}>Change location</button>
        </span>
      </div>

      {editing && (
        <div className="mb-2 rounded-lg bg-slate-50 p-2 dark:bg-slate-800/60">
          <div className="flex gap-2"><input className="input !py-1.5" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && q.trim().length >= 2 && search()} placeholder="ZIP code or city (e.g. 98198, Tacoma, WA)" aria-label="Weather location" />
            <button className="btn btn-primary" disabled={busy || q.trim().length < 2} onClick={search}>Search</button></div>
          {msg && <p className="mt-1.5 text-sm text-amber-700 dark:text-amber-300" role="alert">{msg}</p>}
          {results && results.length > 0 && <ul className="mt-1.5 divide-y divide-slate-200 text-sm dark:divide-slate-700">{results.map((r) => <li key={`${r.lat},${r.lon}`}><button className="w-full py-1.5 text-left hover:text-indigo-600 dark:hover:text-indigo-400" disabled={busy} onClick={() => choose(r)}>{r.label}</button></li>)}</ul>}
        </div>
      )}

      {f ? (
        <div className="flex gap-2 overflow-x-auto pb-1 sm:grid sm:grid-cols-5 sm:overflow-visible">
          {f.days.map((d, i) => (
            <div key={d.date} className="min-w-[6.5rem] flex-none rounded-xl border border-slate-200 px-2.5 py-2 text-center dark:border-slate-800 sm:min-w-0" title={`${d.description}${d.precipPct != null ? `, ${d.precipPct}% chance of precipitation` : ''}`}>
              <div className="text-sm font-semibold">{dayLabel(d.date, i)} <span className="text-xs font-normal text-slate-400">{shortDate(d.date)}</span></div>
              <div className="text-2xl leading-8" aria-hidden>{d.icon}</div>
              <div className="text-sm tabular-nums"><b>{d.highF}°</b> <span className="text-slate-500">{d.lowF}°</span></div>
              <div className="text-xs text-sky-700 tabular-nums dark:text-sky-300">💧 {d.precipPct != null ? `${d.precipPct}%` : '—'}</div>
              <div className="truncate text-xs text-slate-500">{d.description}</div>
            </div>
          ))}
        </div>
      ) : (
        <p className="rounded-lg bg-amber-50 p-2 text-sm text-amber-900 dark:bg-amber-900/30 dark:text-amber-100">{w.refreshing ? 'Fetching the forecast…' : `Weather is unavailable${w.error ? `: ${w.error}` : ''}. It will retry the next time you open the dashboard.`}</p>
      )}
      {f && w.error && <p className="mt-1.5 px-1 text-xs text-amber-700 dark:text-amber-300">Couldn’t refresh just now ({w.error}); showing the last successful forecast{w.fetchedAt ? ` from ${timeAgo(w.fetchedAt)}` : ''}.</p>}
      <p className="mt-1.5 px-1 text-[11px] text-slate-400">{w.attribution.map((a, i) => <span key={a.url}>{i > 0 && ' · '}<a className="underline hover:text-slate-600" href={a.url} target="_blank" rel="noopener noreferrer">{a.text}</a></span>)}</p>
    </section>
  );
}

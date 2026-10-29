import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { api, ApiError, fullDate, timeAgo } from '../api';
import type { Prefs, Quote, Source, Story, Topic } from '../types';
import StoryCard from './StoryCard';

export const PANELS: [string, string][] = [['sources', 'Sources'], ['interests', 'Interests'], ['watchlist', 'Watchlist'], ['saved', 'Saved'], ['preferences', 'Preferences'], ['diagnostics', 'Diagnostics']];

const Field = ({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) => (
  <label className="block text-sm"><span className="mb-1 block font-medium">{label}</span>{children}{hint && <span className="mt-1 block text-xs text-slate-500">{hint}</span>}</label>
);
const csv = (s: string) => s.split(',').map((x) => x.trim()).filter(Boolean);
const HEALTH: Record<string, string> = { ok: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-200', stale: 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200', error: 'bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-200', unknown: 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300', disabled: 'bg-slate-200 text-slate-500 dark:bg-slate-700 dark:text-slate-400' };
const healthLabel = (h: string) => ({ ok: 'healthy', unknown: 'not checked yet' } as Record<string, string>)[h] ?? h;

export default function Settings({ panel, setPanel, onClose, onChanged, onTheme }: { panel: string; setPanel: (p: string) => void; onClose: () => void; onChanged: () => void; onTheme: (t: Prefs['theme']) => void }) {
  return (
    <div className="fixed inset-0 z-40 flex bg-slate-900/50" role="dialog" aria-modal="true" aria-label="Settings" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="m-0 flex h-full w-full flex-col bg-slate-50 dark:bg-slate-950 sm:m-4 sm:mx-auto sm:max-w-5xl sm:rounded-2xl sm:shadow-2xl">
        <header className="flex items-center justify-between border-b border-slate-200 px-4 py-3 dark:border-slate-800">
          <h2 className="text-lg font-semibold">Settings</h2><button className="btn btn-ghost" onClick={onClose} aria-label="Close settings">✕ Close</button>
        </header>
        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          <nav className="flex gap-1 overflow-x-auto border-b border-slate-200 p-2 dark:border-slate-800 sm:w-44 sm:flex-col sm:border-b-0 sm:border-r" aria-label="Settings sections">
            {PANELS.map(([k, l]) => <button key={k} className={`btn justify-start whitespace-nowrap ${panel === k ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setPanel(k)}>{l}</button>)}
          </nav>
          <div className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
            {panel === 'sources' && <Sources onChanged={onChanged} />}
            {panel === 'interests' && <Interests onChanged={onChanged} />}
            {panel === 'watchlist' && <Watchlist onChanged={onChanged} />}
            {panel === 'saved' && <Saved />}
            {panel === 'preferences' && <Preferences onChanged={onChanged} onTheme={onTheme} />}
            {panel === 'diagnostics' && <Diagnostics />}
          </div>
        </div>
      </div>
    </div>
  );
}

function useLoad<T>(path: string) {
  const [data, setData] = useState<T | null>(null); const [err, setErr] = useState<string | null>(null);
  const reload = useCallback(() => api<T>(path).then((d) => { setData(d); setErr(null); }).catch((e) => setErr(e.message)), [path]);
  useEffect(() => { void reload(); }, [reload]);
  return { data, err, reload };
}

/* ---------------- Sources ---------------- */
function Sources({ onChanged }: { onChanged: () => void }) {
  const { data, err, reload } = useLoad<Source[]>('/api/sources');
  const [url, setUrl] = useState(''); const [busy, setBusy] = useState(false); const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string; agg?: boolean } | null>(null);
  const [disc, setDisc] = useState<any>(null);
  const add = async (opts: { aggregator?: boolean; feedUrl?: string } = {}) => {
    setBusy(true); setMsg(null);
    try { await api('/api/sources', { method: 'POST', body: { url, ...opts } }); setMsg({ kind: 'ok', text: 'Source added. Fetching in the background…' }); setUrl(''); setDisc(null); await reload(); onChanged(); }
    catch (e) { const b = (e as ApiError).body; setMsg({ kind: 'err', text: (e as Error).message, agg: b?.aggregatorAvailable }); if (b?.discovery) setDisc(b.discovery); }
    finally { setBusy(false); }
  };
  const discover = async () => { setBusy(true); setMsg(null); try { setDisc(await api('/api/sources/discover', { method: 'POST', body: { url } })); } catch (e) { setMsg({ kind: 'err', text: (e as Error).message }); } finally { setBusy(false); } };
  const patch = async (id: number, body: object) => { await api(`/api/sources/${id}`, { method: 'PATCH', body }); await reload(); onChanged(); };
  return (
    <div className="space-y-5">
      <div><h3 className="text-base font-semibold">Sources</h3><p className="text-sm text-slate-500">Publisher RSS/Atom feeds are preferred. A feed that is dead or stale is flagged, never treated as working.</p></div>
      <div className="card space-y-3 p-4">
        <Field label="Add a website or feed URL"><div className="flex gap-2"><input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://example.com" inputMode="url" /><button className="btn btn-outline" disabled={!url || busy} onClick={discover}>Find feeds</button><button className="btn btn-primary" disabled={!url || busy} onClick={() => add()}>Add</button></div></Field>
        {msg && <div className={`rounded-lg p-2.5 text-sm ${msg.kind === 'ok' ? 'bg-emerald-50 text-emerald-900 dark:bg-emerald-900/30 dark:text-emerald-100' : 'bg-amber-50 text-amber-900 dark:bg-amber-900/30 dark:text-amber-100'}`} role="status">{msg.text}{msg.agg && <div className="mt-2"><button className="btn btn-outline" onClick={() => add({ aggregator: true })}>Add via Google News aggregator (labeled, source-restricted)</button></div>}</div>}
        {disc && (<div className="text-sm"><p className="font-medium">{disc.candidates.length ? 'Feeds found:' : 'No feeds found.'}</p>
          <ul className="mt-1 space-y-1">{disc.candidates.map((c: any) => <li key={c.feedUrl} className="flex flex-wrap items-center gap-2"><span className={`chip ${HEALTH[c.freshness.status]}`}>{c.freshness.status}</span><span className="break-all">{c.title || c.feedUrl}</span><span className="text-xs text-slate-500">{c.itemCount} items{c.freshness.reason ? ` · ${c.freshness.reason}` : ''}</span>{c.freshness.status === 'ok' && <button className="btn btn-outline !py-0.5 text-xs" onClick={() => add({ feedUrl: c.feedUrl })}>Use this feed</button>}</li>)}</ul>
          {disc.rejected?.length > 0 && <details className="mt-2 text-xs text-slate-500"><summary>Checked but unusable ({disc.rejected.length})</summary><ul className="mt-1">{disc.rejected.map((r: any) => <li key={r.feedUrl} className="break-all">{r.feedUrl} — {r.reason}</li>)}</ul></details>}</div>)}
      </div>
      {err && <p className="text-sm text-red-600">{err}</p>}
      {data?.map((s) => (
        <div key={s.id} className={`card space-y-3 p-4 ${s.enabled ? '' : 'opacity-60'}`}>
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0"><div className="flex flex-wrap items-center gap-2"><span className="font-semibold">{s.name}</span><span className={`chip ${HEALTH[s.health]}`}>{healthLabel(s.health)}</span>{s.kind === 'aggregator' && <span className="chip">Aggregator</span>}{s.isLocal && <span className="chip">Local</span>}</div>
              <a className="break-all text-xs text-indigo-700 hover:underline dark:text-indigo-300" href={s.siteUrl} target="_blank" rel="noopener noreferrer">{s.siteUrl}</a>
              <div className="break-all text-xs text-slate-500">{s.kind === 'rss' ? `Feed: ${s.feedUrl}` : s.aggregatorLabel}</div></div>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={s.enabled} onChange={(e) => patch(s.id, { enabled: e.target.checked })} />Enabled</label>
          </div>
          <div className="grid gap-x-4 gap-y-1 text-xs text-slate-500 sm:grid-cols-3"><span>Last check: {timeAgo(s.lastCheckedAt)}</span><span>Last successful import: {timeAgo(s.lastSuccessAt)}</span><span>Newest item: {s.lastItemAt ? fullDate(s.lastItemAt) : '—'}</span><span>{s.articleCount} articles stored</span></div>
          {s.lastError && <p className="rounded-lg bg-rose-50 p-2 text-sm text-rose-900 dark:bg-rose-900/30 dark:text-rose-100">{s.lastError}</p>}
          {s.statusReason && <p className="rounded-lg bg-amber-50 p-2 text-sm text-amber-900 dark:bg-amber-900/30 dark:text-amber-100">{s.statusReason}</p>}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Priority"><select className="input" value={s.priority} onChange={(e) => patch(s.id, { priority: e.target.value })}><option value="high">High</option><option value="normal">Normal</option><option value="low">Low</option></select></Field>
            <Field label="Coverage" hint={s.coverage === 'interest' ? 'Shown only when a story matches one of your interests (and isn\u2019t blocked). Nothing is deleted.' : 'Every story can appear.'}><select className="input" value={s.coverage} onChange={(e) => patch(s.id, { coverage: e.target.value })}><option value="comprehensive">Comprehensive / top stories</option><option value="interest">Interest-only</option></select></Field>
            <Field label="Categories (hints, comma separated)" hint="Hints for AI. An interest-only source with exactly one category also uses it as the default."><input className="input" defaultValue={s.categories.join(', ')} onBlur={(e) => patch(s.id, { categories: csv(e.target.value) })} /></Field>
            <Field label="Expected to publish within (hours)" hint={`Default ${s.freshnessDefaultHours}h. Weekends don\u2019t count. Empty = default.`}><input className="input" type="number" min="1" max="336" defaultValue={s.freshnessHours ?? ''} placeholder={String(s.freshnessDefaultHours)} onBlur={(e) => { const v = e.target.value.trim(); const next = v === '' ? null : Number(v); if (next !== s.freshnessHours && (next === null || (Number.isInteger(next) && next >= 1 && next <= 336))) void patch(s.id, { freshnessHours: next }); }} /></Field>
          </div>
          <div className="flex flex-wrap gap-2"><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={s.isLocal} onChange={(e) => patch(s.id, { isLocal: e.target.checked })} />Treat as local news</label><span className="flex-1" />
            <button className="btn btn-outline" onClick={async () => { await api(`/api/sources/${s.id}/check`, { method: 'POST' }); await reload(); onChanged(); }}>Check now</button>
            <button className="btn btn-ghost !text-rose-600" onClick={async () => { if (confirm(`Delete ${s.name} and its stored articles?`)) { await api(`/api/sources/${s.id}`, { method: 'DELETE' }); await reload(); onChanged(); } }}>Delete</button></div>
        </div>
      ))}
    </div>
  );
}

/* ---------------- Interests ---------------- */
function Interests({ onChanged }: { onChanged: () => void }) {
  const { data, reload } = useLoad<Topic[]>('/api/topics');
  const blank = { name: '', kind: 'interest' as const, description: '', priority: 'normal' as const, include: '', exclude: '' };
  const [f, setF] = useState(blank); const [err, setErr] = useState<string | null>(null);
  const save = async () => { try { await api('/api/topics', { method: 'POST', body: { ...f, include: csv(f.include), exclude: csv(f.exclude) } }); setF(blank); setErr(null); await reload(); onChanged(); } catch (e) { setErr((e as Error).message); } };
  return (
    <div className="space-y-5">
      <div><h3 className="text-base font-semibold">Interests &amp; topics</h3><p className="text-sm text-slate-500">Describe what you care about in plain language (“older BMW E91 maintenance”, “not generic AI press releases”). Matching runs locally, so editing these never re-spends AI calls. Add a <i>category</i> to get its own tab.</p></div>
      <div className="card space-y-3 p-4">
        <div className="grid gap-3 sm:grid-cols-3"><Field label="Name"><input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></Field>
          <Field label="Type"><select className="input" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as any })}><option value="interest">Interest</option><option value="category">Category tab</option></select></Field>
          <Field label="Priority"><select className="input" value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value as any })}><option value="high">High</option><option value="normal">Normal</option><option value="low">Low</option></select></Field></div>
        <Field label="Describe it"><textarea className="input" rows={2} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} placeholder="new local AI hardware performance benchmarks, not generic AI press releases" /></Field>
        <div className="grid gap-3 sm:grid-cols-2"><Field label="Include keywords"><input className="input" value={f.include} onChange={(e) => setF({ ...f, include: e.target.value })} placeholder="E91, N52, valve cover" /></Field><Field label="Exclude keywords"><input className="input" value={f.exclude} onChange={(e) => setF({ ...f, exclude: e.target.value })} /></Field></div>
        {err && <p className="text-sm text-red-600">{err}</p>}<button className="btn btn-primary" disabled={!f.name} onClick={save}>Add</button>
      </div>
      {data?.map((t) => (
        <div key={t.id} className="card flex flex-wrap items-start justify-between gap-3 p-4">
          <div className="min-w-0"><div className="flex items-center gap-2"><span className="font-semibold">{t.name}</span><span className="chip">{t.kind}</span><span className="chip">{t.priority} priority</span></div>
            {t.description && <p className="mt-1 text-sm">{t.description}</p>}<p className="mt-1 text-xs text-slate-500">{t.include.length ? `Include: ${t.include.join(', ')}` : ''} {t.exclude.length ? `· Exclude: ${t.exclude.join(', ')}` : ''}</p></div>
          <div className="flex gap-2"><select className="input !w-auto" value={t.priority} onChange={async (e) => { await api(`/api/topics/${t.id}`, { method: 'PUT', body: { ...t, priority: e.target.value } }); await reload(); onChanged(); }}><option value="high">High</option><option value="normal">Normal</option><option value="low">Low</option></select>
            <button className="btn btn-ghost !text-rose-600" onClick={async () => { await api(`/api/topics/${t.id}`, { method: 'DELETE' }); await reload(); onChanged(); }}>Delete</button></div>
        </div>
      ))}
      {data?.length === 0 && <p className="text-sm text-slate-500">No interests yet. Without them “For You” leans on major stories, recency and your feedback.</p>}
    </div>
  );
}

/* ---------------- Watchlist ---------------- */
function Watchlist({ onChanged }: { onChanged: () => void }) {
  const { data, reload } = useLoad<{ id: number; symbol: string; name: string; type: Quote['type']; providerSymbol: string | null }[]>('/api/watchlist');
  const [q, setQ] = useState(''); const [res, setRes] = useState<any[] | null>(null); const [msg, setMsg] = useState<string | null>(null);
  const search = async () => { setMsg(null); try { setRes(await api(`/api/watchlist/search?q=${encodeURIComponent(q)}`)); } catch (e) { setRes(null); setMsg((e as Error).message + ' You can still add the symbol manually below.'); } };
  const add = async (symbol: string, name: string, type: string) => { try { await api('/api/watchlist', { method: 'POST', body: { symbol, name, type } }); setRes(null); setQ(''); await reload(); onChanged(); } catch (e) { setMsg((e as Error).message); } };
  const [manual, setManual] = useState({ symbol: '', name: '', type: 'etf' });
  return (
    <div className="space-y-5">
      <div><h3 className="text-base font-semibold">Watchlist</h3><p className="text-sm text-slate-500">Equities, ETFs, mutual funds and indexes. Mutual funds show the latest published daily NAV. Indexes may need a different provider symbol (for example an ETF proxy) depending on your data plan.</p></div>
      <div className="card space-y-3 p-4">
        <Field label="Symbol lookup"><div className="flex gap-2"><input className="input" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && search()} placeholder="VTSAX, AAPL, SPY…" /><button className="btn btn-primary" disabled={!q} onClick={search}>Search</button></div></Field>
        {msg && <p className="text-sm text-amber-700 dark:text-amber-300">{msg}</p>}
        {res && <ul className="divide-y divide-slate-100 text-sm dark:divide-slate-800">{res.length === 0 && <li>No matches.</li>}{res.map((r, i) => <li key={i} className="flex items-center justify-between gap-2 py-1.5"><span><b>{r.symbol}</b> {r.name} <span className="text-xs text-slate-500">{r.exchange} · {r.type ?? 'unknown type'}</span></span>{r.type && <button className="btn btn-outline !py-0.5 text-xs" onClick={() => add(r.symbol, r.name, r.type)}>Add</button>}</li>)}</ul>}
        <details><summary className="cursor-pointer text-sm text-slate-500">Add manually</summary><div className="mt-2 grid gap-2 sm:grid-cols-4"><input className="input" placeholder="Symbol" value={manual.symbol} onChange={(e) => setManual({ ...manual, symbol: e.target.value })} /><input className="input sm:col-span-2" placeholder="Name" value={manual.name} onChange={(e) => setManual({ ...manual, name: e.target.value })} /><select className="input" value={manual.type} onChange={(e) => setManual({ ...manual, type: e.target.value })}><option value="equity">Equity</option><option value="etf">ETF</option><option value="mutual_fund">Mutual fund</option><option value="index">Index</option></select></div><button className="btn btn-outline mt-2" disabled={!manual.symbol || !manual.name} onClick={() => add(manual.symbol, manual.name, manual.type)}>Add</button></details>
      </div>
      {data?.map((w) => (
        <div key={w.id} className="card flex flex-wrap items-center gap-3 p-3 text-sm">
          <b className="w-20">{w.symbol}</b><span className="min-w-0 flex-1 truncate">{w.name}</span><span className="chip">{w.type.replace('_', ' ')}</span>
          <input className="input !w-32" defaultValue={w.providerSymbol ?? ''} placeholder="provider symbol" title="Optional: symbol to request from the data provider" onBlur={async (e) => { if ((e.target.value || null) !== w.providerSymbol) { await api(`/api/watchlist/${w.id}`, { method: 'PATCH', body: { providerSymbol: e.target.value || null } }); onChanged(); } }} />
          <button className="btn btn-ghost !text-rose-600" onClick={async () => { await api(`/api/watchlist/${w.id}`, { method: 'DELETE' }); await reload(); onChanged(); }}>Remove</button>
        </div>
      ))}
    </div>
  );
}

/* ---------------- Saved ---------------- */
function Saved() {
  const [items, setItems] = useState<Story[] | null>(null);
  useEffect(() => { api<{ items: Story[] }>('/api/feed?tab=saved&limit=50').then((r) => setItems(r.items)).catch(() => setItems([])); }, []);
  if (!items) return <div className="skeleton h-24 w-full" />;
  return <div className="space-y-4"><h3 className="text-base font-semibold">Saved stories</h3>{items.length === 0 && <p className="text-sm text-slate-500">Nothing saved yet.</p>}
    {items.map((s) => <StoryCard key={s.id} story={s} showImages={false} onChange={(n) => setItems((p) => p!.map((x) => (x.id === n.id ? n : x)))} onGone={(id) => setItems((p) => p!.filter((x) => x.id !== id))} />)}</div>;
}

/* ---------------- Preferences ---------------- */
function Preferences({ onChanged, onTheme }: { onChanged: () => void; onTheme: (t: Prefs['theme']) => void }) {
  const { data, reload } = useLoad<{ prefs: Prefs; publishers: string[] }>('/api/prefs');
  const diag = useLoad<any>('/api/diagnostics');
  const [p, setP] = useState<Prefs | null>(null); const [saved, setSaved] = useState(false); const [budget, setBudget] = useState<number | null>(null);
  useEffect(() => { if (data) setP(data.prefs); }, [data]);
  useEffect(() => { if (diag.data) setBudget(diag.data.ai.dailyBudget); }, [diag.data]);
  if (!p || !data) return <div className="skeleton h-40 w-full" />;
  const num = (v: string) => Math.max(0, Math.min(1, Number(v) || 0));
  const save = async () => { await api('/api/prefs', { method: 'PUT', body: p }); setSaved(true); setTimeout(() => setSaved(false), 1500); await reload(); onChanged(); };
  const toggle = (k: 'preferredPublishers' | 'mutedPublishers', name: string) => setP({ ...p, [k]: p[k].includes(name) ? p[k].filter((x) => x !== name) : [...p[k], name] });
  return (
    <div className="space-y-5">
      <h3 className="text-base font-semibold">Preferences</h3>
      <div className="card p-4"><Field label="Appearance" hint="Saved to your account, so it follows you to your other devices."><select className="input !w-auto" value={p.theme ?? 'system'} onChange={(e) => { const theme = e.target.value as Prefs['theme']; setP({ ...p, theme }); onTheme(theme); }}><option value="system">Match my device</option><option value="light">Light</option><option value="dark">Dark</option></select></Field></div>
      <div className="card space-y-3 p-4"><h4 className="font-medium">Ranking weights (normalized automatically)</h4>
        <div className="grid gap-3 sm:grid-cols-5">{(Object.keys(p.weights) as (keyof Prefs['weights'])[]).map((k) => <Field key={k} label={k[0].toUpperCase() + k.slice(1)}><input className="input" type="number" step="0.05" min="0" max="1" value={p.weights[k]} onChange={(e) => setP({ ...p, weights: { ...p.weights, [k]: num(e.target.value) } })} /></Field>)}</div></div>
      <div className="card space-y-3 p-4"><h4 className="font-medium">“For You” mix (flexible; empty buckets never get filler)</h4>
        <div className="grid gap-3 sm:grid-cols-3">{(Object.keys(p.quotas) as (keyof Prefs['quotas'])[]).map((k) => <Field key={k} label={{ personalized: 'Personalized', major: 'Major national/world/business', local: 'Local / preferred sources' }[k]}><input className="input" type="number" step="0.05" min="0" max="1" value={p.quotas[k]} onChange={(e) => setP({ ...p, quotas: { ...p.quotas, [k]: num(e.target.value) } })} /></Field>)}</div></div>
      <div className="card space-y-3 p-4"><h4 className="font-medium">Publishers</h4>
        {data.publishers.length === 0 ? <p className="text-sm text-slate-500">Publishers appear after the first fetch.</p> : <div className="space-y-1">{data.publishers.map((n) => <div key={n} className="flex items-center gap-3 text-sm"><span className="flex-1 truncate">{n}</span><label className="flex items-center gap-1"><input type="checkbox" checked={p.preferredPublishers.includes(n)} onChange={() => toggle('preferredPublishers', n)} />Prefer</label><label className="flex items-center gap-1"><input type="checkbox" checked={p.mutedPublishers.includes(n)} onChange={() => toggle('mutedPublishers', n)} />Mute</label></div>)}</div>}</div>
      <div className="card grid gap-3 p-4 sm:grid-cols-3"><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={p.showImages} onChange={(e) => setP({ ...p, showImages: e.target.checked })} />Show publisher thumbnails (hotlinked, never stored)</label><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={p.showRead ?? false} onChange={(e) => setP({ ...p, showRead: e.target.checked })} />Show read stories in the main feeds (dimmed)</label>
        <Field label="Keep stories (days)"><input className="input" type="number" min="7" max="365" value={p.retentionDays} onChange={(e) => setP({ ...p, retentionDays: Number(e.target.value) })} /></Field>
        <Field label="Refresh when older than (minutes)"><input className="input" type="number" min="15" max="1440" value={p.staleMinutes} onChange={(e) => setP({ ...p, staleMinutes: Number(e.target.value) })} /></Field></div>
      <div className="flex items-center gap-3"><button className="btn btn-primary" onClick={save}>Save preferences</button>{saved && <span className="text-sm text-emerald-600">Saved</span>}</div>
      <div className="card space-y-2 p-4"><h4 className="font-medium">Gemini AI</h4>
        <p className="text-sm text-slate-600 dark:text-slate-300">The Gemini API needs its own API key and may require billing. A consumer Gemini subscription does <b>not</b> include API usage. Create a key in Google AI Studio and set <code>GEMINI_API_KEY</code>. Without it, stories show publisher excerpts or headlines only.</p>
        <p className="text-sm">Status: {diag.data?.ai.enabled ? <b className="text-emerald-600">enabled ({diag.data.ai.model})</b> : <b className="text-amber-600">not configured</b>}</p>
        {budget != null && <div className="flex items-end gap-2"><Field label="Daily request budget (0 disables AI)"><input className="input" type="number" min="0" value={budget} onChange={(e) => setBudget(Number(e.target.value))} /></Field><button className="btn btn-outline" onClick={async () => { await api('/api/ai/budget', { method: 'PUT', body: { budget } }); diag.reload(); }}>Set</button></div>}</div>
      <div className="flex flex-wrap gap-2"><a className="btn btn-outline" href="/api/backup" download>Download full database backup (.sqlite.gz)</a><a className="btn btn-outline" href="/api/export">Download settings export (JSON)</a></div>
    </div>
  );
}

/* ---------------- Diagnostics ---------------- */
function Diagnostics() {
  const { data: d, err, reload } = useLoad<any>('/api/diagnostics');
  if (err) return <p className="text-red-600">{err}</p>; if (!d) return <div className="skeleton h-40 w-full" />;
  const Stat = ({ k, v }: { k: string; v: ReactNode }) => <div className="rounded-xl bg-slate-100 p-3 dark:bg-slate-800/60"><div className="text-xs text-slate-500">{k}</div><div className="text-lg font-semibold tabular-nums">{v}</div></div>;
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between"><h3 className="text-base font-semibold">Diagnostics</h3><button className="btn btn-outline" onClick={reload}>Reload</button></div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat k="Articles" v={d.counts.articles} /><Stat k="Stories (clusters)" v={d.counts.clusters} /><Stat k="Multi-source stories" v={d.counts.multiSourceClusters} /><Stat k="Headline-only" v={d.counts.headlineOnly} /><Stat k="Unclustered articles" v={d.counts.unclusteredArticles ?? 0} />
        <Stat k="DB size" v={`${d.db.approxSizeMB} MB`} /><Stat k="WAL size" v={`${d.db.walSizeMB} MB`} /><Stat k="Memory (RSS)" v={`${d.memoryMB.rss} MB`} /><Stat k="Uptime" v={`${Math.round(d.uptimeSec / 60)} min`} />
      </div>
      <div className="card space-y-1 p-4 text-sm"><h4 className="font-medium">Database &amp; storage</h4>
        {d.database.identity ? <p>Database ID <code>{d.database.identity.id.slice(0, 8)}…</code> · created {fullDate(d.database.identity.createdAt)}{d.database.identity.origin === 'adopted' ? ' (oldest known data; existing database)' : ''}</p> : <p className="text-amber-700 dark:text-amber-300">No database identity recorded.</p>}
        <p className={d.database.persistence.verified ? 'text-emerald-700 dark:text-emerald-300' : 'text-amber-700 dark:text-amber-300'}>{d.database.persistence.message}</p>
        <p className="text-xs text-slate-500">If the ID or creation time ever changes unexpectedly, the database was replaced and earlier data was lost.</p></div>
      <div className="card space-y-1 p-4 text-sm"><h4 className="font-medium">Cache</h4>
        <p>News refreshed: {timeAgo(d.status.lastNewsRefreshAt)} · {d.status.stale ? 'stale (refreshes on next visit)' : 'fresh'} · refresh after {d.cache.staleAfterMinutes} min · retention {d.cache.retentionDays} days</p>
        <p>Prices fetched: {timeAgo(d.market.lastFetchedAt)} · provider {d.market.provider.name} ({d.market.provider.configured ? 'key configured' : 'no key'}) · {d.market.cached} symbols cached</p>
        {d.market.errors.map((e: any) => <p key={e.symbol} className="text-amber-700 dark:text-amber-300">{e.symbol}: {e.error}</p>)}</div>
      <div className="card space-y-1 p-4 text-sm"><h4 className="font-medium">AI usage</h4>
        <p>{d.ai.enabled ? `Model ${d.ai.model}` : 'AI not configured'} · {d.ai.requestsToday}/{d.ai.dailyBudget} requests today · est. cost today ${d.ai.estimatedCostToday.toFixed(4)} · 30 days ${d.ai.estimatedCost30d.toFixed(4)}</p>
        {d.ai.backoffUntil && <p className="text-amber-700 dark:text-amber-300">Backing off after a quota/rate error until {fullDate(d.ai.backoffUntil)}</p>}<p className="text-xs text-slate-500">{d.ai.note} Cached AI results: {d.counts.aiCacheEntries}.</p></div>
      <div className="card overflow-x-auto p-4"><h4 className="mb-2 font-medium">Source health</h4>
        <table className="w-full text-left text-sm"><thead className="text-xs text-slate-500"><tr><th className="pr-3">Source</th><th className="pr-3">Health</th><th className="pr-3">Last check</th><th className="pr-3">Last success</th><th className="pr-3">Newest article</th><th className="pr-3">Articles</th><th>Error</th></tr></thead>
          <tbody>{d.sources.map((s: Source) => <tr key={s.id} className="border-t border-slate-100 align-top dark:border-slate-800"><td className="py-1.5 pr-3">{s.name}{s.kind === 'aggregator' && <span className="chip ml-1">aggregator</span>}</td><td className="pr-3"><span className={`chip ${HEALTH[s.health]}`}>{healthLabel(s.health)}</span></td><td className="pr-3">{timeAgo(s.lastCheckedAt)}</td><td className="pr-3">{timeAgo(s.lastSuccessAt)}</td><td className="pr-3">{s.lastItemAt ? timeAgo(s.lastItemAt) : '—'}</td><td className="pr-3">{s.articleCount}</td><td className="text-xs text-slate-500">{s.lastError ?? s.statusReason ?? ''}</td></tr>)}</tbody></table></div>
      <div className="card overflow-x-auto p-4"><h4 className="mb-2 font-medium">Recent jobs</h4>
        <table className="w-full text-left text-sm"><thead className="text-xs text-slate-500"><tr><th className="pr-3">When</th><th className="pr-3">Trigger</th><th className="pr-3">Status</th><th>Result</th></tr></thead>
          <tbody>{d.jobs.map((j: any) => <tr key={j.id} className="border-t border-slate-100 dark:border-slate-800"><td className="py-1.5 pr-3">{timeAgo(j.started_at)}</td><td className="pr-3">{j.trigger}</td><td className="pr-3">{j.status}</td><td className="text-xs text-slate-500">{j.error ?? (j.stats ? `${j.stats.newArticles} new · ${j.stats.ok}/${j.stats.sources} sources ok · ${j.stats.aiSummarized} AI · ${(j.stats.durationMs / 1000).toFixed(1)}s` : '')}</td></tr>)}</tbody></table></div>
      <p className="text-xs text-slate-500">Node {d.node} · DB {d.db.path}</p>
    </div>
  );
}

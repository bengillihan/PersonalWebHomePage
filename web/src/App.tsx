import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, setCsrf, timeAgo } from './api';
import type { Status, Topic } from './types';
import Feed from './components/Feed';
import Market from './components/Market';
import Weather from './components/Weather';
import Settings from './components/Settings';

const TABS: [string, string][] = [['foryou', 'For You'], ['latest', 'Latest'], ['unread', 'Unread'], ['local', 'Local'], ['saved', 'Saved'], ['explore', 'Explore']];

export default function App() {
  const [me, setMe] = useState<{ email: string } | null | 'loading'>('loading');
  const [theme, setTheme] = useState<'light' | 'dark'>(() => (document.documentElement.classList.contains('dark') ? 'dark' : 'light'));
  const [tab, setTab] = useState('foryou'); const [topic, setTopic] = useState<string | undefined>();
  const [q, setQ] = useState(''); const [topics, setTopics] = useState<Topic[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [settings, setSettings] = useState<string | null>(null);
  const [version, setVersion] = useState(0); const [marketVersion, setMarketVersion] = useState(0);
  const [newStories, setNewStories] = useState(false);
  const wasRefreshing = useRef(false);

  useEffect(() => { api<{ email: string; csrfToken: string; theme: 'light' | 'dark' | 'system' }>('/api/me').then((m) => { setCsrf(m.csrfToken); setMe(m); if (m.theme !== 'system') setTheme(m.theme); /* saved choice wins over this device's default */ }).catch((e) => setMe(e instanceof ApiError && e.status === 401 ? null : null)); }, []);
  useEffect(() => { document.documentElement.classList.toggle('dark', theme === 'dark'); try { localStorage.theme = theme; } catch { /* private mode */ } }, [theme]);
  const loadTopics = useCallback(() => api<Topic[]>('/api/topics').then(setTopics).catch(() => {}), []);
  useEffect(() => { if (me && me !== 'loading') void loadTopics(); }, [me, loadTopics]);

  // While a background refresh runs, poll the lightweight status endpoint; when it ends, offer (don't force) a reload of the list.
  useEffect(() => {
    if (!status?.newsRefreshing) { if (wasRefreshing.current) { wasRefreshing.current = false; setNewStories(true); setMarketVersion((v) => v + 1); } return; }
    wasRefreshing.current = true;
    const t = setInterval(() => api<Status>('/api/status').then(setStatus).catch(() => {}), 3000);
    return () => clearInterval(t);
  }, [status?.newsRefreshing]);

  const refresh = async () => { try { setStatus(await api<Status>('/api/refresh', { method: 'POST' })); } catch { /* rate-limited */ } };
  const changed = () => { setVersion((v) => v + 1); setMarketVersion((v) => v + 1); void loadTopics(); setNewStories(false); };

  if (me === 'loading') return <div className="grid min-h-screen place-items-center"><div className="skeleton h-8 w-40" /></div>;
  if (!me) return (
    <main className="grid min-h-screen place-items-center p-6">
      <div className="card w-full max-w-sm p-8 text-center"><h1 className="text-2xl font-bold">News &amp; Markets</h1><p className="mt-2 text-sm text-slate-500">Private dashboard. Sign in with the authorized Google account.</p>
        <a className="btn btn-primary mt-6 w-full !py-2.5" href="/auth/login">Sign in with Google</a>
        {import.meta.env.DEV && <a className="mt-3 block text-xs text-slate-400 underline" href="/auth/dev">Dev login (DEV_LOGIN=true only)</a>}</div>
    </main>
  );

  const pick = (k: string, t?: string) => { setTab(k); setTopic(t); setQ(''); };
  const filtered = tab !== 'foryou' || !!q || !!topic;
  return (
    <div className="mx-auto max-w-3xl px-4 pb-16">
      <header className="sticky top-0 z-30 -mx-4 border-b border-slate-200/70 bg-slate-50/90 px-4 py-3 backdrop-blur dark:border-slate-800/70 dark:bg-slate-950/90">
        <div className="flex items-center gap-2">
          <h1 className="text-lg font-bold tracking-tight">News <span className="text-indigo-600">&amp;</span> Markets</h1><span className="flex-1" />
          <div className="hidden text-xs text-slate-500 sm:block" aria-live="polite">{status?.newsRefreshing ? <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 animate-pulse rounded-full bg-indigo-500" />Refreshing in background</span> : `News updated ${timeAgo(status?.lastNewsRefreshAt)}`}</div>
          <button className="btn btn-outline" onClick={refresh} disabled={status?.newsRefreshing} title="Fetch new stories now">↻ <span className="hidden sm:inline">Refresh</span></button>
          <button className="btn btn-ghost" onClick={() => { const next = theme === 'dark' ? 'light' : 'dark'; setTheme(next); void api('/api/theme', { method: 'PUT', body: { theme: next } }).catch(() => {}); }} aria-label="Toggle dark mode">{theme === 'dark' ? '☀️' : '🌙'}</button>
          <button className="btn btn-ghost" onClick={() => setSettings('sources')} aria-label="Settings">⚙ <span className="hidden sm:inline">Settings</span></button>
          <button className="btn btn-ghost text-xs" onClick={async () => { await api('/auth/logout', { method: 'POST' }); location.reload(); }} title={me.email}>Sign out</button>
        </div>
        <div className="mt-1 text-xs text-slate-500 sm:hidden">{status?.newsRefreshing ? 'Refreshing in background…' : `News updated ${timeAgo(status?.lastNewsRefreshAt)}`}</div>
      </header>

      <div className="mt-4"><Market version={marketVersion} onOpenSettings={setSettings} /></div>
      <div className="mt-3"><Weather version={marketVersion} /></div>

      <div className="mt-5 flex flex-col gap-3">
        <div className="relative"><input className="input !py-2.5 !pl-9" type="search" placeholder="Search articles, publishers, categories, keywords…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">🔍</span></div>
        <div className="flex gap-1.5 overflow-x-auto pb-1" role="tablist" aria-label="Feed filters">
          {TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k && !topic} className={`btn whitespace-nowrap ${tab === k && !topic ? 'btn-primary' : 'btn-outline'}`} onClick={() => pick(k)}>{l}</button>)}
          {topics.map((t) => <button key={t.id} role="tab" aria-selected={topic === t.name} className={`btn whitespace-nowrap ${topic === t.name ? 'btn-primary' : 'btn-outline'}`} onClick={() => pick('topic', t.name)}>{t.name}</button>)}
          {filtered && <button className="btn btn-ghost whitespace-nowrap text-indigo-600" onClick={() => pick('foryou')}>✕ Clear filters</button>}
        </div>
        {newStories && <button className="btn btn-primary self-center" onClick={() => { setVersion((v) => v + 1); setNewStories(false); }}>New stories available — show them</button>}
        {status && !status.aiEnabled && <p className="text-xs text-slate-500">AI summaries are off (no Gemini key). Showing publisher excerpts and headlines. <button className="underline" onClick={() => setSettings('preferences')}>Learn more</button></p>}
      </div>

      <main className="mt-4"><Feed filter={{ tab, q, topic }} onStatus={setStatus} onOpenSettings={setSettings} newVersion={version} /></main>
      {settings && <Settings panel={settings} setPanel={setSettings} onClose={() => { setSettings(null); changed(); }} onChanged={() => { void loadTopics(); }} />}
    </div>
  );
}

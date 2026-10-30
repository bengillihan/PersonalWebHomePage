import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, setCsrf, timeAgo } from './api';
import type { Status, Topic } from './types';
import Feed from './components/Feed';
import Market from './components/Market';
import Nav from './components/Nav';
import FrontPage from './components/FrontPage';
import { loadView, saveView, SECTION_KEYS, type View } from './sections';

const Weather = lazy(() => import('./components/Weather'));
const Settings = lazy(() => import('./components/Settings'));

const TABS: [string, string][] = [['foryou', 'For You'], ['latest', 'Latest'], ['unread', 'Unread'], ['local', 'Local'], ['saved', 'Saved'], ['explore', 'Explore']];

export default function App() {
  const [me, setMe] = useState<{ email: string } | null | 'loading'>('loading');
  const [theme, setTheme] = useState<'light' | 'dark'>(() => (document.documentElement.classList.contains('dark') ? 'dark' : 'light'));
  const [view, setView] = useState<View>(loadView);
  const [tab, setTab] = useState(() => (loadView() === 'newspaper' ? 'front' : 'foryou')); const [topic, setTopic] = useState<string | undefined>();
  const [q, setQ] = useState(''); const [topics, setTopics] = useState<Topic[]>([]);
  const [status, setStatus] = useState<Status | null>(null);
  const [settings, setSettings] = useState<string | null>(null);
  const [version, setVersion] = useState(0); const [marketVersion, setMarketVersion] = useState(0);
  const [newStories, setNewStories] = useState(false);
  const wasRefreshing = useRef(false);

  useEffect(() => { api<{ email: string; csrfToken: string; theme: 'light' | 'dark' | 'system' }>('/api/me').then((m) => { setCsrf(m.csrfToken); setMe(m); setTheme(m.theme === 'system' ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : m.theme); /* saved choice wins over this device's default */ }).catch((e) => setMe(e instanceof ApiError && e.status === 401 ? null : null)); }, []);
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

  // Applies immediately and saves server-side (follows you across devices). 'system' resolves to this device's current setting.
  const chooseTheme = (t: 'light' | 'dark' | 'system') => {
    setTheme(t === 'system' ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light') : t);
    void api('/api/theme', { method: 'PUT', body: { theme: t } }).catch(() => {});
  };

  if (me === 'loading') return <div className="grid min-h-screen place-items-center"><div className="skeleton h-8 w-40" /></div>;
  if (!me) return (
    <main className="grid min-h-screen place-items-center p-6">
      <div className="card w-full max-w-sm p-8 text-center"><h1 className="text-2xl font-bold">News &amp; Markets</h1><p className="mt-2 text-sm text-slate-500">Private dashboard. Sign in with the authorized Google account.</p>
        <a className="btn btn-primary mt-6 w-full !py-2.5" href="/auth/login">Sign in with Google</a>
        {import.meta.env.DEV && <a className="mt-3 block text-xs text-slate-400 underline" href="/auth/dev">Dev login (DEV_LOGIN=true only)</a>}</div>
    </main>
  );

  const pick = (k: string, t?: string) => { setTab(k); setTopic(t); setQ(''); };
  const newspaper = view === 'newspaper';
  const chooseView = (v: View) => { saveView(v); setView(v); setTopic(undefined); setQ(''); setTab(v === 'newspaper' ? 'front' : 'foryou'); };
  const home = newspaper ? 'front' : 'foryou';
  const filtered = tab !== home || !!q || !!topic;
  const sectionTab = SECTION_KEYS.includes(tab);
  const feedFilter = { tab: q && newspaper ? 'latest' : tab, q, topic };
  const viewSwitch = (
    <div className="inline-flex flex-none overflow-hidden whitespace-nowrap rounded-lg border border-slate-300 dark:border-slate-700" role="group" aria-label="Layout">
      {([['newspaper', 'Newspaper'], ['compact', 'Compact feed']] as [View, string][]).map(([v, l]) => <button key={v} aria-pressed={view === v} onClick={() => chooseView(v)} className={`px-2.5 py-1 text-xs font-medium ${view === v ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900' : 'hover:bg-slate-100 dark:hover:bg-slate-800'}`}>{l}</button>)}
    </div>
  );
  return (
    <div className={`mx-auto px-4 pb-16 ${newspaper ? 'max-w-6xl' : 'max-w-3xl'}`}>
      <header className="sticky top-0 z-30 -mx-4 border-b border-slate-200/70 bg-slate-50/90 px-4 py-3 backdrop-blur dark:border-slate-800/70 dark:bg-slate-950/90">
        <div className="flex items-center gap-2">
          <h1 className={newspaper ? 'font-serif text-2xl font-black tracking-tight sm:text-3xl' : 'text-lg font-bold tracking-tight'}>News <span className="text-indigo-600">&amp;</span> Markets</h1>
          {newspaper && <span className="hidden text-xs text-slate-500 lg:inline">{new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}</span>}
          <span className="flex-1" />
          <button className="btn btn-outline" onClick={refresh} disabled={status?.newsRefreshing} title="Fetch new stories now">↻ <span className="hidden sm:inline">Refresh</span></button>
          <button className="btn btn-ghost" onClick={() => chooseTheme(theme === 'dark' ? 'light' : 'dark')} aria-label="Toggle dark mode">{theme === 'dark' ? '☀️' : '🌙'}</button>
          <button className="btn btn-ghost" onClick={() => setSettings('sources')} aria-label="Settings">⚙ <span className="hidden sm:inline">Settings</span></button>
          <button className="btn btn-ghost whitespace-nowrap text-xs" onClick={async () => { await api('/auth/logout', { method: 'POST' }); location.reload(); }} title={me.email}>Sign out</button>
        </div>
        <div className="mt-2 flex items-center justify-between gap-3">
          {viewSwitch}
          <div className="min-w-0 text-right text-xs text-slate-500" aria-live="polite">{status?.newsRefreshing ? <span className="inline-flex items-center gap-1.5"><span className="h-2 w-2 animate-pulse rounded-full bg-indigo-500" />Refreshing in background</span> : `News updated ${timeAgo(status?.lastNewsRefreshAt)}`}</div>
        </div>
      </header>

      {newspaper ? (<>
        <div className="mt-3"><Nav tab={q ? '' : tab} onPick={(k) => pick(k)} /></div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <div className="relative basis-full sm:min-w-[12rem] sm:flex-1 sm:basis-0"><input className="input !py-2 !pl-9" type="search" placeholder="Search articles, publishers, categories, keywords…" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search" />
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">🔍</span></div>
          <button className={`btn whitespace-nowrap ${tab === 'saved' && !q ? 'btn-primary' : 'btn-outline'}`} aria-pressed={tab === 'saved' && !q} onClick={() => pick('saved')}>Saved</button>
          <button className={`btn whitespace-nowrap ${tab === 'unread' && !q ? 'btn-primary' : 'btn-outline'}`} aria-pressed={tab === 'unread' && !q} onClick={() => pick('unread')}>Unread</button>
          {filtered && <button className="btn btn-ghost whitespace-nowrap text-indigo-600" onClick={() => pick('front')}>✕ Front Page</button>}
        </div>
        {newStories && <button className="btn btn-primary mt-3" onClick={() => { setVersion((v) => v + 1); setNewStories(false); }}>New stories available — show them</button>}
        {status && !status.aiEnabled && <p className="mt-2 text-xs text-slate-500">AI summaries are off (no Gemini key). Showing publisher excerpts and headlines. <button className="underline" onClick={() => setSettings('preferences')}>Learn more</button></p>}
        {!q && tab === 'front' && <div className="mt-4 space-y-2"><Market compact version={marketVersion} onOpenSettings={setSettings} /><Suspense fallback={null}><Weather variant="strip" version={marketVersion} onOpen={() => pick('weather')} /></Suspense></div>}
        <main className="mt-5">
          {q || (tab !== 'front' && tab !== 'weather')
            ? <Feed filter={feedFilter} layout="newspaper" lead={sectionTab && !q} onStatus={setStatus} onOpenSettings={setSettings} newVersion={version} />
            : tab === 'weather' ? <Suspense fallback={<div className="skeleton h-48 w-full" />}><Weather variant="expanded" version={marketVersion} /></Suspense>
            : <FrontPage version={version} onStatus={setStatus} onOpenSettings={setSettings} onNavigate={(k) => pick(k)} />}
        </main>
      </>) : (<>
        <div className="mt-4"><Market version={marketVersion} onOpenSettings={setSettings} /></div>
        <div className="mt-3"><Suspense fallback={null}><Weather version={marketVersion} /></Suspense></div>

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
      </>)}
      {settings && <Suspense fallback={null}><Settings panel={settings} setPanel={setSettings} onClose={() => { setSettings(null); changed(); }} onChanged={() => { void loadTopics(); }} onTheme={chooseTheme} /></Suspense>}
    </div>
  );
}

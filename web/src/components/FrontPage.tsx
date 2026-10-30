import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { FrontPageData, Status, Story } from '../types';
import StoryCard from './StoryCard';

type Data = Pick<FrontPageData, 'lead' | 'secondary' | 'sections'>;
const mapStories = (d: Data, fn: (s: Story) => Story | null): Data => ({
  lead: d.lead ? fn(d.lead) : null,
  secondary: d.secondary.flatMap((s) => fn(s) ?? []),
  sections: d.sections.map((b) => ({ ...b, items: b.items.flatMap((s) => fn(s) ?? []) })).filter((b) => b.items.length),
});
const SectionHead = ({ children, onClick }: { children: string; onClick?: () => void }) => (
  <h2 className="mb-3 flex items-baseline justify-between border-b-2 border-slate-900 pb-1 font-serif text-xl font-bold uppercase tracking-wide dark:border-slate-100">
    {children}{onClick && <button className="font-sans text-xs font-medium normal-case tracking-normal underline hover:text-indigo-600" onClick={onClick}>More {children} →</button>}
  </h2>
);

/**
 * The Front Page: one request (/api/frontpage) returns a lead, secondary stories and per-section blocks, each story once. Read, save, rate and
 * hide work exactly as in the feed; a story marked read leaves the page at once (with Undo) unless "Show read stories" is on.
 */
export default function FrontPage({ version, onStatus, onOpenSettings, onNavigate }: { version: number; onStatus: (s: Status) => void; onOpenSettings: (p: string) => void; onNavigate: (tab: string) => void }) {
  const [data, setData] = useState<Data | null>(null);
  const [showImages, setShowImages] = useState(true); const [showRead, setShowRead] = useState(false); const [hasAny, setHasAny] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [undo, setUndo] = useState<Story | null>(null);
  const seq = useRef(0); const timers = useRef<ReturnType<typeof setTimeout>[]>([]); const undoTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const load = useCallback(async () => {
    const mine = ++seq.current; setError(null);
    try {
      const r = await api<FrontPageData>('/api/frontpage');
      if (mine !== seq.current) return;
      setData({ lead: r.lead, secondary: r.secondary, sections: r.sections }); setShowImages(r.showImages); setShowRead(r.showRead); setHasAny(r.hasAnyStories); onStatus(r.status);
    } catch (e) { if (mine === seq.current) setError((e as Error).message); }
  }, []);
  useEffect(() => { void load(); }, [load, version]);
  useEffect(() => () => { timers.current.forEach(clearTimeout); clearTimeout(undoTimer.current); }, []);

  const update = (s: Story) => setData((d) => d && mapStories(d, (x) => (x.id === s.id ? s : x)));
  const remove = (id: number) => setData((d) => {
    if (!d) return d;
    const next = mapStories(d, (x) => (x.id === id ? null : x));
    if (!next.lead && next.secondary.length) { const [first, ...rest] = next.secondary; return { ...next, lead: first, secondary: rest }; } // never leave the page without a lead
    return next;
  });
  const gone = (id: number) => (id === -1 ? load() : remove(id));

  const markRead = async (story: Story, read: boolean, via: 'button' | 'link') => {
    setData((d) => d && mapStories(d, (x) => (x.id === story.id ? { ...x, isRead: read, isUpdated: false } : x)));
    try { await api(`/api/stories/${story.id}/read`, { method: 'POST', body: { read } }); }
    catch (e) { setData((d) => d && mapStories(d, (x) => (x.id === story.id ? story : x))); setError((e as Error).message); return; }
    if (!read || showRead) return;
    const drop = () => { remove(story.id); setUndo(story); clearTimeout(undoTimer.current); undoTimer.current = setTimeout(() => setUndo(null), 8000); };
    if (via === 'link') timers.current.push(setTimeout(drop, 700)); else drop();
  };
  const undoRead = async () => {
    if (!undo) return; const s = undo; setUndo(null); clearTimeout(undoTimer.current);
    try { await api(`/api/stories/${s.id}/read`, { method: 'POST', body: { read: false } }); } catch (e) { setError((e as Error).message); return; }
    void load();
  };
  const card = (s: Story, variant: 'lead' | 'brief') => <StoryCard key={s.id} variant={variant} story={s} showImages={showImages} onChange={update} onRead={markRead} onGone={gone} />;

  if (!data && !error) return <div className="space-y-4" aria-busy="true" aria-label="Loading front page"><div className="skeleton h-64 w-full" /><div className="grid gap-4 md:grid-cols-3">{[0, 1, 2].map((i) => <div key={i} className="skeleton h-28" />)}</div></div>;
  if (!data) return <div className="card p-8 text-center" role="alert"><p className="font-medium">Couldn’t load the front page</p><p className="mt-1 text-sm text-slate-500">{error}</p><button className="btn btn-primary mt-4" onClick={load}>Try again</button></div>;
  const empty = !data.lead && !data.secondary.length && !data.sections.length;
  const side = data.secondary.slice(0, 3), more = data.secondary.slice(3);

  return (
    <div className="space-y-8">
      {empty ? (
        <div className="card p-8 text-center">
          {!hasAny ? (<><p className="text-lg font-semibold">Welcome — your front page is warming up</p><p className="mx-auto mt-2 max-w-md text-sm text-slate-500">The first fetch runs in the background (usually under a minute).</p>
            <div className="mt-4 flex justify-center gap-2"><button className="btn btn-primary" onClick={() => onOpenSettings('interests')}>Add interests</button><button className="btn btn-outline" onClick={() => onOpenSettings('sources')}>Review sources</button></div></>)
            : <><p>You’re all caught up. 🎉</p>{!showRead && <p className="mt-1 text-sm text-slate-500">Read stories are hidden. <button className="underline" onClick={() => onOpenSettings('preferences')}>Show read stories</button></p>}</>}
        </div>
      ) : (<>
        <div className="grid gap-x-8 gap-y-6 lg:grid-cols-12">
          {data.lead && <div className="lg:col-span-8">{card(data.lead, 'lead')}</div>}
          {side.length > 0 && <div className={`space-y-4 ${data.lead ? 'lg:col-span-4' : 'lg:col-span-12'}`} aria-label="Top stories">{side.map((s) => card(s, 'brief'))}</div>}
        </div>
        {more.length > 0 && <div className="grid gap-x-8 gap-y-5 md:grid-cols-2 lg:grid-cols-3" aria-label="More top stories">{more.map((s) => card(s, 'brief'))}</div>}
        {data.sections.map((b) => (
          <section key={b.key} aria-label={b.label} className="[content-visibility:auto] [contain-intrinsic-size:auto_320px]">
            <SectionHead onClick={b.key === 'more' ? undefined : () => onNavigate(b.key)}>{b.label}</SectionHead>
            <div className="grid gap-x-6 gap-y-5 md:grid-cols-2 lg:grid-cols-4">{b.items.map((s) => card(s, 'brief'))}</div>
          </section>
        ))}
      </>)}
      {error && <p className="text-center text-sm text-red-600" role="alert">{error}</p>}
      {undo && (
        <div role="status" className="fixed inset-x-0 bottom-4 z-50 mx-auto flex w-fit max-w-[92vw] items-center gap-3 rounded-xl bg-slate-900 px-4 py-2.5 text-sm text-white shadow-lg dark:bg-slate-100 dark:text-slate-900">
          <span className="truncate">Marked as read</span><button className="font-semibold underline" onClick={undoRead}>Undo</button>
        </div>
      )}
    </div>
  );
}

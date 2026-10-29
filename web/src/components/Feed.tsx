import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import type { FeedResponse, Status, Story } from '../types';
import StoryCard from './StoryCard';

export interface FeedFilter { tab: string; q: string; topic?: string }

export default function Feed({ filter, onStatus, onOpenSettings, newVersion }: { filter: FeedFilter; onStatus: (s: Status) => void; onOpenSettings: (p: string) => void; newVersion: number }) {
  const [items, setItems] = useState<Story[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasAny, setHasAny] = useState(true);
  const [showImages, setShowImages] = useState(true);
  const [done, setDone] = useState(false);
  const seq = useRef(0);
  const sentinel = useRef<HTMLDivElement>(null);

  const qs = (cur?: string | null) => new URLSearchParams({ tab: filter.tab, ...(filter.q ? { q: filter.q } : {}), ...(filter.topic ? { topic: filter.topic } : {}), ...(cur ? { cursor: cur } : {}), limit: '20' }).toString();

  const load = useCallback(async () => {
    const mine = ++seq.current; setLoading(true); setError(null); setDone(false);
    try {
      const r = await api<FeedResponse>(`/api/feed?${qs()}`);
      if (mine !== seq.current) return;
      setItems(r.items); setCursor(r.nextCursor); setHasAny(r.hasAnyStories); setShowImages(r.showImages); onStatus(r.status); setDone(!r.nextCursor);
    } catch (e) { if (mine === seq.current) setError((e as Error).message); }
    finally { if (mine === seq.current) setLoading(false); }
  }, [filter.tab, filter.q, filter.topic]);

  useEffect(() => { const t = setTimeout(load, filter.q ? 250 : 0); return () => clearTimeout(t); }, [load, newVersion, filter.q]);

  const loadMore = useCallback(async () => {
    if (!cursor || more || loading) return;
    const mine = seq.current; setMore(true);
    try {
      const r = await api<FeedResponse>(`/api/feed?${qs(cursor)}`);
      if (mine !== seq.current) return;
      setItems((prev) => { const seen = new Set(prev.map((p) => p.id)); return [...prev, ...r.items.filter((i) => !seen.has(i.id))]; });
      setCursor(r.nextCursor); setDone(!r.nextCursor);
    } catch (e) { setError((e as Error).message); } finally { setMore(false); }
  }, [cursor, more, loading, filter.tab, filter.q, filter.topic]);

  useEffect(() => {
    const el = sentinel.current; if (!el) return;
    const io = new IntersectionObserver((e) => { if (e[0].isIntersecting) void loadMore(); }, { rootMargin: '600px' });
    io.observe(el); return () => io.disconnect();
  }, [loadMore]);

  const update = (s: Story) => setItems((prev) => {
    if (filter.tab === 'unread' && s.isRead) return prev.map((x) => (x.id === s.id ? s : x)); // keep in place until next load so it doesn't jump
    return prev.map((x) => (x.id === s.id ? s : x));
  });

  if (loading && !items.length) return <div className="space-y-4" aria-busy="true" aria-label="Loading stories">{[0, 1, 2, 3].map((i) => <div key={i} className="card space-y-3 p-5"><div className="skeleton h-4 w-1/3" /><div className="skeleton h-6 w-4/5" /><div className="skeleton h-4 w-full" /><div className="skeleton h-4 w-2/3" /></div>)}</div>;
  if (error && !items.length) return <div className="card p-8 text-center" role="alert"><p className="font-medium">Couldn’t load stories</p><p className="mt-1 text-sm text-slate-500">{error}</p><button className="btn btn-primary mt-4" onClick={load}>Try again</button></div>;
  if (!items.length) {
    return (
      <div className="card p-8 text-center">
        {!hasAny ? (<>
          <p className="text-lg font-semibold">Welcome — your feed is warming up</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-slate-500">The first fetch runs in the background (usually under a minute). You can add interests and tune sources while you wait.</p>
          <div className="mt-4 flex justify-center gap-2"><button className="btn btn-primary" onClick={() => onOpenSettings('interests')}>Add interests</button><button className="btn btn-outline" onClick={() => onOpenSettings('sources')}>Review sources</button></div>
        </>) : filter.q ? <p>No stories match “{filter.q}”.</p>
          : filter.tab === 'saved' ? <p>Nothing saved yet. Use the bookmark icon on any story.</p>
          : filter.tab === 'unread' ? <p>You’re all caught up. 🎉</p>
          : <p>No stories here yet.</p>}
      </div>
    );
  }
  return (
    <div className="space-y-4">
      {items.map((s) => <StoryCard key={s.id} story={s} showImages={showImages} onChange={update} onGone={(id) => (id === -1 ? load() : setItems((p) => p.filter((x) => x.id !== id)))} />)}
      <div ref={sentinel} />
      {more && <div className="skeleton mx-auto h-8 w-40" aria-label="Loading more" />}
      {error && <p className="text-center text-sm text-red-600" role="alert">{error} <button className="underline" onClick={loadMore}>Retry</button></p>}
      {done && <p className="py-6 text-center text-sm text-slate-400">You’ve reached the end.</p>}
    </div>
  );
}

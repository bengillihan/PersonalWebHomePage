import { useState } from 'react';
import { api, fullDate, timeAgo } from '../api';
import type { Story } from '../types';
import BlockTopicForm from './BlockTopicForm';

const REASONS: [string, string][] = [['topic', 'Not interested in this topic'], ['already_knew', 'Already knew this'], ['low_importance', 'Low importance'], ['source', "Don't like this source"], ['duplicate', 'Duplicate']];
const Icon = ({ d, fill }: { d: string; fill?: boolean }) => (
  <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill={fill ? 'currentColor' : 'none'} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={d} /></svg>
);
const UP = 'M7 10v11H3V10h4zm0 0l4-8a2 2 0 012 2v4h6a2 2 0 012 2.3l-1.3 8a2 2 0 01-2 1.7H7';
const DOWN = 'M17 14V3h4v11h-4zm0 0l-4 8a2 2 0 01-2-2v-4H5a2 2 0 01-2-2.3l1.3-8A2 2 0 016.3 4H17';
const MARK = 'M6 3h12a1 1 0 011 1v17l-7-4-7 4V4a1 1 0 011-1z';
const EYE_OFF = 'M3 3l18 18M10.6 10.6a2 2 0 002.8 2.8M9.9 5.1A9.8 9.8 0 0112 5c5 0 9 4 10 7a11 11 0 01-3.2 4.4M6.2 6.3A11 11 0 002 12c1 3 5 7 10 7a9.7 9.7 0 004-.9';

export default function StoryCard({ story, showImages, onChange, onGone, onRead }: { story: Story; showImages: boolean; onChange: (s: Story) => void; onGone: (id: number) => void; onRead?: (s: Story, read: boolean, via: 'button' | 'link') => void }) {
  const [open, setOpen] = useState(false);
  const [why, setWhy] = useState(false);
  const [askReason, setAskReason] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [blockOpen, setBlockOpen] = useState(false);
  const [blockedNote, setBlockedNote] = useState<string | null>(null);
  const [expl, setExpl] = useState<Story['why'] | null>(story.why ?? null);
  const run = async (fn: () => Promise<unknown>, patch: Partial<Story>) => {
    const prev = story; onChange({ ...story, ...patch });
    try { await fn(); setErr(null); } catch (e) { onChange(prev); setErr((e as Error).message); }
  };
  const p = story.primary;

  const rate = (rating: 1 | -1 | 0, reason?: string) => run(() => api(`/api/stories/${story.id}/feedback`, { method: 'POST', body: { rating, reason: reason ?? null } }), { rating });
  // A story that gained new information after it was read counts as unread again (it carries the Updated label).
  const effectivelyRead = story.isRead && !story.isUpdated;
  const setRead = (r: boolean, via: 'button' | 'link') => (onRead ? onRead(story, r, via) : read(r));
  const read = (r: boolean) => run(() => api(`/api/stories/${story.id}/read`, { method: 'POST', body: { read: r } }), { isRead: r, isUpdated: false });
  const toggleWhy = async () => {
    setWhy(!why);
    if (!why && !expl) { try { setExpl(await api(`/api/stories/${story.id}/why`)); } catch { /* shown as unavailable */ } }
  };
  const summaryLabel = story.summaryKind === 'ai' ? 'AI summary' : story.summaryKind === 'excerpt' ? 'Publisher excerpt' : 'Headline only';
  const btn = (active: boolean) => `btn btn-ghost !px-2 ${active ? '!text-indigo-600 dark:!text-indigo-400' : ''}`;

  return (
    <article className={`card p-4 transition sm:p-5 ${effectivelyRead ? 'opacity-60 hover:opacity-100' : ''}`} aria-label={story.title}>
      <div className="flex gap-4">
        <div className="min-w-0 flex-1">
          <div className="mb-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
            <span className="font-semibold text-slate-800 dark:text-slate-100">{p?.publisher ?? 'Unknown'}</span>
            {story.sourceCount > 1 && <span className="text-slate-500">+{story.sourceCount - 1} more</span>}
            <span className="text-slate-400">·</span>
            <time className="text-slate-600 dark:text-slate-300" dateTime={new Date(story.publishedAt).toISOString()} title={fullDate(story.publishedAt)}>{timeAgo(story.publishedAt)}</time>
            {story.category && <span className="chip">{story.category}</span>}
            {story.isUpdated && <span className="chip !bg-amber-100 !text-amber-800 dark:!bg-amber-900/40 dark:!text-amber-200">Updated</span>}
            {story.blockedBy.length > 0 && <span className="chip !bg-rose-100 !text-rose-800 dark:!bg-rose-900/40 dark:!text-rose-200" title="Normally hidden from your feeds (Settings → Interests → Not interested). Shown here because you searched for it or saved it.">Blocked: {story.blockedBy.join(', ')}</span>}
            {p?.aggregated && <span className="chip" title="Found via a Google News aggregator feed; the link opens through Google News">via aggregator</span>}
          </div>
          <h2 className="text-lg font-semibold leading-snug sm:text-xl">
            {p ? <a href={p.url} target="_blank" rel="noopener noreferrer" onClick={() => !effectivelyRead && setRead(true, 'link')} className="hover:text-indigo-600 hover:underline dark:hover:text-indigo-400">{story.title}</a> : story.title}
          </h2>
          {story.summary ? (
            <p className="mt-2 text-[0.97rem] leading-relaxed text-slate-700 dark:text-slate-300">
              {story.summary} <span className="ml-1 whitespace-nowrap text-xs text-slate-400">· {summaryLabel}</span>
            </p>
          ) : (
            <p className="mt-2 text-sm italic text-slate-500">Headline only — the publisher feed provided no excerpt, so no summary is shown.</p>
          )}
          {story.differences && open && <p className="mt-2 rounded-lg bg-slate-50 p-2.5 text-sm text-slate-600 dark:bg-slate-800/60 dark:text-slate-300"><b>Differences between sources:</b> {story.differences}</p>}
        </div>
        {showImages && story.imageUrl && (
          <img src={story.imageUrl} alt="" loading="lazy" referrerPolicy="no-referrer" className="hidden h-24 w-32 flex-none rounded-xl object-cover sm:block" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
        )}
      </div>

      {story.why && <p className="mt-2 text-xs text-slate-500">{story.why.reasons[0]}</p>}

      <div className="mt-3 flex flex-wrap items-center gap-1 border-t border-slate-100 pt-2.5 dark:border-slate-800">
        <button className={btn(story.rating === 1)} aria-pressed={story.rating === 1} aria-label="Thumbs up" title="More like this" onClick={() => rate(story.rating === 1 ? 0 : 1)}><Icon d={UP} fill={story.rating === 1} /></button>
        <button className={btn(story.rating === -1)} aria-pressed={story.rating === -1} aria-label="Thumbs down" title="Less like this" onClick={() => (story.rating === -1 ? rate(0) : (setAskReason(true), rate(-1)))}><Icon d={DOWN} fill={story.rating === -1} /></button>
        <button className={btn(story.bookmarked)} aria-pressed={story.bookmarked} aria-label="Bookmark" title="Save" onClick={() => run(() => api(`/api/stories/${story.id}/bookmark`, { method: 'POST', body: { on: !story.bookmarked } }), { bookmarked: !story.bookmarked })}><Icon d={MARK} fill={story.bookmarked} /></button>
        <button className="btn btn-ghost !px-2" aria-label="Hide story" title="Hide" onClick={() => run(() => api(`/api/stories/${story.id}/hide`, { method: 'POST', body: { hidden: true } }), {}).then(() => onGone(story.id))}><Icon d={EYE_OFF} /></button>
        <button className="btn btn-ghost text-xs" onClick={() => setRead(!effectivelyRead, 'button')}>{effectivelyRead ? 'Mark unread' : 'Mark read'}</button>
        <span className="flex-1" />
        <button className="btn btn-ghost text-xs" onClick={toggleWhy} aria-expanded={why}>Why am I seeing this?</button>
        {story.sourceCount + story.mutedSources > 1 && <button className="btn btn-outline text-xs" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Hide coverage' : `See coverage from ${story.sourceCount} ${story.sourceCount === 1 ? 'source' : 'sources'}${story.mutedSources > 0 ? ` (+${story.mutedSources} muted)` : ''}`}</button>}
      </div>

      {askReason && story.rating === -1 && (
        <div className="mt-2 flex flex-wrap items-center gap-1.5 rounded-lg bg-slate-50 p-2 text-sm dark:bg-slate-800/60" role="group" aria-label="Why thumbs down?">
          <span className="text-slate-500">Why? (optional)</span>
          {REASONS.map(([k, label]) => <button key={k} className="btn btn-outline !py-1 text-xs" onClick={() => { rate(-1, k); setAskReason(false); }}>{label}</button>)}
          <button className="btn btn-outline !py-1 text-xs" onClick={() => setBlockOpen(true)}>Never show this topic…</button>
          <button className="btn btn-ghost !py-1 text-xs" onClick={() => setAskReason(false)}>Skip</button>
        </div>
      )}
      {blockOpen && !blockedNote && <BlockTopicForm storyId={story.id} onCancel={() => setBlockOpen(false)} onBlocked={(name) => { setBlockedNote(name); setBlockOpen(false); setAskReason(false); setTimeout(() => onGone(story.id), 1200); }} />}
      {blockedNote && <p className="mt-2 text-sm text-emerald-700 dark:text-emerald-300" role="status">Blocked “{blockedNote}”. This story and similar ones are now hidden.</p>}
      {err && <p className="mt-2 text-sm text-red-600" role="alert">{err}</p>}

      {why && (
        <div className="mt-2 rounded-lg bg-slate-50 p-3 text-sm dark:bg-slate-800/60">
          {expl ? (<>
            <ul className="list-disc space-y-0.5 pl-5">{expl.reasons.map((r) => <li key={r}>{r}</li>)}</ul>
            <p className="mt-2 text-xs text-slate-500">Score {(expl.score * 100).toFixed(0)}% — {Object.entries(expl.parts).map(([k, v]) => `${k} ${(v * 100).toFixed(0)}`).join(' · ')}</p>
          </>) : <p className="text-slate-500">Explanation unavailable.</p>}
        </div>
      )}

      {open && (
        <ul className="mt-3 space-y-1.5 border-t border-slate-100 pt-3 text-sm dark:border-slate-800">
          {story.articles.map((a) => (
            <li key={a.id} className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium">{a.publisher}</span>
              <a className="text-indigo-700 hover:underline dark:text-indigo-300" href={a.url} target="_blank" rel="noopener noreferrer">{a.title}</a>
              <span className="text-xs text-slate-400">{timeAgo(a.publishedAt)}</span>
              {a.muted && <span className="chip" title="You muted this publisher: it is hidden from your feeds, but listed here because it covers this story.">muted publisher</span>}
              {a.alsoVia.length > 0 && <span className="text-xs text-slate-400" title="Other feeds that carried this same article">also via {a.alsoVia.join(', ')}</span>}
              <button className="text-xs text-slate-400 underline hover:text-slate-600" onClick={() => api(`/api/stories/${story.id}/ungroup`, { method: 'POST', body: { articleId: a.id } }).then(() => onGone(-1))}>ungroup</button>
            </li>
          ))}
        </ul>
      )}
    </article>
  );
}

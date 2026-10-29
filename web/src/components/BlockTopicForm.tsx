import { useEffect, useState } from 'react';
import { api } from '../api';

interface Preview { keywords: string[]; matches: number; samples: { title: string; publisher: string }[] }

/**
 * "Never show this topic" from a story's thumbs-down menu. Starts from a suggestion based on the headline and the article's stored classification,
 * lets you edit it in plain language, and shows what it would hide before anything is saved. A hard exclusion, separate from soft feedback.
 */
export default function BlockTopicForm({ storyId, onBlocked, onCancel }: { storyId: number; onBlocked: (name: string) => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [words, setWords] = useState('');
  const [category, setCategory] = useState<string | null>(null);
  const [useCategory, setUseCategory] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    api<{ name: string; keywords: string[]; category: string | null }>(`/api/stories/${storyId}/block-suggestion`)
      .then((s) => { if (live) { setName(s.name); setWords(s.keywords.join(', ')); setCategory(s.category); } })
      .catch((e) => live && setErr((e as Error).message));
    return () => { live = false; };
  }, [storyId]);

  useEffect(() => {
    if (!words.trim() && !useCategory) { setPreview(null); return; }
    const t = setTimeout(() => {
      api<Preview>('/api/blocked-topics/preview', { method: 'POST', body: { description: words, categories: useCategory && category ? [category] : [] } }).then(setPreview).catch(() => setPreview(null));
    }, 300);
    return () => clearTimeout(t);
  }, [words, useCategory, category]);

  const save = async () => {
    setBusy(true); setErr(null);
    try {
      await api('/api/blocked-topics', { method: 'POST', body: { name: name.trim() || 'Blocked topic', description: words, categories: useCategory && category ? [category] : [] } });
      onBlocked(name.trim() || 'Blocked topic');
    } catch (e) { setErr((e as Error).message); setBusy(false); }
  };

  return (
    <div className="mt-2 space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm dark:border-slate-700 dark:bg-slate-800/60" role="group" aria-label="Never show this topic">
      <p className="font-medium">Never show this topic</p>
      <label className="block"><span className="mb-1 block text-xs text-slate-500">Name</span><input className="input !py-1.5" value={name} onChange={(e) => setName(e.target.value)} /></label>
      <label className="block"><span className="mb-1 block text-xs text-slate-500">Hide stories about (words or phrases, in plain language)</span><input className="input !py-1.5" value={words} onChange={(e) => setWords(e.target.value)} placeholder="hockey, NHL, Stanley Cup" /></label>
      {category && <label className="flex items-center gap-2"><input type="checkbox" checked={useCategory} onChange={(e) => setUseCategory(e.target.checked)} />Also hide everything classified as <b>{category}</b> <span className="text-xs text-slate-500">(broad)</span></label>}
      {preview && (
        <p className="text-xs text-slate-600 dark:text-slate-300">
          {preview.keywords.length > 0 && <>Matching: {preview.keywords.join(', ')}. </>}
          Would hide <b>{preview.matches}</b> recent {preview.matches === 1 ? 'story' : 'stories'}{preview.samples.length > 0 && <> — e.g. “{preview.samples.map((s) => s.title).join('”, “')}”</>}.
        </p>
      )}
      {err && <p className="text-xs text-red-600" role="alert">{err}</p>}
      <div className="flex gap-2">
        <button className="btn btn-primary !py-1 text-xs" disabled={busy || (!words.trim() && !useCategory)} onClick={save}>Block this topic</button>
        <button className="btn btn-ghost !py-1 text-xs" onClick={onCancel}>Cancel</button>
      </div>
      <p className="text-xs text-slate-500">Hidden stories are kept: find them with search, or in Saved. Manage topics in Settings → Interests.</p>
    </div>
  );
}

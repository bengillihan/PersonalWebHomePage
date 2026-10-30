import { useState } from 'react';
import { NAV } from '../sections';

/**
 * Newspaper navigation. From the lg breakpoint (1024px) it is one horizontal bar; below that, tablets included, a single "Sections" button opens a two-column menu, so nine
 * tabs are never squeezed onto one row of a phone.
 */
export default function Nav({ tab, onPick }: { tab: string; onPick: (k: string) => void }) {
  const [open, setOpen] = useState(false);
  const current = NAV.find(([k]) => k === tab)?.[1] ?? 'Sections';
  const pick = (k: string) => { setOpen(false); onPick(k); };
  return (
    <nav aria-label="Newspaper sections" className="border-y-2 border-slate-900 dark:border-slate-100">
      <div role="tablist" aria-label="Sections" className="hidden lg:flex lg:flex-wrap lg:gap-x-1">
        {NAV.map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => pick(k)}
            className={`px-3 py-2 text-sm font-semibold uppercase tracking-wide transition ${tab === k ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900' : 'text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800'}`}>{l}</button>
        ))}
      </div>
      <div className="lg:hidden">
        <button className="flex w-full items-center justify-between px-3 py-2 text-sm font-semibold uppercase tracking-wide" aria-expanded={open} aria-controls="section-menu" aria-label="Sections menu" onClick={() => setOpen(!open)}>
          <span>{current}</span><span aria-hidden>{open ? '▲' : '▼'}</span>
        </button>
        {open && (
          <ul id="section-menu" aria-label="Section menu" className="grid grid-cols-2 gap-1 border-t border-slate-200 p-2 dark:border-slate-800">
            {NAV.map(([k, l]) => (
              <li key={k}><button aria-current={tab === k ? 'page' : undefined} onClick={() => pick(k)}
                className={`w-full rounded px-3 py-2 text-left text-sm font-medium ${tab === k ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900' : 'hover:bg-slate-100 dark:hover:bg-slate-800'}`}>{l}</button></li>
            ))}
          </ul>
        )}
      </div>
    </nav>
  );
}

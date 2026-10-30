import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export interface MenuItem { key: string; label: ReactNode; ariaLabel?: string; checked?: boolean; expanded?: boolean; onSelect: () => void }

/**
 * A small accessible "more actions" menu (no dependency). The panel is portalled to <body> and positioned with fixed coordinates, so no card or
 * `content-visibility` / `overflow` container can clip it. Mouse, touch and keyboard: Enter/Space/ArrowDown open it, Arrow keys / Home / End move,
 * Escape or a click outside closes it and returns focus to the button. It closes on scroll or resize rather than drifting away from its card.
 */
export default function ActionMenu({ label, items, className = '' }: { label: string; items: MenuItem[]; className?: string }) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top?: number; bottom?: number; right: number } | null>(null);
  const button = useRef<HTMLButtonElement>(null); const panel = useRef<HTMLDivElement>(null);
  const close = useCallback((refocus = false) => { setOpen(false); if (refocus) button.current?.focus(); }, []);

  useLayoutEffect(() => {
    if (!open || !button.current) return;
    const r = button.current.getBoundingClientRect(); const right = Math.max(8, window.innerWidth - r.right);
    const below = window.innerHeight - r.bottom; const need = Math.min(items.length * 40 + 12, 320);
    setPos(below >= need || below >= r.top ? { top: r.bottom + 4, right } : { bottom: window.innerHeight - r.top + 4, right }); // flip upward near the bottom edge
  }, [open, items.length]);
  useEffect(() => { if (open && pos) panel.current?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus(); }, [open, pos]);
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => { const t = e.target as Node; if (!panel.current?.contains(t) && !button.current?.contains(t)) setOpen(false); };
    const shut = () => setOpen(false);
    document.addEventListener('pointerdown', away); window.addEventListener('scroll', shut, true); window.addEventListener('resize', shut);
    return () => { document.removeEventListener('pointerdown', away); window.removeEventListener('scroll', shut, true); window.removeEventListener('resize', shut); };
  }, [open]);

  const onButtonKey = (e: React.KeyboardEvent) => { if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); } };
  const onPanelKey = (e: React.KeyboardEvent) => {
    const els = [...(panel.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])]; const i = els.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') { e.preventDefault(); close(true); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); els[(i + 1) % els.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); els[(i - 1 + els.length) % els.length]?.focus(); }
    else if (e.key === 'Home') { e.preventDefault(); els[0]?.focus(); }
    else if (e.key === 'End') { e.preventDefault(); els[els.length - 1]?.focus(); }
    else if (e.key === 'Tab') setOpen(false);
  };

  return (
    <>
      <button ref={button} type="button" className={`btn btn-ghost !px-2 !py-1 ${className}`} aria-haspopup="menu" aria-expanded={open} aria-label={label} title={label} onClick={() => setOpen(!open)} onKeyDown={onButtonKey}>
        <svg viewBox="0 0 24 24" className="h-[18px] w-[18px]" fill="currentColor" aria-hidden><circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" /></svg>
      </button>
      {open && pos && createPortal(
        <div ref={panel} role="menu" aria-label={label} onKeyDown={onPanelKey} style={{ position: 'fixed', zIndex: 60, right: pos.right, top: pos.top, bottom: pos.bottom }}
          className="min-w-[13rem] max-w-[calc(100vw-1rem)] rounded-xl border border-slate-200 bg-white p-1 text-sm shadow-lg dark:border-slate-700 dark:bg-slate-900">
          {items.map((it) => (
            <button key={it.key} type="button" tabIndex={-1} role={it.checked !== undefined ? 'menuitemcheckbox' : 'menuitem'} aria-checked={it.checked} aria-expanded={it.expanded} aria-label={it.ariaLabel}
              className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-2 text-left hover:bg-slate-100 focus:bg-slate-100 focus:outline-none dark:hover:bg-slate-800 dark:focus:bg-slate-800"
              onClick={() => { close(true); it.onSelect(); }}>
              <span>{it.label}</span>{it.checked && <span aria-hidden className="text-indigo-600 dark:text-indigo-400">✓</span>}
            </button>
          ))}
        </div>, document.body)}
    </>
  );
}

/** Newspaper navigation. Keys other than 'front' and 'weather' are feed tabs served by /api/feed (see server/news/sections.ts). */
export const NAV: [string, string][] = [['front', 'Front Page'], ['local', 'Local'], ['regional', 'Regional'], ['washington', 'Washington'], ['us', 'U.S.'], ['world', 'World'], ['business', 'Business'], ['technology', 'Technology'], ['sports', 'Sports'], ['weather', 'Weather']];
export const SECTION_KEYS = NAV.map(([k]) => k).filter((k) => k !== 'front' && k !== 'weather');
export type View = 'newspaper' | 'compact';
export function loadView(): View { try { return localStorage.getItem('view') === 'compact' ? 'compact' : 'newspaper'; } catch { return 'newspaper'; } }
export function saveView(v: View) { try { localStorage.setItem('view', v); } catch { /* private mode: the choice just lasts for this visit */ } }

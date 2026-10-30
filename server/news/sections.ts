import type { GeoPrefs } from '../settings.js';

/**
 * Newspaper sections. A story's sections come from what it is ABOUT, never from where its publisher is:
 *  - topical sections (Business, Technology, Sports, World, U.S.) from the classification the story already has (Gemini's category, or a niche
 *    source's single default category), so nothing is asked of the model for layout;
 *  - geographic sections (Local, Regional, Washington) from the places named in the story's headline and summary, matched against the lists
 *    in Settings -> Geography (and the AI category 'Local' / 'Regional' / 'Washington' when it says so).
 * A story may belong to several sections. Pure functions: no database, no network.
 */
export const SECTIONS = ['local', 'regional', 'washington', 'us', 'world', 'business', 'technology', 'sports'] as const;
export type Section = (typeof SECTIONS)[number];
export const isSection = (s: string): s is Section => (SECTIONS as readonly string[]).includes(s);
export const SECTION_LABEL: Record<Section, string> = { local: 'Local', regional: 'Regional', washington: 'Washington', us: 'U.S.', world: 'World', business: 'Business', technology: 'Technology', sports: 'Sports' };
/** How far a story from the user's closest places (e.g. Des Moines, Federal Way) is lifted within Local. */
export const LOCAL_PRIORITY_BOOST = 0.5;

const CATEGORY: Record<Section, string[]> = {
  local: [], regional: ['regional'], washington: ['washington', 'washington state'],
  us: ['politics', 'u.s.', 'us', 'national'], world: ['world', 'international'],
  business: ['business', 'economy', 'finance', 'markets', 'energy', 'industry', 'companies'],
  technology: ['technology', 'tech', 'ai', 'cybersecurity', 'science & technology'], sports: ['sports'],
};
const US_TERMS = ['Congress', 'White House', 'Supreme Court', 'Pentagon', 'U.S. Senate', 'the Senate', 'U.S. House', 'federal government', 'Justice Department', 'Capitol Hill', 'the president'];
/** A following word that means the place name is somewhere else ("Des Moines, Iowa", "Kent State", "Des Moines Register"). */
const ELSEWHERE = /^(?:,\s*)?(?:iowa|ia\b|england|ohio|kentucky|ky\b|michigan|maine|connecticut|ontario|texas|california|oregon|florida|illinois|virginia|georgia|state\b|university\b|register\b)/i;

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const termRe = (t: string) => new RegExp(`(?<![\\p{L}\\p{N}])${esc(t.trim()).replace(/-/g, '[-\\s]?').replace(/\s+/g, '\\s+')}(?![\\p{L}\\p{N}])`, 'giu');
/** Does the text name any of these places (as whole words, and not as a namesake elsewhere)? */
function mentions(text: string, terms: string[]): string | null {
  for (const t of terms) {
    if (!t.trim()) continue;
    for (const m of text.matchAll(termRe(t))) {
      const end = (m.index ?? 0) + m[0].length;
      if (!ELSEWHERE.test(text.slice(end, end + 16).replace(/^\s+/, ''))) return t;
    }
  }
  return null;
}

/** `localSource`: a publisher flagged as local in Settings carried the story. Only supporting evidence, never enough on its own. */
export interface SectionInput { category: string | null; title: string; summary: string | null; localSource?: boolean }
export interface Classified { sections: Set<Section>; localPriority: boolean }

/**
 * Gemini only ever answers with the fixed list in BASE_CATEGORIES (plus the user's own category topics): there is no "U.S.", "Regional" or
 * "Washington", "Local" does not say how local, and every kind of politics is just "Politics". So the places in the text refine the category:
 *  - 'Local' means local to SOMEWHERE (Gemini does not know where the user lives), so it counts for the Local section only together with a named
 *    local place or a local-flagged publisher, and never when the text names only regional or statewide places (then it is Regional / Washington news);
 *  - 'Politics' counts for U.S. unless the story is about a named local, regional or state place and says nothing national;
 *  - Sports and Entertainment stories keep to their own sections (a score that mentions "Seattle" is not Regional news).
 */
export function classify(s: SectionInput, geo: GeoPrefs): Classified {
  const text = `${s.title}. ${s.summary ?? ''}`;
  const cat = (s.category ?? '').trim().toLowerCase();
  const out = new Set<Section>();
  for (const sec of SECTIONS) if (CATEGORY[sec].includes(cat)) out.add(sec);
  const placed = cat !== 'sports' && cat !== 'entertainment';
  const local = placed && mentions(text, geo.local), regional = placed && mentions(text, geo.regional), state = placed && mentions(text, geo.washington);
  if (local) out.add('local');
  if (regional) out.add('regional');
  if (state) out.add('washington');
  if (cat === 'local' && !local && !regional && !state && s.localSource) out.add('local'); // "Local" from a local publisher, no place named
  const national = !out.has('world') && !out.has('sports') && cat !== 'entertainment' && mentions(text, US_TERMS) !== null;
  if (out.has('us') && (local || regional || state) && !national) out.delete('us'); // "Politics" about the Seattle council is not national news
  if (national) out.add('us');
  return { sections: out, localPriority: out.has('local') && mentions(text, geo.localPriority) !== null };
}

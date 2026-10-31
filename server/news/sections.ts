import type { GeoPrefs } from '../settings.js';

/**
 * Newspaper sections. A story's sections come from what it is ABOUT, never from where its publisher is:
 *  - topical sections (Business, Technology, Sports, World, U.S.) from the classification the story already has (Gemini's category, or a niche
 *    source's single default category), so nothing is asked of the model for layout;
 *  - geographic sections (Local, Washington) from the places named in the story's headline and summary, matched against the lists
 *    in Settings -> Geography (and the AI category 'Local' / 'Regional' / 'Washington' when it says so; Washington is the whole state, Greater Seattle included).
 * A story may belong to several sections. Pure functions: no database, no network.
 */
export const SECTIONS = ['local', 'washington', 'us', 'world', 'politics', 'business', 'technology', 'sports', 'outdoors', 'theology'] as const;
export type Section = (typeof SECTIONS)[number];
export const isSection = (s: string): s is Section => (SECTIONS as readonly string[]).includes(s);
export const SECTION_LABEL: Record<Section, string> = { local: 'Local', washington: 'Washington', us: 'U.S.', world: 'World', politics: 'Politics', business: 'Business', technology: 'Technology', sports: 'Sports', outdoors: 'Outdoors', theology: 'Theology' };
/** How far a story from the user's closest places (e.g. Des Moines, Federal Way) is lifted within Local. */
export const LOCAL_PRIORITY_BOOST = 0.5;

const CATEGORY: Record<Section, string[]> = {
  local: [], washington: ['washington', 'washington state', 'regional'],
  us: ['politics', 'u.s.', 'us', 'national'], world: ['world', 'international'], politics: ['politics'],
  business: ['business', 'economy', 'finance', 'markets', 'energy', 'industry', 'companies'],
  technology: ['technology', 'tech', 'ai', 'cybersecurity', 'science & technology'], sports: ['sports'],
  outdoors: ['outdoors', 'outdoor', 'hiking', 'outdoor recreation', 'outdoor sports', 'travel & outdoors'],
  theology: ['religion', 'theology', 'faith', 'christianity', 'church', 'religion & faith'],
};
/**
 * Hiking and outdoor-sports subjects named in the HEADLINE. Gemini's 'Outdoors' always counts; this catches stories it files under Sports, Health, Travel
 * or Other. Specific words only ("trail" alone would match the Trail Blazers and a paper trail), and Business / Technology / Politics stories keep their topic.
 */
const OUTDOORS = /\b(hik(?:e|es|ed|er|ers|ing)|backpack(?:ing|er|ers)|thru-?hik\w*|trailheads?|campsites?|campgrounds?|camping|mountaineer\w*|rock climb\w*|climbers?|trail running|trail runners?|ultramarathons?|kayak\w*|canoe\w*|paddleboard\w*|whitewater|backcountry|national parks?|wilderness|bikepacking|(?:Appalachian|Pacific Crest|Continental Divide) Trail|PCT|Cascades|Mount Rainier|Olympic Mountains|Mount Si)\b/i;
const NOT_OUTDOORS_CATEGORY = new Set(['business', 'technology', 'tech', 'politics', 'economy', 'finance', 'markets']);
export function isOutdoors(title: string, category: string | null): boolean {
  const cat = (category ?? '').trim().toLowerCase();
  return CATEGORY.outdoors.includes(cat) || (!NOT_OUTDOORS_CATEGORY.has(cat) && OUTDOORS.test(title));
}
/**
 * Religion and Christianity. Gemini's 'Religion' always counts. Otherwise the HEADLINE decides: words that are about religion whatever the category
 * (pope, Vatican, pastor, Bible, theology, evangelical, sermon...) count anywhere; words with other common meanings (church, bishop, Christian, Catholic,
 * prayer) count except in Sports, Entertainment, Business and Technology, where they are usually a surname, a team or a company.
 */
const THEOLOGY_STRONG = /\b(pope(?! county)|popes|papal|vatican|pastors?|preachers?|sermons?|theolog\w+|bible|biblical|scripture|gospel of|christianity|evangelical\w*|archbishop|diocese|dioceses|clergy|clergymen|congregations?|seminary|seminaries|missionar(?:y|ies)|synod|(?:church|christian|religious|protestant) denominations?|megachurch\w*|southern baptist|presbyterian|lutheran|methodist|anglican|episcopal church|orthodox church|church of england|christian (?:faith|leaders?|nationalis\w+|church\w*|college|university|school|music|worship)|christians|jesus|easter sunday|good friday|advent (?:calendar|season|sunday|wreath))\b/i;
const THEOLOGY_WEAK = /\b(church|churches|bishops?|catholics?|catholicism|baptists?|protestants?|christian|prayer|prayers|worship|faith leaders?|religious|religion|chaplains?|parishioners?|parish (?:priest|church|hall)|(?:youth|worship|associate|senior|lead|interim|ordained|church|christian|baptist|methodist|lutheran|presbyterian|anglican|evangelical|catholic|faith|interfaith|campus) ministers?|ministers? (?:of the gospel|at (?:the |a )?[\w' -]{1,30}(?:church|chapel|cathedral)))\b/i;
const NOT_THEOLOGY_CATEGORY = new Set(['sports', 'entertainment', 'business', 'technology', 'tech', 'economy', 'finance', 'markets']);
export function isTheology(title: string, category: string | null): boolean {
  const cat = (category ?? '').trim().toLowerCase();
  if (CATEGORY.theology.includes(cat)) return true;
  if (cat === 'sports' || cat === 'entertainment') return false;
  return THEOLOGY_STRONG.test(title) || (!NOT_THEOLOGY_CATEGORY.has(cat) && THEOLOGY_WEAK.test(title));
}
const US_TERMS = ['Congress', 'White House', 'Supreme Court', 'Pentagon', 'U.S. Senate', 'the Senate', 'U.S. House', 'federal government', 'Justice Department', 'Capitol Hill', 'the president'];
/** A following word that means the place name is somewhere else ("Des Moines, Iowa", "Kent State", "Des Moines Register"). */
const ELSEWHERE = /^(?:,\s*)?(?:iowa|ia\b|england|ohio|kentucky|ky\b|michigan|maine|connecticut|ontario|texas|california|oregon|florida|illinois|virginia|georgia|state\b|university\b|register\b)/i;

/**
 * Politics by MAIN EVENT, not by who is named: Gemini's 'Politics' always counts; otherwise only a political EVENT in the HEADLINE does (an election,
 * campaign, ballot, Congress, a bill or legislation, an executive order, a veto, government policy). A name alone never does, topical categories that are
 * clearly something else (Business, Technology, Sports, ...) are never relabelled, and municipal council / mayor decisions stay Local news.
 */
const ELECTION = /\b(elections?|elected|campaigns?|campaigning|candidates?|ballots?|primar(?:y|ies)|caucus(?:es)?|runoffs?|midterms?|voters?|nominee|nomination|incumbent)\b/i;
const GOVERNMENT = /\b(congress(?:ional)?|lawmakers?|legislat\w+|vetoe[sd]?|veto|executive orders?|white house|impeach\w*|filibuster|redistrict\w*|tariffs?|sanctions)\b/i;
const GOVERNMENT_CS = /\b(?:the |U\.S\. )?Senate\b|\bHouse (?:Republicans|Democrats|vote|passes|Speaker)\b|\b(?:pass(?:es|ed)?|signs?|signed|vetoe[sd]?|advance[sd]?|clears?|approves?|backs?|kills?|stalls?) (?:the |a |new |that |its )?(?:\w+ ){0,2}bills?\b|\bbills? (?:passes|passed|would|signed|vetoed|clears|advances|stalls|dies|fails)\b|\b[Gg]overnor (?:signs|vetoes|proposes|orders)\b/; // case-sensitive: "Bill Gates" is a person, "bill" a law
const NOT_POLITICAL_CATEGORY = new Set(['business', 'technology', 'tech', 'sports', 'entertainment', 'science', 'automotive', 'health', 'economy', 'finance', 'markets', 'energy', 'industry', 'companies']);
export function isPolitical(title: string, category: string | null): boolean {
  const cat = (category ?? '').trim().toLowerCase();
  if (cat === 'politics') return true;
  if (NOT_POLITICAL_CATEGORY.has(cat)) return false;
  return ELECTION.test(title) || ((GOVERNMENT.test(title) || GOVERNMENT_CS.test(title)) && !/\b(sports?|game|season|playoffs?)\b/i.test(title));
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const RE_CACHE = new Map<string, RegExp>();
const termRe = (t: string) => { let r = RE_CACHE.get(t); if (!r) { r = build(t); RE_CACHE.set(t, r); } return r; };
const build = (t: string) => new RegExp(`(?<![\\p{L}\\p{N}])${esc(t.trim()).replace(/-/g, '[-\\s]?').replace(/\s+/g, '\\s+')}(?![\\p{L}\\p{N}])`, 'giu');
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
 *    local place or a local-flagged publisher, and never when the text names only regional or statewide places (then it is Washington news);
 *  - 'Politics' counts for U.S. unless the story is about a named local or Washington place and says nothing national;
 *  - Sports and Entertainment stories keep to their own sections (a score that mentions "Seattle" is not Washington news).
 */
export function classify(s: SectionInput, geo: GeoPrefs): Classified {
  const text = `${s.title}. ${s.summary ?? ''}`;
  const cat = (s.category ?? '').trim().toLowerCase();
  const out = new Set<Section>();
  for (const sec of SECTIONS) if (CATEGORY[sec].includes(cat)) out.add(sec);
  const placed = cat !== 'sports' && cat !== 'entertainment';
  const local = placed && mentions(text, geo.local), state = placed && mentions(text, geo.washington);
  if (local) out.add('local');
  if (state) out.add('washington');
  if (cat === 'local' && !local && !state && s.localSource) out.add('local'); // "Local" from a local publisher, no place named
  const national = !out.has('world') && !out.has('sports') && cat !== 'entertainment' && mentions(text, US_TERMS) !== null;
  if (out.has('us') && (local || state) && !national) out.delete('us'); // "Politics" about the Seattle council is not national news
  if (national) out.add('us');
  if (!out.has('politics') && isPolitical(s.title, s.category)) out.add('politics');
  if (isOutdoors(s.title, s.category)) out.add('outdoors');
  if (isTheology(s.title, s.category)) out.add('theology');
  return { sections: out, localPriority: out.has('local') && mentions(text, geo.localPriority) !== null };
}

import { contradicts } from './contradiction.js';
import { articleSimilarity } from './cluster.js';

/**
 * Does an article that just joined a story you have already read report a genuinely NEW development, or is it the same news again?
 * Purely local and bounded (a handful of regexes over at most BASELINE_MAX short texts); Gemini is only asked about the ambiguous remainder.
 *
 *   duplicate   - the same facts again (very similar to something already covered)
 *   minor       - added detail, commentary, a new publisher or style, background: not a development
 *   substantive - a LATER-STAGE milestone appears in the headline that nothing in the existing coverage reported (a decision, an arrest or charge,
 *                 a recall, a revision of guidance, a leadership change, a corporate action, an outcome, a disaster milestone)
 *   ambiguous   - signs of a development that are not conclusive (the milestone is only in the body text, the headline reverses an earlier one,
 *                 new figures arrive with revision wording): the model may decide; with no answer the story stays read
 *
 * Deliberately conservative: a new publisher, a different headline style, a regenerated summary or extra commentary is never enough on its own.
 */
export type NoveltyKind = 'duplicate' | 'minor' | 'substantive' | 'ambiguous';
export interface Coverage { title: string; excerpt?: string | null }
export interface Novelty { kind: NoveltyKind; reasons: string[] }
export const BASELINE_MAX = 8, TEXT_MAX = 300;

/**
 * Later-stage milestones. Initial stages (announced, proposed, launched, under investigation) are never developments by themselves.
 * Legal developments are a LADDER of distinct stages, not one "legal" class: arrest -> charges -> trial -> verdict -> sentencing -> appeal. A story
 * moves forward only when a stage ABOVE every stage already reported appears; the same stage in other words, or an earlier stage reported late, is
 * not news. Conviction and acquittal are distinct verdicts (and contradict each other, which is handled as a reversal).
 */
const LEGAL: [string, RegExp, number][] = [
  ['arrest', /\b(arrest(?:s|ed)?|booked|detained|taken into custody|surrender(?:s|ed)?)\b/i, 1],
  ['charges', /\b(charged|charges? (?:filed|against)|indict(?:s|ed|ment)?|pleads?|pleaded|arraign(?:s|ed|ment))\b/i, 2],
  ['trial', /\b(trial (?:begins|opens|starts|gets under way)|jury selection|opening statements|testif(?:y|ies|ied) (?:at|in) (?:the )?trial)\b/i, 3],
  ['conviction', /\b(convict(?:s|ed|ion)?|found guilty|guilty verdict|pleads? guilty|pleaded guilty)\b/i, 4],
  ['acquittal', /\b(acquit(?:s|ted|tal)?|found not guilty|not guilty verdict|charges (?:dropped|dismissed)|case dismissed)\b/i, 4],
  ['sentencing', /\b(sentenc(?:e|es|ed|ing))\b/i, 5],
  ['appeal', /\b(appeal(?:s|ed)?|overturn(?:s|ed)? (?:the )?(?:conviction|verdict|sentence))\b/i, 6],
];
const STAGES: [string, RegExp][] = [
  ['decision', /\b(approv(?:e|es|ed|al)|reject(?:s|ed)?|vetoe?s?|vetoed|overturn(?:s|ed)?|upheld|upholds|struck down|signed into law|signs? (?:the |a )?(?:bill|law|order|measure)|passes|passed|voted (?:down|to)|scrap(?:s|ped)|shelve[sd]?|blocks?|blocked)\b/i],
  ['recall', /\brecall(?:s|ed)?\b/i],
  ['leadership', /\b(resign(?:s|ed|ation)?|steps? down|stepped down|fired|ousted|ousts|appointed|dies|died|killed)\b/i],
  ['corporate', /\b(acquir(?:e|es|ed|ing)|acquisition|takeover|merger|bankrupt(?:cy)?|lays? off|laid off|layoffs|shuts? down|shut down|halts?|suspend(?:s|ed)|settle[sd]?|settlement)\b/i],
  ['outcome', /\b(wins|won|defeats?|elected|concedes?|victory|champions?)\b/i],
  ['disaster', /\b(evacuat\w+|contained|extinguished|death toll|rescued|collapsed|explosion|erupt\w*)\b/i],
];
const LEGAL_RANK = new Map(LEGAL.map(([k, , r]) => [k, r]));
const GUIDANCE = /\b(guidance|outlook|forecast|dividend)\b/i, GUIDANCE_MOVE = /\b(rais(?:es|ed)|cuts?|lowers?|lowered|slash(?:es|ed)|revis(?:es|ed)|withdr(?:aws|ew)|suspends?)\b/i;
const REVISION = /\b(revised|revises|corrected|correction|walks? back|reverses|reversed|now says|now|up from|down from|previously|rises? to|climbs? to|jumps? to|toll)\b/i;
const NEGATED = /\b(not|no|never|won['’]?t|denies|denied|fails? to|failed to|without)\s+(?:\w+\s+){0,2}$/i;
/**
 * A milestone is only CONFIRMED when it is stated as having happened. Expectations, forecasts, possibilities, plans, conditions and questions are not:
 * "expected to approve", "could approve", "set to vote", "plans to", "likely to", "will", "if", and any headline that is a question. The hedge may sit just
 * before the verb ("may approve") or right after it ("approval expected").
 */
const HEDGE_BEFORE = /\b(expected to|expects? to|could|may|might|would|should|plans? to|planning to|plan would|considering|considers|weighs?|weighing|set to|slated to|likely to|poised to|about to|aims? to|seeks? to|hopes? to|will|to vote on whether|if|whether|whether to|ready to|bids? to|proposes? to)\s+(?:\w+\s+){0,2}$/i;
const HEDGE_AFTER = /^\s*(?:is |are |was |were )?(?:expected|likely|possible|uncertain|planned|pending|unclear|in doubt|soon|next week|this week)\b/i;
const QUESTION_LEAD = /^\s*(could|would|should|might|may|will|can|is|are|does|did|do|who|whether)\b/i;
const speculative = (piece: string, at: number, len: number) =>
  /\?\s*$/.test(piece.trim()) || (piece.includes('?') && QUESTION_LEAD.test(piece)) || HEDGE_BEFORE.test(piece.slice(Math.max(0, at - 36), at)) || HEDGE_AFTER.test(piece.slice(at + len, at + len + 28));
const figures = (t: string) => new Set(t.match(/\d[\d,.]*/g)?.map((x) => x.replace(/[,.]+$/, '')) ?? []);
const text = (c: Coverage) => `${c.title}. ${(c.excerpt ?? '').slice(0, TEXT_MAX)}`;

/** CONFIRMED milestone classes in one piece of text (negated and speculative mentions do not count). Legal stages are reported individually. */
function stagesIn(piece: string): Set<string> {
  const out = new Set<string>();
  const confirmed = (re: RegExp) => { for (const m of piece.matchAll(new RegExp(re.source, 'gi'))) { const at = m.index ?? 0; if (!NEGATED.test(piece.slice(Math.max(0, at - 24), at)) && !speculative(piece, at, m[0].length)) return true; } return false; };
  for (const [k, re] of STAGES) if (confirmed(re)) out.add(k);
  for (const [k, re] of LEGAL) if (confirmed(re)) out.add(k);
  if (GUIDANCE.test(piece) && GUIDANCE_MOVE.test(piece) && !speculative(piece, piece.search(GUIDANCE_MOVE), 4)) out.add('guidance');
  return out;
}
const stagesOf = (pieces: string[]) => pieces.reduce((acc, p) => { for (const k of stagesIn(p)) acc.add(k); return acc; }, new Set<string>());
/** A stage is new if the story has not reported it; for legal stages, only if it is also further along than anything the story has reported. */
function isNew(stage: string, seen: Set<string>): boolean {
  if (seen.has(stage)) return false;
  const rank = LEGAL_RANK.get(stage); if (rank === undefined) return true;
  const furthest = Math.max(0, ...[...seen].map((k) => LEGAL_RANK.get(k) ?? 0));
  return rank > furthest;
}

export function assessNovelty(article: Coverage, baseline: Coverage[]): Novelty {
  const known = baseline.slice(0, BASELINE_MAX);
  if (!known.length) return { kind: 'minor', reasons: ['nothing to compare against'] };
  const seenPieces = known.flatMap((k) => [k.title, (k.excerpt ?? '').slice(0, TEXT_MAX)]);
  const seenText = seenPieces.join(' ');
  const seen = stagesOf(seenPieces);
  const inTitle = stagesIn(article.title), inBody = stagesOf([article.title, (article.excerpt ?? '').slice(0, TEXT_MAX)]);
  const newInTitle = [...inTitle].filter((k) => isNew(k, seen));
  const newOnlyInBody = [...inBody].filter((k) => isNew(k, seen) && !inTitle.has(k));
  const reasons: string[] = [];
  if (known.some((k) => contradicts(article.title, k.title))) return { kind: 'ambiguous', reasons: ['headline reverses an earlier report'] };
  if (seen.has('conviction') && inTitle.has('acquittal') || seen.has('acquittal') && inTitle.has('conviction')) return { kind: 'ambiguous', reasons: ['a different verdict from the one already reported'] };
  if (newInTitle.length) return { kind: 'substantive', reasons: newInTitle.map((k) => `new milestone in the headline: ${k}`) };
  if (newOnlyInBody.length) return { kind: 'ambiguous', reasons: newOnlyInBody.map((k) => `milestone only in the body text: ${k}`) };
  const old = figures(seenText), fresh = [...figures(text(article))].filter((f) => !old.has(f));
  if (fresh.length && REVISION.test(text(article))) reasons.push(`new figures with revision wording: ${fresh.slice(0, 3).join(', ')}`);
  if (reasons.length) return { kind: 'ambiguous', reasons };
  const dup = Math.max(...known.map((k) => articleSimilarity(article, k)));
  return { kind: dup >= 0.6 ? 'duplicate' : 'minor', reasons: [dup >= 0.6 ? 'same facts again' : 'added detail or commentary only'] };
}

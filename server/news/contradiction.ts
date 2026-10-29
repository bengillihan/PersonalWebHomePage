import { normalizeTitle } from './normalize.js';

/**
 * Lightweight, local detection of headlines that make OPPOSITE claims ("approves" / "rejects"). Token overlap alone cannot tell them apart, so
 * a pair like "Seattle council approves housing proposal" / "...rejects housing proposal" scores 0.80 and used to merge automatically. Pure word
 * lists and a winner-swap check: no model, no network, no cost. Only consulted for pairs that are otherwise similar enough to group.
 */

// Each entry: [words meaning one thing, words meaning the opposite]. Lowercase, punctuation-free (as normalizeTitle produces). A word may appear in
// several groups. Deliberately about actions/outcomes, not topics, so that unrelated headlines are never affected.
const GROUPS: [string[], string[]][] = [
  [['approve', 'approves', 'approved', 'approving', 'authorize', 'authorizes', 'authorized'], ['reject', 'rejects', 'rejected', 'rejecting', 'deny', 'denies', 'denied', 'denying', 'veto', 'vetoes', 'vetoed', 'block', 'blocks', 'blocked', 'scrap', 'scraps', 'scrapped', 'shelve', 'shelves', 'shelved']],
  [['pass', 'passes', 'passed', 'passing'], ['fail', 'fails', 'failed', 'failing']],
  [['win', 'wins', 'won', 'winning', 'beat', 'beats', 'victory', 'triumph'], ['lose', 'loses', 'lost', 'losing', 'loss']],
  [['increase', 'increases', 'increased', 'raise', 'raises', 'raised', 'hike', 'hikes', 'hiked', 'boost', 'boosts', 'boosted', 'rise', 'rises', 'rose', 'surge', 'surges', 'surged', 'jump', 'jumps', 'jumped', 'climb', 'climbs', 'climbed', 'gain', 'gains', 'gained', 'soar', 'soars', 'soared', 'grow', 'grows', 'grew'],
    ['decrease', 'decreases', 'decreased', 'cut', 'cuts', 'slash', 'slashes', 'slashed', 'lower', 'lowers', 'lowered', 'fall', 'falls', 'fell', 'drop', 'drops', 'dropped', 'plunge', 'plunges', 'plunged', 'slide', 'slides', 'slid', 'sink', 'sinks', 'sank', 'decline', 'declines', 'declined', 'tumble', 'tumbles', 'tumbled', 'shrink', 'shrinks', 'shrank', 'lose', 'loses', 'lost']],
  [['up', 'higher', 'rally', 'rallies', 'rallied'], ['down', 'lower', 'slump', 'slumps', 'slumped']],
  [['confirm', 'confirms', 'confirmed'], ['deny', 'denies', 'denied', 'denying', 'refute', 'refutes', 'refuted']],
  [['sign', 'signs', 'signed'], ['veto', 'vetoes', 'vetoed', 'vetoing']],
  [['accept', 'accepts', 'accepted', 'agree', 'agrees', 'agreed'], ['reject', 'rejects', 'rejected', 'refuse', 'refuses', 'refused']],
  [['support', 'supports', 'supported', 'back', 'backs', 'backed', 'endorse', 'endorses', 'endorsed', 'favor', 'favors'], ['oppose', 'opposes', 'opposed', 'condemn', 'condemns', 'condemned']],
  [['open', 'opens', 'opened', 'reopen', 'reopens', 'reopened'], ['close', 'closes', 'closed', 'shut', 'shuts', 'shuttered']],
  [['hire', 'hires', 'hired', 'appoint', 'appoints', 'appointed'], ['fire', 'fires', 'fired', 'dismiss', 'dismisses', 'dismissed', 'sack', 'sacks', 'sacked', 'oust', 'ousts', 'ousted']],
  [['buy', 'buys', 'bought', 'acquire', 'acquires', 'acquired'], ['sell', 'sells', 'sold', 'divest', 'divests', 'divested']],
  [['uphold', 'upholds', 'upheld', 'affirm', 'affirms', 'affirmed'], ['overturn', 'overturns', 'overturned', 'block', 'blocks', 'blocked', 'reverse', 'reverses', 'reversed']],
  [['convict', 'convicts', 'convicted', 'guilty'], ['acquit', 'acquits', 'acquitted', 'cleared', 'exonerate', 'exonerates', 'exonerated', 'innocent']],
  [['allow', 'allows', 'allowed', 'permit', 'permits', 'permitted', 'legalize', 'legalizes', 'legalized', 'lift', 'lifts', 'lifted'], ['ban', 'bans', 'banned', 'prohibit', 'prohibits', 'prohibited', 'outlaw', 'outlaws', 'outlawed', 'forbid', 'forbids']],
  [['arrest', 'arrests', 'arrested', 'detain', 'detains', 'detained'], ['release', 'releases', 'released', 'free', 'frees', 'freed']],
  [['extend', 'extends', 'extended'], ['end', 'ends', 'ended', 'cancel', 'cancels', 'canceled', 'cancelled', 'terminate', 'terminates', 'terminated']],
  [['survive', 'survives', 'survived', 'recover', 'recovers', 'recovered'], ['die', 'dies', 'died', 'killed', 'kills', 'dead']],
  [['launch', 'launches', 'launched'], ['cancel', 'cancels', 'canceled', 'cancelled', 'postpone', 'postpones', 'postponed', 'delay', 'delays', 'delayed', 'scrap', 'scraps', 'scrapped']],
  [['advance', 'advances', 'advanced'], ['eliminate', 'eliminates', 'eliminated']],
  [['positive'], ['negative']],
];

const SIDE_A = GROUPS.map(([a]) => new Set(a));
const SIDE_B = GROUPS.map(([, b]) => new Set(b));
const NEGATORS = new Set(['not', 'never', 'no']);
const CONTRACTION_STEMS = new Set(['doesn', 'didn', 'don', 'won', 'wasn', 'isn', 'aren', 'weren', 'can', 'couldn', 'wouldn', 'shouldn', 'hasn', 'haven', 'hadn']);
const BEAT = new Set(['beat', 'beats', 'defeat', 'defeats', 'defeated', 'downs', 'topples', 'tops', 'edges', 'routs', 'stuns', 'outlasts']);

const words = (title: string) => normalizeTitle(title).split(' ').filter(Boolean);

/** +1 / -1 per group when the title takes a side (a nearby "not" flips it); 0 when it takes both sides, so it is ignored. */
function polarities(ws: string[]): Map<number, 1 | -1 | 0> {
  const out = new Map<number, 1 | -1 | 0>();
  ws.forEach((w, i) => {
    const prev = [ws[i - 1], ws[i - 2]];
    const negated = prev.some((p) => p !== undefined && (NEGATORS.has(p) || (p === 't' && CONTRACTION_STEMS.has(ws[ws.indexOf(p, Math.max(0, i - 2)) - 1] ?? ''))));
    GROUPS.forEach((_, g) => {
      const base: 1 | -1 | null = SIDE_A[g].has(w) ? 1 : SIDE_B[g].has(w) ? -1 : null;
      if (base === null) return;
      const side = (negated ? -base : base) as 1 | -1;
      const cur = out.get(g);
      out.set(g, cur === undefined || cur === side ? side : 0);
    });
  });
  return out;
}

/** "Seahawks beat 49ers" vs "49ers beat Seahawks": same words, opposite result. */
function swappedResult(a: string[], b: string[]): boolean {
  const parts = (ws: string[]) => { const i = ws.findIndex((w) => BEAT.has(w)); return i > 0 && i < ws.length - 1 ? { subject: ws[i - 1], object: ws[i + 1] } : null; };
  const x = parts(a), y = parts(b);
  return !!x && !!y && x.subject !== x.object && x.subject === y.object && x.object === y.subject;
}

/** True when the two headlines make opposing claims about (what looks like) the same thing. */
export function contradicts(a: string, b: string): boolean {
  const wa = words(a), wb = words(b);
  const pa = polarities(wa), pb = polarities(wb);
  for (const [g, v] of pa) { const u = pb.get(g); if (v !== 0 && u !== undefined && u !== 0 && u !== v) return true; }
  return swappedResult(wa, wb);
}

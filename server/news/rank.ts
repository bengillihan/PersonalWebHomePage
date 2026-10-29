import type { Prefs } from '../settings.js';

export interface Candidate {
  id: number;
  category: string | null;
  importance: number;
  lastPublishedAt: number;
  sourceCount: number;
  publishers: string[];
  isLocal: boolean;
  maxSourcePriority: number; // 0 low,1 normal,2 high
  interestScore: number; // 0..1 best interest match
  interestName: string | null;
  interestWeight?: number | null; // the 1-5 weight of the best-matching interest
  demotedBy?: string | null; // a low-priority topic this story matches (shown less often; never hidden)
  excluded: boolean; // matched an exclude rule
  rating: -1 | 0 | 1;
  readAt: number | null;
}

export interface FeedbackModel {
  categoryAffinity: Map<string, number>; // -1..1 topic signal (never mixed with source quality)
  sourceQuality: Map<string, number>; // -1..1 publisher signal
}

export interface ScoreParts { interests: number; importance: number; recency: number; source: number; feedback: number }
export interface Scored { c: Candidate; score: number; parts: ScoreParts; bucket: 'personalized' | 'major' | 'local' | 'other'; reasons: string[] }

export const RECENCY_HALF_LIFE_H = 18;
export const MAJOR_IMPORTANCE = 0.6;
export const INTEREST_MATCH = 0.25;
/** Score multiplier for a story matching a low-priority topic (it stays in the feed, just lower). */
export const DEMOTION = 0.6;

const clamp = (n: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, n));

export function scoreCandidate(c: Candidate, prefs: Prefs, fb: FeedbackModel, now = Date.now()): Scored {
  const w = prefs.weights;
  const total = w.interests + w.importance + w.recency + w.source + w.feedback || 1;
  const ageH = Math.max(0, (now - c.lastPublishedAt) / 3_600_000);
  const preferred = c.publishers.some((p) => prefs.preferredPublishers.includes(p));
  const muted = c.publishers.length > 0 && c.publishers.every((p) => prefs.mutedPublishers.includes(p));
  const catAff = c.category ? fb.categoryAffinity.get(c.category) ?? 0 : 0;
  const srcQ = avg(c.publishers.map((p) => fb.sourceQuality.get(p) ?? 0));

  const parts: ScoreParts = {
    interests: c.excluded ? 0 : c.interestScore,
    importance: clamp(c.importance + 0.04 * (c.sourceCount - 1)),
    recency: Math.pow(0.5, ageH / RECENCY_HALF_LIFE_H),
    source: muted ? 0 : clamp((preferred ? 0.9 : [0.3, 0.5, 0.8][c.maxSourcePriority]) + srcQ * 0.2),
    feedback: clamp(0.5 + c.rating * 0.5 + catAff * 0.25),
  };
  const demoted = Boolean(c.demotedBy) && parts.importance < MAJOR_IMPORTANCE; // major news is never pushed down by a low-priority topic
  const raw = (w.interests * parts.interests + w.importance * parts.importance + w.recency * parts.recency + w.source * parts.source + w.feedback * parts.feedback) / total;
  const score = demoted ? raw * DEMOTION : raw;

  let bucket: Scored['bucket'] = 'other';
  if (!c.excluded && !muted && !demoted && c.interestScore >= INTEREST_MATCH) bucket = 'personalized';
  else if (parts.importance >= MAJOR_IMPORTANCE) bucket = 'major';
  else if (c.isLocal || preferred) bucket = 'local';

  const reasons: string[] = [];
  if (c.interestScore >= INTEREST_MATCH && !c.excluded) reasons.push(`Matches your interest “${c.interestName}”${c.interestWeight ? ` (weight ${c.interestWeight} of 5)` : ''}`);
  if (demoted) reasons.push(`Shown less: matches your low-priority topic “${c.demotedBy}”`);
  if (parts.importance >= MAJOR_IMPORTANCE) reasons.push(`Major story (importance ${(parts.importance * 100).toFixed(0)}%)`);
  if (c.sourceCount > 1) reasons.push(`Reported by ${c.sourceCount} publishers`);
  if (c.isLocal) reasons.push('From a local source');
  if (preferred) reasons.push('From a publisher you prefer');
  if (c.rating === 1) reasons.push('You gave this story a thumbs-up');
  if (catAff > 0.2 && c.category) reasons.push(`You tend to like ${c.category} stories`);
  if (catAff < -0.2 && c.category) reasons.push(`You tend to skip ${c.category} stories`);
  if (srcQ < -0.2) reasons.push('Lowered: you rated this publisher poorly');
  if (parts.recency > 0.7) reasons.push('Very recent');
  if (!reasons.length) reasons.push('Included for balanced coverage');
  return { c, score, parts, bucket, reasons };
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/**
 * Interleaves buckets by quota using a deterministic largest-deficit scheme. Buckets that run dry are skipped,
 * so there is no artificial filler: remaining quota flows to the others. 'other' only fills when all three are empty.
 */
export function balanceFeed(scored: Scored[], quotas: Prefs['quotas']): Scored[] {
  const buckets: Record<'personalized' | 'major' | 'local', Scored[]> = { personalized: [], major: [], local: [] };
  const other: Scored[] = [];
  for (const s of scored) {
    if (s.c.excluded && s.bucket !== 'major') continue; // excluded-by-keyword items drop out unless genuinely major
    if (s.c.rating === -1) continue;
    if (s.bucket === 'other') other.push(s); else buckets[s.bucket].push(s);
  }
  for (const b of [...Object.values(buckets), other]) b.sort((a, b2) => b2.score - a.score);
  const names = ['personalized', 'major', 'local'] as const;
  const out: Scored[] = [];
  const taken = { personalized: 0, major: 0, local: 0 };
  const sumQ = quotas.personalized + quotas.major + quotas.local || 1;
  while (names.some((n) => buckets[n].length)) {
    let pick: (typeof names)[number] | null = null; let bestDeficit = -Infinity;
    const n = out.length + 1;
    for (const name of names) {
      if (!buckets[name].length) continue;
      const deficit = (quotas[name] / sumQ) * n - taken[name];
      if (deficit > bestDeficit) { bestDeficit = deficit; pick = name; }
    }
    if (!pick) break;
    out.push(buckets[pick].shift()!); taken[pick]++;
  }
  return out.concat(other);
}

/** Learns reversible topic/source affinities from persisted feedback rows (no model training). */
export function buildFeedbackModel(rows: { rating: number; reason: string | null; category: string | null; publishers: string[] }[]): FeedbackModel {
  const cat = new Map<string, { s: number; n: number }>(); const src = new Map<string, { s: number; n: number }>();
  const add = (m: typeof cat, k: string, v: number) => { const e = m.get(k) ?? { s: 0, n: 0 }; e.s += v; e.n++; m.set(k, e); };
  for (const r of rows) {
    if (r.rating === 1) { if (r.category) add(cat, r.category, 1); r.publishers.forEach((p) => add(src, p, 0.5)); continue; }
    switch (r.reason) {
      case 'topic': if (r.category) add(cat, r.category, -1); break;
      case 'source': r.publishers.forEach((p) => add(src, p, -1)); break;
      case 'low_importance': case 'already_knew': case 'duplicate': break; // not a topic or publisher judgement
      default: if (r.category) add(cat, r.category, -0.5); // bare thumbs-down: mild topic signal only
    }
  }
  const norm = (m: typeof cat) => new Map([...m].map(([k, v]) => [k, v.s / (v.n + 3)] as const)); // shrinkage toward 0
  return { categoryAffinity: norm(cat), sourceQuality: norm(src) };
}

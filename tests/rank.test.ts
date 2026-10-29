import { describe, it, expect } from 'vitest';
import { scoreCandidate, balanceFeed, buildFeedbackModel, type Candidate, type FeedbackModel } from '../server/news/rank.js';
import { DEFAULT_PREFS } from '../server/settings.js';
import { topicScore, splitDescription, type Topic } from '../server/news/topics.js';

const now = Date.now();
const empty: FeedbackModel = { categoryAffinity: new Map(), sourceQuality: new Map() };
let n = 0;
const cand = (o: Partial<Candidate> = {}): Candidate => ({ id: ++n, category: 'Business', importance: 0.3, lastPublishedAt: now - 3_600_000, sourceCount: 1, publishers: ['P'], isLocal: false, maxSourcePriority: 1, interestScore: 0, interestName: null, excluded: false, rating: 0, readAt: null, ...o });
const topic = (o: Partial<Topic>): Topic => ({ id: 1, name: 't', kind: 'interest', description: '', priority: 1, include: [], exclude: [], ...o });

describe('ranking', () => {
  it('default weights are 35/25/20/10/10', () => { expect(DEFAULT_PREFS.weights).toEqual({ interests: 0.35, importance: 0.25, recency: 0.2, source: 0.1, feedback: 0.1 }); });
  it('interest match outranks an equal non-match; recency decays', () => {
    const a = scoreCandidate(cand({ interestScore: 0.9, interestName: 'x' }), DEFAULT_PREFS, empty, now);
    const b = scoreCandidate(cand(), DEFAULT_PREFS, empty, now);
    expect(a.score).toBeGreaterThan(b.score); expect(a.bucket).toBe('personalized');
    const old = scoreCandidate(cand({ lastPublishedAt: now - 72 * 3_600_000 }), DEFAULT_PREFS, empty, now);
    expect(old.parts.recency).toBeLessThan(b.parts.recency);
  });
  it('weights are configurable', () => {
    const c = cand({ importance: 0.9 });
    const hi = scoreCandidate(c, { ...DEFAULT_PREFS, weights: { ...DEFAULT_PREFS.weights, importance: 1 } }, empty, now).score;
    const lo = scoreCandidate(c, { ...DEFAULT_PREFS, weights: { ...DEFAULT_PREFS.weights, importance: 0 } }, empty, now).score;
    expect(hi).not.toBe(lo);
  });
  it('major news appears without an interest match and explains why', () => {
    const s = scoreCandidate(cand({ importance: 0.9, sourceCount: 4 }), DEFAULT_PREFS, empty, now);
    expect(s.bucket).toBe('major'); expect(s.reasons.join(' ')).toMatch(/Major story/); expect(s.reasons.join(' ')).toMatch(/4 publishers/);
  });
  it('feedback changes ranking, and is reversible (rating 0 restores score)', () => {
    const base = scoreCandidate(cand(), DEFAULT_PREFS, empty, now).score;
    expect(scoreCandidate(cand({ rating: 1 }), DEFAULT_PREFS, empty, now).score).toBeGreaterThan(base);
    expect(scoreCandidate(cand({ rating: -1 }), DEFAULT_PREFS, empty, now).score).toBeLessThan(base);
    expect(scoreCandidate(cand({ rating: 0 }), DEFAULT_PREFS, empty, now).score).toBe(base);
  });
  it('keeps publisher quality and topic interest separate', () => {
    const topicDown = buildFeedbackModel([{ rating: -1, reason: 'topic', category: 'Sports', publishers: ['ESPN'] }, { rating: -1, reason: 'topic', category: 'Sports', publishers: ['ESPN'] }]);
    expect(topicDown.categoryAffinity.get('Sports')!).toBeLessThan(0); expect(topicDown.sourceQuality.get('ESPN') ?? 0).toBe(0);
    const srcDown = buildFeedbackModel([{ rating: -1, reason: 'source', category: 'Sports', publishers: ['ESPN'] }]);
    expect(srcDown.sourceQuality.get('ESPN')!).toBeLessThan(0); expect(srcDown.categoryAffinity.get('Sports') ?? 0).toBe(0);
    const neutral = buildFeedbackModel([{ rating: -1, reason: 'already_knew', category: 'Sports', publishers: ['ESPN'] }]);
    expect(neutral.categoryAffinity.size + neutral.sourceQuality.size).toBe(0);
  });
  it('muted publishers drop out of personalization; preferred publishers rank higher', () => {
    const muted = scoreCandidate(cand({ publishers: ['Spam'], interestScore: 0.9 }), { ...DEFAULT_PREFS, mutedPublishers: ['Spam'] }, empty, now);
    expect(muted.bucket).not.toBe('personalized');
    const pref = scoreCandidate(cand({ publishers: ['Fav'] }), { ...DEFAULT_PREFS, preferredPublishers: ['Fav'] }, empty, now);
    expect(pref.parts.source).toBeGreaterThan(scoreCandidate(cand(), DEFAULT_PREFS, empty, now).parts.source);
  });
});

describe('balanced coverage', () => {
  const mk = (bucketTag: 'p' | 'm' | 'l', k: number) => scoreCandidate(
    bucketTag === 'p' ? cand({ interestScore: 0.8, interestName: 'i', lastPublishedAt: now - k * 60_000 }) : bucketTag === 'm' ? cand({ importance: 0.9, lastPublishedAt: now - k * 60_000 }) : cand({ isLocal: true, lastPublishedAt: now - k * 60_000 }), DEFAULT_PREFS, empty, now);
  it('approximates 60/25/15 over the first 20 when every bucket is full', () => {
    const all = [...Array.from({ length: 30 }, (_, i) => mk('p', i)), ...Array.from({ length: 30 }, (_, i) => mk('m', i)), ...Array.from({ length: 30 }, (_, i) => mk('l', i))];
    const top = balanceFeed(all, DEFAULT_PREFS.quotas).slice(0, 20);
    const count = (b: string) => top.filter((s) => s.bucket === b).length;
    expect(count('personalized')).toBeGreaterThanOrEqual(11); expect(count('personalized')).toBeLessThanOrEqual(13);
    expect(count('major')).toBeGreaterThanOrEqual(4); expect(count('major')).toBeLessThanOrEqual(6);
    expect(count('local')).toBeGreaterThanOrEqual(2); expect(count('local')).toBeLessThanOrEqual(4);
  });
  it('does not create filler: empty buckets let others fill; downvoted/excluded stories are dropped', () => {
    const only = Array.from({ length: 10 }, (_, i) => mk('m', i));
    expect(balanceFeed(only, DEFAULT_PREFS.quotas)).toHaveLength(10);
    const down = scoreCandidate(cand({ rating: -1, importance: 0.9 }), DEFAULT_PREFS, empty, now);
    const ex = scoreCandidate(cand({ excluded: true, interestScore: 0.8 }), DEFAULT_PREFS, empty, now);
    expect(balanceFeed([down, ex], DEFAULT_PREFS.quotas)).toHaveLength(0);
  });
});

describe('natural-language interests (local matching)', () => {
  it('matches description tokens and keywords; honors "not ..." and exclude keywords', () => {
    const t = topic({ name: 'Local AI', description: 'new local AI hardware performance benchmarks, not generic AI press releases', include: ['llama.cpp'] });
    expect(splitDescription(t.description).negative).toMatch(/generic AI press releases/);
    expect(topicScore(t, 'New benchmarks show local AI hardware performance doubling on consumer GPUs')).toBeGreaterThan(0.5);
    expect(topicScore(t, 'Mayor announces road closures downtown')).toBe(0);
    expect(topicScore(t, 'llama.cpp adds new backend')).toBeGreaterThan(0.2);
    expect(topicScore(topic({ include: ['bmw'], exclude: ['lease deal'] }), 'BMW E91 lease deal this month')).toBe(0);
    const e91 = topic({ description: 'older BMW E91 maintenance' });
    expect(topicScore(e91, 'How to replace the water pump on a BMW E91 wagon: maintenance guide')).toBeGreaterThan(0.4);
    expect(topicScore(e91, 'Stock market closes higher')).toBe(0);
  });
});

import type { DB } from '../db.js';
import { getPrefs } from '../settings.js';
import { balanceFeed, buildFeedbackModel, INTEREST_MATCH, scoreCandidate, type Candidate, type Scored } from './rank.js';
import { loadTopics, weightFactor } from './topics.js';
import { byRank, isUsableSummary } from './cluster.js';
import { accessInfo, accessTier, type AccessInfo } from './access.js';
import { classify, isSection, SECTION_LABEL, LOCAL_PRIORITY_BOOST, type Section } from './sections.js';
import { FRONT_KEYS, getFrontMix, getGeo, type FrontKey } from '../settings.js';

export interface FeedQuery { tab: string; q?: string; topic?: string; cursor?: string; limit?: number }
export interface StoryDto {
  id: number; title: string; summary: string | null; summaryKind: string | null; differences: string | null;
  category: string | null; importance: number; publishedAt: number; updatedAt: number; sourceCount: number;
  isRead: boolean; isUpdated: boolean; bookmarked: boolean; rating: number; imageUrl: string | null;
  primary: { publisher: string; url: string; aggregated: boolean; access: AccessInfo } | null;
  articles: { id: number; publisher: string; title: string; url: string; publishedAt: number; aggregated: boolean; alsoVia: string[]; muted: boolean; access: AccessInfo }[];
  mutedSources: number; // distinct MUTED publishers also covering this story (listed, labelled, not counted in sourceCount)
  blockedBy: string[]; // enabled "Not interested" topics that match EVERY article of this story (it is hidden from feeds, shown in Saved/search)
  why?: { score: number; parts: Record<string, number>; reasons: string[]; bucket: string };
}
export interface FeedPage { items: StoryDto[]; nextCursor: string | null; total?: number }

/**
 * ELIGIBILITY (filtering), kept separate from ranking. A story may appear if ANY of its articles is
 *  - carried by a 'comprehensive' feed (originating feed or any other feed in article_sources), or
 *  - matches one of the user's interests and hits none of their exclude keywords (blocked stays blocked).
 * Interest-only feeds therefore only surface matching stories, a story also carried by a general feed stays eligible through it,
 * and nothing is ever deleted: changing interests or a feed's coverage changes the result immediately, with no re-ingestion.
 */
/**
 * Same as above, plus HARD EXCLUSIONS (Settings -> Interests -> Not interested), applied per ARTICLE before the story is judged: an article
 * that matches an enabled blocked topic cannot make a story eligible, but a story stays visible while at least one of its other articles
 * qualifies, so a single passing mention in one source never hides a story covered for other reasons. Used by every feed except Saved and
 * search; blocked articles stay in SQLite and remain reachable there.
 * MUTED PUBLISHERS work the same way (also article-level): an article from a muted publisher cannot make a story eligible, but the story stays while
 * an unmuted publisher still qualifies. Muting is a source preference, entirely separate from blocked topics.
 */
export const eligibleSql = (hardBlocks: boolean, mutedCount = 0) => `EXISTS (SELECT 1 FROM articles ea WHERE ea.cluster_id = c.id${mutedCount ? ` AND lower(ea.publisher) NOT IN (${Array(mutedCount).fill('?').join(',')})` : ''}${hardBlocks ? ` AND NOT EXISTS (SELECT 1 FROM article_blocks ab JOIN blocked_topics bt ON bt.id = ab.topic_id WHERE ab.article_id = ea.id AND bt.enabled = 1)` : ''} AND (
    EXISTS (SELECT 1 FROM sources es WHERE es.coverage = 'comprehensive' AND (es.id = ea.source_id
      OR EXISTS (SELECT 1 FROM article_sources ex WHERE ex.article_id = ea.id AND ex.source_id = es.id)))
    OR (ea.blocked = 0 AND EXISTS (SELECT 1 FROM article_topics et JOIN topics tp ON tp.id = et.topic_id WHERE et.article_id = ea.id AND tp.stance = 'prefer'))))`; // a "show less" match never authorizes a story
export const ELIGIBLE_SQL = eligibleSql(false);

const SNAPSHOT_MAX = 800; // candidate pool size, and the most ids a cursor can carry
const normName = (s: string) => s.trim().toLowerCase();
const esc = (s: string) => s.replace(/[\\%_]/g, (m) => '\\' + m);
const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const dec = (s?: string) => { try { return s ? JSON.parse(Buffer.from(s, 'base64url').toString()) : null; } catch { return null; } };

const BASE_SELECT = `SELECT c.id, c.title, c.summary, c.summary_kind, c.differences, c.category, c.importance, c.last_published_at, c.updated_at, c.substantive_at, c.source_count,
  c.primary_article_id, rs.read_at, rs.hidden_at, (b.cluster_id IS NOT NULL) AS bookmarked, COALESCE(f.rating, 0) AS rating
  FROM story_clusters c
  LEFT JOIN reading_state rs ON rs.cluster_id = c.id
  LEFT JOIN bookmarks b ON b.cluster_id = c.id
  LEFT JOIN feedback f ON f.cluster_id = c.id`;


/**
 * Filters shared by every feed (including the Front Page): retention, eligibility with blocked topics and muted publishers, hidden stories, and
 * "hide read stories". Saved keeps every bookmark; search keeps read stories findable. `where[0]` is always the recency bound.
 */
function commonFilters(prefs: ReturnType<typeof getPrefs>, tab: string, feedView: boolean, searching: boolean, where: string[], params: any[]) {
  const cutoff = Date.now() - prefs.retentionDays * 86_400_000;
  const muted = prefs.mutedPublishers.map(normName).filter(Boolean);
  if (tab !== 'saved') { where.push('c.last_published_at >= ?'); params.push(cutoff); where.push(eligibleSql(feedView, feedView ? muted.length : 0)); if (feedView) params.push(...muted); } // Saved always shows every bookmark
  if (tab !== 'saved') where.push('rs.hidden_at IS NULL');
  if (tab === 'unread') where.push('rs.read_at IS NULL'); // strictly unread
  // Read stories are hidden from the main feeds unless 'Show read stories' is on. Never hidden in Saved, in Unread's own rule above, or in
  // search (so previously viewed articles stay findable). Read is per story (cluster); a story reappears, marked Updated, when it gained
  // substantial new information after being read (substantive_at is advanced only by a material development such as a publisher correction; new coverage and merges of the same event do not reopen it).
  if (!prefs.showRead && !['saved', 'unread'].includes(tab) && !searching) where.push('(rs.read_at IS NULL OR c.substantive_at > rs.read_at)');
}

/** The stories of one section, best first: the usual relevance score (recency included), with the user's closest places lifted within Local. */
function sectionOrder(scored: Scored[], rows: any[], section: Section, geo: ReturnType<typeof getGeo>): Scored[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  return scored.flatMap((s) => {
    if (s.c.rating === -1 || (s.c.excluded && s.bucket !== 'major')) return []; // same drops as the For You feed
    const r = byId.get(s.c.id); const cls = classify({ category: r.category, title: r.title, summary: r.summary, localSource: s.c.isLocal }, geo);
    return cls.sections.has(section) ? [{ s, adj: s.score + (section === 'local' && cls.localPriority ? LOCAL_PRIORITY_BOOST : 0) }] : [];
  }).sort((a, b) => b.adj - a.adj).map((x) => x.s);
}

export function queryFeed(db: DB, fq: FeedQuery): FeedPage {
  const limit = Math.min(Math.max(fq.limit ?? 20, 1), 50);
  const prefs = getPrefs(db);
  const where: string[] = []; const params: any[] = [];
  const cutoff = Date.now() - prefs.retentionDays * 86_400_000;
  const feedView = !(fq.q ?? '').trim(); // exclusions (blocked topics, muted publishers) apply to the feeds, never to explicit search or Saved
  commonFilters(prefs, fq.tab, feedView, !!(fq.q ?? '').trim(), where, params);
  if (fq.tab === 'saved') where.push('b.cluster_id IS NOT NULL');
  if (fq.tab === 'topic' && fq.topic) {
    const t = loadTopics(db).find((x) => x.name === fq.topic);
    if (t?.kind === 'interest') { where.push('EXISTS (SELECT 1 FROM article_topics att JOIN articles a ON a.id = att.article_id WHERE a.cluster_id = c.id AND att.topic_id = ?)'); params.push(t.id); }
    else { where.push('c.category = ? COLLATE NOCASE'); params.push(fq.topic); }
  }
  for (const tok of (fq.q ?? '').trim().split(/\s+/).filter(Boolean).slice(0, 6)) {
    const like = `%${esc(tok)}%`;
    where.push(`(c.title LIKE ? ESCAPE '\\' OR c.summary LIKE ? ESCAPE '\\' OR c.category LIKE ? ESCAPE '\\' OR EXISTS (SELECT 1 FROM articles a WHERE a.cluster_id = c.id AND (a.publisher LIKE ? ESCAPE '\\' OR a.title LIKE ? ESCAPE '\\')))`);
    params.push(like, like, like, like, like);
  }

  const section = feedView && isSection(fq.tab) ? fq.tab : null; // newspaper sections are picked from the ranked pool, so they page like For You
  const ranked = (fq.tab === 'foryou' || fq.tab === 'explore' || section !== null) && !(fq.q ?? '').trim();
  if (!ranked) {
    const cur = dec(fq.cursor);
    if (cur) { where.push('(c.last_published_at < ? OR (c.last_published_at = ? AND c.id < ?))'); params.push(cur.t, cur.t, cur.i); }
    const rows = db.prepare(`${BASE_SELECT} WHERE ${where.join(' AND ')} ORDER BY c.last_published_at DESC, c.id DESC LIMIT ?`).all(...params, limit + 1) as any[];
    const page = rows.slice(0, limit);
    const items = hydrate(db, page, undefined, prefs.mutedPublishers);
    const last = page[page.length - 1];
    return { items, nextCursor: rows.length > limit && last ? enc({ t: last.last_published_at, i: last.id }) : null };
  }

  // Personalized/explore: ranking is computed over a bounded recent pool, then served from a SNAPSHOT of the ranked order. The cursor carries
  // the ids still to serve, in ranked order, so reading/hiding/re-ranking stories between page requests can never shift later pages (an
  // offset into a re-computed list skips unseen stories whenever the list shrinks). It is stateless, so it also survives the service
  // sleeping. A story that stopped qualifying in the meantime (e.g. read on another device) is simply dropped when its turn comes.
  where[0] = 'c.last_published_at >= ?'; params[0] = Math.max(cutoff, Date.now() - 14 * 86_400_000);
  const cur = dec(fq.cursor);
  let remaining: number[]; let total: number;
  if (Array.isArray(cur?.r)) { // later page: continue the snapshot
    remaining = (cur.r as unknown[]).filter((x): x is number => Number.isInteger(x) && (x as number) > 0).slice(0, SNAPSHOT_MAX);
    total = Number.isInteger(cur.t) ? cur.t : remaining.length;
  } else { // first page (or an older offset-style cursor, which restarts; the client de-duplicates): rank the pool now
    const pool = db.prepare(`${BASE_SELECT} WHERE ${where.join(' AND ')} ORDER BY c.last_published_at DESC LIMIT ${SNAPSHOT_MAX}`).all(...params) as any[];
    const scored = scoreRows(db, pool);
    const ordered: Scored[] = fq.tab === 'explore'
      ? scored.filter((s) => s.c.interestScore < 0.1 && !s.c.excluded && s.c.rating !== -1 && (s.parts.feedback >= 0.35)).sort((a, b) => b.c.importance * b.parts.recency - a.c.importance * a.parts.recency)
      : section ? sectionOrder(scored, pool, section, getGeo(db))
      : balanceFeed(scored, prefs.quotas);
    remaining = ordered.map((s) => s.c.id); total = ordered.length;
  }
  const page: any[] = []; let pos = 0;
  while (page.length < limit && pos < remaining.length) {
    const slice = remaining.slice(pos, pos + (limit - page.length)); pos += slice.length;
    const found = db.prepare(`${BASE_SELECT} WHERE ${where.join(' AND ')} AND c.id IN (${slice.map(() => '?').join(',')})`).all(...params, ...slice) as any[];
    const byId = new Map(found.map((r) => [r.id, r]));
    for (const id of slice) { const r = byId.get(id); if (r) page.push(r); } // snapshot order; ineligible-by-now stories are skipped
  }
  const next = remaining.slice(pos);
  const why = new Map(scoreRows(db, page).map((s) => [s.c.id, s]));
  return { items: hydrate(db, page, why, prefs.mutedPublishers), nextCursor: next.length ? enc({ r: next, t: total }) : null, total };
}

export interface FrontPage { lead: StoryDto | null; secondary: StoryDto[]; sections: { key: FrontKey; label: string; items: StoryDto[] }[] }
/** secondaryPerCategory: how many of the secondary stories one category may take. quota[w]: stories a section block shows for category weight w. */
export const FRONT = { secondary: 6, secondaryPerCategory: 2, quota: [0, 1, 2, 3, 3, 4] as readonly number[], majorFloor: 4 } as const;
/**
 * A story that belongs to several categories is placed under ONE, the most specific (this order), whatever the weights are. If that category is
 * switched off (weight 0) the story is left off the Front Page: it is never handed to another category with a higher weight, so a weight of 0 can
 * never make a story more prominent. Municipal and local-infrastructure stories are placed by their place (Local/Regional/Washington) before
 * Politics, and Business/Technology stories keep their topic even when they mention legislation (Politics needs a political main event).
 */
const PRIMARY_ORDER: FrontKey[] = ['local', 'regional', 'washington', 'politics', 'business', 'technology', 'outdoors', 'sports', 'us', 'world', 'other'];
const FRONT_LABEL = (k: FrontKey) => (k === 'other' ? 'More stories' : SECTION_LABEL[k]);

/**
 * The Front Page, built from ONE ranked pool (the same filters and scoring as For You) and the Front Page Mix:
 *  - every story gets one primary category (see PRIMARY_ORDER), independent of the weights; if that category's weight is 0 the story is left off the
 *    Front Page (it is still in its section, Search and Saved);
 *  - its Front Page score is its usual relevance score scaled by the category weight (weight 5 = full strength, 1 = well below), so category priority
 *    and story relevance/importance both count;
 *  - a story at or above the major-news importance gets a weight floor, so breaking news is not buried by a low weight (never above 0);
 *  - diversity: the secondary stories take at most `secondaryPerCategory` per category and each section block shows at most quota[weight] stories,
 *    so one busy category cannot fill the page;
 *  - each story appears once (lead, secondary, or its own primary section). Nothing here calls Gemini.
 */
export function queryFrontPage(db: DB): FrontPage {
  const prefs = getPrefs(db); const geo = getGeo(db); const mix = getFrontMix(db);
  const where: string[] = []; const params: any[] = [];
  commonFilters(prefs, 'foryou', true, false, where, params);
  params[0] = Math.max(params[0], Date.now() - 14 * 86_400_000);
  const pool = db.prepare(`${BASE_SELECT} WHERE ${where.join(' AND ')} ORDER BY c.last_published_at DESC LIMIT ${SNAPSHOT_MAX}`).all(...params) as any[];
  const rows = new Map(pool.map((r) => [r.id, r]));
  interface P { s: Scored; place: FrontKey; w: number; final: number; boost: number }
  const items: P[] = [];
  for (const s of scoreRows(db, pool)) {
    if (s.c.rating === -1 || (s.c.excluded && s.bucket !== 'major')) continue; // same drops as the For You feed
    const r = rows.get(s.c.id); const cls = classify({ category: r.category, title: r.title, summary: r.summary, localSource: s.c.isLocal }, geo);
    const major = mix.majorException && s.parts.importance >= mix.majorThreshold;
    const weightOf = (k: FrontKey) => { const w = mix.weights[k]; return w > 0 && major ? Math.max(w, FRONT.majorFloor) : w; };
    const cats = (cls.sections.size ? [...cls.sections] : ['other']) as FrontKey[];
    const place = PRIMARY_ORDER.find((k) => cats.includes(k)) ?? 'other'; // the story's main category, decided WITHOUT looking at any weight
    const w = weightOf(place);
    if (w <= 0) continue; // its main category is switched off: the story stays off the page rather than moving to a category with a higher weight
    items.push({ s, place, w, final: s.score * (0.3 + 0.7 * (w / 5)), boost: place === 'local' && cls.localPriority ? LOCAL_PRIORITY_BOOST : 0 });
  }
  const byFinal = (a: P, b: P) => b.final - a.final;
  const used = new Set<number>(); const take = (p: P) => { used.add(p.s.c.id); return p; };
  const leadScore = (p: P) => (0.3 + 0.7 * (p.w / 5)) * (p.s.score * 0.6 + p.s.parts.importance * 0.4); // relevance and importance, both scaled by the category weight
  const lead = [...items].sort((a, b) => leadScore(b) - leadScore(a)).slice(0, 1).map(take);
  const perCat = new Map<FrontKey, number>(); const secondary: P[] = [];
  for (const p of [...items].sort(byFinal)) {
    if (secondary.length >= FRONT.secondary) break;
    if (used.has(p.s.c.id) || (perCat.get(p.place) ?? 0) >= FRONT.secondaryPerCategory) continue;
    perCat.set(p.place, (perCat.get(p.place) ?? 0) + 1); secondary.push(take(p));
  }
  const keys = FRONT_KEYS.filter((k) => mix.weights[k] > 0).sort((a, b) => mix.weights[b] - mix.weights[a]); // heavier categories first; ties keep the nav order
  const blocks = keys.map((key) => {
    const quota = FRONT.quota[mix.weights[key]] ?? 0;
    const mine = items.filter((p) => p.place === key && !used.has(p.s.c.id)).sort((a, b) => (b.final + b.boost) - (a.final + a.boost)).slice(0, quota);
    mine.forEach(take); return { key, picks: mine };
  }).filter((b) => b.picks.length);
  const why = new Map([...lead, ...secondary, ...blocks.flatMap((b) => b.picks)].map((x) => [x.s.c.id, x.s]));
  const dto = (picks: P[]) => hydrate(db, picks.map((x) => rows.get(x.s.c.id)), why, prefs.mutedPublishers);
  return { lead: dto(lead)[0] ?? null, secondary: dto(secondary), sections: blocks.map((b) => ({ key: b.key, label: FRONT_LABEL(b.key), items: dto(b.picks) })) };
}

function scoreRows(db: DB, rows: any[]): Scored[] {
  if (!rows.length) return [];
  const prefs = getPrefs(db);
  const ids = rows.map((r) => r.id);
  const marks = ids.map(() => '?').join(',');
  const art = db.prepare(`SELECT a.cluster_id, a.publisher, s.is_local, s.priority FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.cluster_id IN (${marks})`).all(...ids) as any[];
  const byCluster = new Map<number, { pubs: Set<string>; local: boolean; prio: number }>();
  for (const a of art) {
    const e = byCluster.get(a.cluster_id) ?? { pubs: new Set(), local: false, prio: 0 };
    e.pubs.add(a.publisher); e.local ||= !!a.is_local; e.prio = Math.max(e.prio, a.priority); byCluster.set(a.cluster_id, e);
  }
  const topics = loadTopics(db);
  const topicRows = db.prepare(`SELECT a.cluster_id, att.topic_id, MAX(att.score) score FROM article_topics att JOIN articles a ON a.id = att.article_id WHERE a.cluster_id IN (${marks}) GROUP BY a.cluster_id, att.topic_id`).all(...ids) as any[];
  const bestTopic = new Map<number, { score: number; name: string; weight: number }>();
  const lessTopic = new Map<number, { score: number; name: string }>();
  for (const t of topicRows) {
    const topic = topics.find((x) => x.id === t.topic_id); if (!topic) continue;
    if (topic.stance === 'less') { if (t.score > (lessTopic.get(t.cluster_id)?.score ?? 0)) lessTopic.set(t.cluster_id, { score: t.score, name: topic.name }); continue; } // never boosts
    const s = Math.min(1, t.score * weightFactor(topic.weight));
    if (s > (bestTopic.get(t.cluster_id)?.score ?? 0)) bestTopic.set(t.cluster_id, { score: s, name: topic.name, weight: topic.weight });
  }
  const excludes = topics.filter((t) => t.kind === 'interest' && t.exclude.length);
  const fbRows = (db.prepare(`SELECT f.rating, f.reason, f.category, f.cluster_id FROM feedback f`).all() as any[]).map((r) => ({
    rating: r.rating, reason: r.reason, category: r.category,
    publishers: (db.prepare('SELECT DISTINCT a.publisher FROM feedback_sources fs JOIN articles a ON a.source_id = fs.source_id WHERE fs.cluster_id = ?').all(r.cluster_id) as any[]).map((x) => x.publisher),
  }));
  const model = buildFeedbackModel(fbRows);
  return rows.map((r) => {
    const g = byCluster.get(r.id);
    const text = `${r.title} ${r.summary ?? ''}`.toLowerCase();
    const cand: Candidate = {
      id: r.id, category: r.category, importance: r.importance, lastPublishedAt: r.last_published_at, sourceCount: r.source_count,
      publishers: [...(g?.pubs ?? [])], isLocal: g?.local ?? false, maxSourcePriority: g?.prio ?? 1,
      interestScore: bestTopic.get(r.id)?.score ?? 0, interestName: bestTopic.get(r.id)?.name ?? null,
      interestWeight: bestTopic.get(r.id)?.weight ?? null, demotedBy: (lessTopic.get(r.id)?.score ?? 0) >= INTEREST_MATCH ? lessTopic.get(r.id)!.name : null,
      excluded: excludes.some((t) => t.exclude.some((k) => k.trim() && text.includes(k.toLowerCase()))),
      rating: r.rating, readAt: r.read_at,
    };
    return scoreCandidate(cand, prefs, model);
  });
}

function hydrate(db: DB, rows: any[], why?: Map<number, Scored>, mutedNames: string[] = []): StoryDto[] {
  const preferFree = getPrefs(db).preferFreeCoverage;
  const mutedSet = new Set(mutedNames.map(normName));
  const isMuted = (a: { publisher: string }) => mutedSet.has(normName(a.publisher));
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const marks = ids.map(() => '?').join(',');
  const arts = db.prepare(`SELECT a.id, a.cluster_id, a.publisher, a.title, a.url, a.published_at, a.image_url, a.summary, a.summary_kind, a.access AS article_access, s.access AS source_access, s.priority, s.kind FROM articles a JOIN sources s ON s.id = a.source_id
    WHERE a.cluster_id IN (${marks}) ORDER BY a.published_at ASC, a.id ASC`).all(...ids) as any[];
  // Other feeds that carried the very same article (the originating publisher is unchanged; this is only 'also via').
  const via = new Map<number, string[]>();
  for (const v of db.prepare(`SELECT x.article_id, s.name FROM article_sources x JOIN articles a ON a.id = x.article_id JOIN sources s ON s.id = x.source_id
    WHERE a.cluster_id IN (${marks}) AND x.source_id != a.source_id ORDER BY s.name`).all(...ids) as { article_id: number; name: string }[]) (via.get(v.article_id) ?? via.set(v.article_id, []).get(v.article_id)!).push(v.name);
  const blockedArticles = new Map<number, string[]>();
  if (arts.length) for (const r of db.prepare(`SELECT ab.article_id, bt.name FROM article_blocks ab JOIN blocked_topics bt ON bt.id = ab.topic_id WHERE bt.enabled = 1 AND ab.article_id IN (${arts.map(() => '?').join(',')})`).all(...arts.map((a) => a.id)) as { article_id: number; name: string }[]) (blockedArticles.get(r.article_id) ?? blockedArticles.set(r.article_id, []).get(r.article_id)!).push(r.name);
  const by = new Map<number, any[]>();
  for (const a of arts) (by.get(a.cluster_id) ?? by.set(a.cluster_id, []).get(a.cluster_id)!).push(a);
  return rows.map((r) => {
    const list = by.get(r.id) ?? [];
    const prim0 = list.find((a) => a.id === r.primary_article_id) ?? list[0];
    // A muted publisher's headline/link is not the one shown while an unmuted publisher covers the story.
    const unmuted = list.filter((a) => !isMuted(a));
    const mutedHere = list.length - unmuted.length > 0 && unmuted.length > 0;
    // When a muted publisher is part of the story, the headline, link and excerpt all come from ONE unmuted article, preferring one that has usable text.
    const pickMuted = (subset: any[]) => [prim0, ...subset].find((a) => subset.includes(a) && !isMuted(a) && isUsableSummary(a.summary)) ?? (isMuted(prim0) || !subset.includes(prim0) ? subset[0] : prim0);
    let prim = !mutedHere ? prim0 : pickMuted(unmuted);
    // "Prefer free coverage": among the articles that may be shown (unmuted ones, or all if every publisher is muted) take the best access tier, and inside
    // that tier keep the story's existing choice (its stored primary, else its usual ranking). Off, or nothing to choose between: exactly the behaviour above.
    if (preferFree && list.length > 1) {
      const pool = unmuted.length ? unmuted : list;
      const tierOf = (a: any) => accessTier(a.article_access, a.source_access);
      const best = Math.min(...pool.map(tierOf)); const subset = pool.filter((a) => tierOf(a) === best);
      prim = mutedHere ? pickMuted(subset) : subset.includes(prim0) ? prim0 : [...subset].sort(byRank)[0];
    }
    // The stored cluster summary may be an excerpt from another publisher's article (a muted one, or one not chosen as primary) or a consolidated AI summary
    // written from muted text, so the visible article's own excerpt is shown instead (or headline-only when it gave none). A combined AI summary that is NOT
    // muted-tainted is kept and stays labelled "AI summary". Nothing is regenerated (no Gemini call).
    const useOwn = mutedHere || (prim !== prim0 && r.summary_kind !== 'ai');
    const own = useOwn && prim && isUsableSummary(prim.summary) ? prim : null;
    const publishers = (xs: { publisher: string }[]) => new Set(xs.map((a) => normName(a.publisher))).size;
    const w = why?.get(r.id);
    return {
      id: r.id, title: prim === prim0 ? r.title : prim.title,
      summary: useOwn ? own?.summary ?? null : r.summary, summaryKind: useOwn ? (own ? own.summary_kind : 'headline') : r.summary_kind, differences: mutedHere ? null : r.differences, category: r.category,
      importance: r.importance, publishedAt: r.last_published_at, updatedAt: r.updated_at,
      sourceCount: unmuted.length ? publishers(unmuted) : r.source_count, mutedSources: unmuted.length ? publishers(list.filter(isMuted)) : 0, // nothing unmuted to prefer: show the real coverage
      isRead: !!r.read_at, isUpdated: !!r.read_at && (r.substantive_at ?? 0) > r.read_at, bookmarked: !!r.bookmarked, rating: r.rating,
      imageUrl: prim?.image_url ?? null,
      primary: prim ? { publisher: prim.publisher, url: prim.url, aggregated: prim.kind === 'aggregator', access: accessInfo(prim.article_access, prim.source_access) } : null,
      articles: list.map((a) => ({ id: a.id, publisher: a.publisher, title: a.title, url: a.url, publishedAt: a.published_at, aggregated: a.kind === 'aggregator', alsoVia: via.get(a.id) ?? [], muted: isMuted(a), access: accessInfo(a.article_access, a.source_access) })),
      blockedBy: list.length && list.every((a) => blockedArticles.has(a.id)) ? [...new Set(list.flatMap((a) => blockedArticles.get(a.id)!))] : [],
      ...(w ? { why: { score: w.score, parts: w.parts as any, reasons: w.reasons, bucket: w.bucket } } : {}),
    };
  });
}

/** Explanation for any single story (used by "Why am I seeing this?" in non-ranked tabs too). */
export function explainStory(db: DB, id: number) {
  const row = db.prepare(`${BASE_SELECT} WHERE c.id = ?`).get(id) as any;
  if (!row) return null;
  const s = scoreRows(db, [row])[0];
  return { score: s.score, parts: s.parts, reasons: s.reasons, bucket: s.bucket, weights: getPrefs(db).weights };
}

import type { DB } from '../db.js';
import { getPrefs } from '../settings.js';
import { balanceFeed, buildFeedbackModel, scoreCandidate, type Candidate, type Scored } from './rank.js';
import { loadTopics } from './topics.js';

export interface FeedQuery { tab: string; q?: string; topic?: string; cursor?: string; limit?: number }
export interface StoryDto {
  id: number; title: string; summary: string | null; summaryKind: string | null; differences: string | null;
  category: string | null; importance: number; publishedAt: number; updatedAt: number; sourceCount: number;
  isRead: boolean; isUpdated: boolean; bookmarked: boolean; rating: number; imageUrl: string | null;
  primary: { publisher: string; url: string; aggregated: boolean } | null;
  articles: { id: number; publisher: string; title: string; url: string; publishedAt: number; aggregated: boolean; alsoVia: string[] }[];
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
export const ELIGIBLE_SQL = `EXISTS (SELECT 1 FROM articles ea WHERE ea.cluster_id = c.id AND (
    EXISTS (SELECT 1 FROM sources es WHERE es.coverage = 'comprehensive' AND (es.id = ea.source_id
      OR EXISTS (SELECT 1 FROM article_sources ex WHERE ex.article_id = ea.id AND ex.source_id = es.id)))
    OR (ea.blocked = 0 AND EXISTS (SELECT 1 FROM article_topics et WHERE et.article_id = ea.id))))`;

const esc = (s: string) => s.replace(/[\\%_]/g, (m) => '\\' + m);
const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const dec = (s?: string) => { try { return s ? JSON.parse(Buffer.from(s, 'base64url').toString()) : null; } catch { return null; } };

const BASE_SELECT = `SELECT c.id, c.title, c.summary, c.summary_kind, c.differences, c.category, c.importance, c.last_published_at, c.updated_at, c.source_count,
  c.primary_article_id, rs.read_at, rs.hidden_at, (b.cluster_id IS NOT NULL) AS bookmarked, COALESCE(f.rating, 0) AS rating
  FROM story_clusters c
  LEFT JOIN reading_state rs ON rs.cluster_id = c.id
  LEFT JOIN bookmarks b ON b.cluster_id = c.id
  LEFT JOIN feedback f ON f.cluster_id = c.id`;

export function queryFeed(db: DB, fq: FeedQuery): FeedPage {
  const limit = Math.min(Math.max(fq.limit ?? 20, 1), 50);
  const prefs = getPrefs(db);
  const where: string[] = []; const params: any[] = [];
  const cutoff = Date.now() - prefs.retentionDays * 86_400_000;
  // Saved lists every bookmark regardless of age (pruneOldData also keeps bookmarked stories); all other tabs honor retention.
  if (fq.tab !== 'saved') { where.push('c.last_published_at >= ?'); params.push(cutoff); where.push(ELIGIBLE_SQL); } // Saved always shows every bookmark
  if (fq.tab !== 'saved') where.push('rs.hidden_at IS NULL');
  if (fq.tab === 'unread') where.push('rs.read_at IS NULL');
  if (fq.tab === 'saved') where.push('b.cluster_id IS NOT NULL');
  if (fq.tab === 'local') where.push(`(c.category = 'Local' OR EXISTS (SELECT 1 FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.cluster_id = c.id AND s.is_local = 1))`);
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

  const ranked = (fq.tab === 'foryou' || fq.tab === 'explore') && !(fq.q ?? '').trim();
  if (!ranked) {
    const cur = dec(fq.cursor);
    if (cur) { where.push('(c.last_published_at < ? OR (c.last_published_at = ? AND c.id < ?))'); params.push(cur.t, cur.t, cur.i); }
    const rows = db.prepare(`${BASE_SELECT} WHERE ${where.join(' AND ')} ORDER BY c.last_published_at DESC, c.id DESC LIMIT ?`).all(...params, limit + 1) as any[];
    const page = rows.slice(0, limit);
    const items = hydrate(db, page);
    const last = page[page.length - 1];
    return { items, nextCursor: rows.length > limit && last ? enc({ t: last.last_published_at, i: last.id }) : null };
  }

  // Personalized/explore: score the recent candidate pool in memory (single user, bounded pool), then paginate by offset.
  where[0] = 'c.last_published_at >= ?'; params[0] = Math.max(cutoff, Date.now() - 14 * 86_400_000);
  const rows = db.prepare(`${BASE_SELECT} WHERE ${where.join(' AND ')} ORDER BY c.last_published_at DESC LIMIT 800`).all(...params) as any[];
  const scored = scoreRows(db, rows);
  let ordered: Scored[];
  if (fq.tab === 'explore') {
    ordered = scored.filter((s) => s.c.interestScore < 0.1 && !s.c.excluded && s.c.rating !== -1 && (s.parts.feedback >= 0.35))
      .sort((a, b) => b.c.importance * b.parts.recency - a.c.importance * a.parts.recency);
  } else ordered = balanceFeed(scored, prefs.quotas);
  const offset = Number(dec(fq.cursor)?.o ?? 0);
  const slice = ordered.slice(offset, offset + limit);
  const items = hydrate(db, slice.map((s) => rows.find((r) => r.id === s.c.id)), new Map(slice.map((s) => [s.c.id, s])));
  return { items, nextCursor: offset + limit < ordered.length ? enc({ o: offset + limit }) : null, total: ordered.length };
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
  const bestTopic = new Map<number, { score: number; name: string }>();
  for (const t of topicRows) {
    const w = [0.6, 1, 1.4][topics.find((x) => x.id === t.topic_id)?.priority ?? 1];
    const s = Math.min(1, t.score * w);
    if (s > (bestTopic.get(t.cluster_id)?.score ?? 0)) bestTopic.set(t.cluster_id, { score: s, name: topics.find((x) => x.id === t.topic_id)?.name ?? '' });
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
      excluded: excludes.some((t) => t.exclude.some((k) => k.trim() && text.includes(k.toLowerCase()))),
      rating: r.rating, readAt: r.read_at,
    };
    return scoreCandidate(cand, prefs, model);
  });
}

function hydrate(db: DB, rows: any[], why?: Map<number, Scored>): StoryDto[] {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const marks = ids.map(() => '?').join(',');
  const arts = db.prepare(`SELECT a.id, a.cluster_id, a.publisher, a.title, a.url, a.published_at, a.image_url, s.kind FROM articles a JOIN sources s ON s.id = a.source_id
    WHERE a.cluster_id IN (${marks}) ORDER BY a.published_at ASC`).all(...ids) as any[];
  // Other feeds that carried the very same article (the originating publisher is unchanged; this is only 'also via').
  const via = new Map<number, string[]>();
  for (const v of db.prepare(`SELECT x.article_id, s.name FROM article_sources x JOIN articles a ON a.id = x.article_id JOIN sources s ON s.id = x.source_id
    WHERE a.cluster_id IN (${marks}) AND x.source_id != a.source_id ORDER BY s.name`).all(...ids) as { article_id: number; name: string }[]) (via.get(v.article_id) ?? via.set(v.article_id, []).get(v.article_id)!).push(v.name);
  const by = new Map<number, any[]>();
  for (const a of arts) (by.get(a.cluster_id) ?? by.set(a.cluster_id, []).get(a.cluster_id)!).push(a);
  return rows.map((r) => {
    const list = by.get(r.id) ?? [];
    const prim = list.find((a) => a.id === r.primary_article_id) ?? list[0];
    const w = why?.get(r.id);
    return {
      id: r.id, title: r.title, summary: r.summary, summaryKind: r.summary_kind, differences: r.differences, category: r.category,
      importance: r.importance, publishedAt: r.last_published_at, updatedAt: r.updated_at, sourceCount: r.source_count,
      isRead: !!r.read_at, isUpdated: !!r.read_at && r.updated_at > r.read_at, bookmarked: !!r.bookmarked, rating: r.rating,
      imageUrl: prim?.image_url ?? null,
      primary: prim ? { publisher: prim.publisher, url: prim.url, aggregated: prim.kind === 'aggregator' } : null,
      articles: list.map((a) => ({ id: a.id, publisher: a.publisher, title: a.title, url: a.url, publishedAt: a.published_at, aggregated: a.kind === 'aggregator', alsoVia: via.get(a.id) ?? [] })),
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

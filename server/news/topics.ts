import type { DB } from '../db.js';
import { getSetting, setSetting } from '../db.js';
import { getPrefs } from '../settings.js';
import { normalizeTitle, tokens } from './normalize.js';

export interface Topic { id: number; name: string; kind: 'category' | 'interest'; description: string; priority: number; include: string[]; exclude: string[]; weight: number; stance: 'prefer' | 'less' }

/** Legacy 3-level priority (low/normal/high) expressed on the 1-5 scale, chosen so existing topics keep their exact multipliers (0.6 / 1 / 1.4). */
export const LEGACY_WEIGHT = [2, 3, 5] as const;
/** How strongly a 1-5 interest weight scales a topic match. */
export const weightFactor = (w: number): number => ({ 1: 0.4, 2: 0.6, 3: 1, 4: 1.2, 5: 1.4 } as Record<number, number>)[w] ?? 1;
/** Legacy priority column value that corresponds to a 1-5 weight (kept in sync so older code paths and exports stay meaningful). */
export const priorityForWeight = (w: number): 0 | 1 | 2 => (w <= 2 ? 0 : w >= 5 ? 2 : 1);

export function loadTopics(db: DB): Topic[] {
  return (db.prepare('SELECT * FROM topics ORDER BY name').all() as any[]).map((r) => ({
    id: r.id, name: r.name, kind: r.kind, description: r.description, priority: r.priority,
    include: JSON.parse(r.include_keywords), exclude: JSON.parse(r.exclude_keywords),
    weight: r.weight ?? LEGACY_WEIGHT[r.priority] ?? 3, stance: r.stance === 'less' ? 'less' : 'prefer',
  }));
}

/** Splits "X, not generic Y" into positive and negative clauses. */
export function splitDescription(desc: string): { positive: string; negative: string } {
  const m = desc.split(/\b(?:not|excluding|except|without|no)\b/i);
  return { positive: m[0] ?? '', negative: m.slice(1).join(' ') };
}

const has = (hay: string, phrase: string) => ` ${hay} `.includes(` ${normalizeTitle(phrase)} `);

/** Cheap, model-free relevance of a text to an interest topic. Returns 0 (none/excluded) .. 1. */
export function topicScore(topic: Topic, text: string): number {
  const norm = normalizeTitle(text);
  const textTokens = new Set(tokens(text));
  if (topic.exclude.some((k) => k.trim() && has(norm, k))) return 0;
  const { positive, negative } = splitDescription(topic.description);
  const negTokens = tokens(negative);
  if (negTokens.length >= 2 && negTokens.filter((t) => textTokens.has(t)).length >= Math.min(negTokens.length, 2) && !tokens(positive).every((t) => textTokens.has(t))) {
    // The negative clause describes what the user does NOT want; only suppress when positive intent is not fully satisfied.
    if (negTokens.filter((t) => textTokens.has(t)).length === negTokens.length) return 0;
  }
  const kwHits = topic.include.filter((k) => k.trim() && has(norm, k)).length;
  const dTokens = [...new Set(tokens(positive))];
  const matched = dTokens.filter((t) => textTokens.has(t)).length;
  const overlap = dTokens.length === 0 ? 0 : matched >= Math.min(2, dTokens.length) ? Math.min(1, matched / Math.min(dTokens.length, 4)) : 0;
  return Math.min(1, kwHits * 0.6 + overlap * 0.8);
}

/** True if the text hits any exclude keyword (whole-phrase match, same rule topicScore uses). */
export function isBlocked(excludes: string[], text: string): boolean {
  if (!excludes.length) return false;
  const norm = normalizeTitle(text);
  return excludes.some((k) => has(norm, k));
}
const excludeList = (topics: Topic[]) => topics.filter((t) => t.kind === 'interest').flatMap((t) => t.exclude).filter((k) => k.trim());

/**
 * Recomputes article_topics and the 'blocked' flag for every article inside the retention window. Only local string matching:
 * no AI calls, summaries untouched, so changing interests makes already-collected articles eligible without re-ingestion.
 */
export function reindexTopics(db: DB, sinceMs = Date.now() - getPrefs(db).retentionDays * 86_400_000): number {
  const topics = loadTopics(db);
  const interests = topics.filter((t) => t.kind === 'interest');
  const excludes = excludeList(topics);
  let n = 0;
  db.transaction(() => {
    db.prepare('DELETE FROM article_topics').run();
    if (!excludes.length) db.prepare('UPDATE articles SET blocked = 0 WHERE blocked = 1').run();
    if (!interests.length && !excludes.length) return;
    const ins = db.prepare('INSERT OR REPLACE INTO article_topics (article_id, topic_id, score) VALUES (?,?,?)');
    const setBlocked = db.prepare('UPDATE articles SET blocked = ? WHERE id = ?');
    for (const a of db.prepare('SELECT id, title, excerpt, summary, blocked FROM articles WHERE published_at >= ?').all(sinceMs) as any[]) {
      const text = `${a.title} ${a.summary ?? ''} ${a.excerpt ?? ''}`;
      for (const topic of interests) { const sc = topicScore(topic, text); if (sc >= 0.2) { ins.run(a.id, topic.id, sc); n++; } }
      const blocked = isBlocked(excludes, text) ? 1 : 0;
      if (blocked !== a.blocked) setBlocked.run(blocked, a.id);
    }
  })();
  return n;
}

/** Indexes freshly ingested/changed articles against the current interests. */
export function indexArticleTopics(db: DB, articleIds: number[]): void {
  const topics = loadTopics(db);
  const interests = topics.filter((t) => t.kind === 'interest');
  const excludes = excludeList(topics);
  if (!articleIds.length || (!interests.length && !excludes.length)) return;
  const ins = db.prepare('INSERT OR REPLACE INTO article_topics (article_id, topic_id, score) VALUES (?,?,?)');
  const del = db.prepare('DELETE FROM article_topics WHERE article_id = ?');
  const get = db.prepare('SELECT title, excerpt, summary, blocked FROM articles WHERE id = ?');
  const setBlocked = db.prepare('UPDATE articles SET blocked = ? WHERE id = ?');
  db.transaction(() => {
    for (const id of articleIds) {
      const a = get.get(id) as any; if (!a) continue;
      const text = `${a.title} ${a.summary ?? ''} ${a.excerpt ?? ''}`;
      del.run(id);
      for (const topic of interests) { const sc = topicScore(topic, text); if (sc >= 0.2) ins.run(id, topic.id, sc); }
      const blocked = isBlocked(excludes, text) ? 1 : 0;
      if (blocked !== a.blocked) setBlocked.run(blocked, id);
    }
  })();
}

/** One-time backfill after migration 3 so existing deployments get correct topic/blocked data. */
export function ensureTopicIndex(db: DB): boolean {
  if (getSetting(db, 'topic_index_v3', false)) return false;
  reindexTopics(db); setSetting(db, 'topic_index_v3', true);
  return true;
}

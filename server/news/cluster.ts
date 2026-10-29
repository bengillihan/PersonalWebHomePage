import type { DB } from '../db.js';
import type { Ai } from '../ai/gemini.js';
import { entities, jaccard, tokens } from './normalize.js';

export const MERGE_THRESHOLD = 0.55;
export const UNCERTAIN_THRESHOLD = 0.36;
const WINDOW_MS = 48 * 3600_000;

export interface Headline { title: string; publishedAt: number }

/** Local similarity of two headlines in [0,1]. Penalises conflicting figures so separate developments stay separate. */
export function headlineSimilarity(a: string, b: string): number {
  const ta = tokens(a), tb = tokens(b);
  const tokenSim = jaccard(ta, tb);
  const ea = entities(a), eb = entities(b);
  const entSim = jaccard(ea, eb);
  const shared = ta.filter((t) => tb.includes(t)).length;
  let score = 0.6 * tokenSim + 0.4 * entSim;
  if (shared < 2) score *= 0.5;
  const numsA = [...ea].filter((x) => /^\d/.test(x)), numsB = [...eb].filter((x) => /^\d/.test(x));
  if (numsA.length && numsB.length && !numsA.some((n) => numsB.includes(n))) score -= 0.15;
  return Math.max(0, score);
}

export function createSingleton(db: DB, articleId: number): number {
  const a = db.prepare('SELECT id, title, published_at, importance FROM articles WHERE id = ?').get(articleId) as any;
  const now = Date.now();
  const id = Number(db.prepare(`INSERT INTO story_clusters (primary_article_id, title, first_published_at, last_published_at, updated_at, created_at, importance)
    VALUES (?,?,?,?,?,?,?)`).run(a.id, a.title, a.published_at, a.published_at, now, now, a.importance ?? 0.3).lastInsertRowid);
  db.prepare('UPDATE articles SET cluster_id = ? WHERE id = ?').run(id, articleId);
  db.prepare('INSERT OR REPLACE INTO cluster_articles (cluster_id, article_id, manual, added_at) VALUES (?,?,0,?)').run(id, articleId, now);
  return id;
}

function moveArticle(db: DB, articleId: number, to: number, manual = 0) {
  const from = (db.prepare('SELECT cluster_id FROM articles WHERE id = ?').get(articleId) as any)?.cluster_id as number | null;
  db.prepare('UPDATE articles SET cluster_id = ? WHERE id = ?').run(to, articleId);
  db.prepare('INSERT OR REPLACE INTO cluster_articles (cluster_id, article_id, manual, added_at) VALUES (?,?,?,?)').run(to, articleId, manual, Date.now());
  if (from && from !== to) db.prepare('DELETE FROM cluster_articles WHERE cluster_id = ? AND article_id = ?').run(from, articleId);
  return from;
}

/** Recomputes derived cluster fields from members. Deletes the cluster if empty. */
export function recomputeCluster(db: DB, clusterId: number, bumpUpdated = false): void {
  const members = db.prepare(`SELECT a.id, a.title, a.publisher, a.published_at, a.importance, a.ai_category, a.summary, a.summary_kind, s.priority
    FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.cluster_id = ?`).all(clusterId) as any[];
  if (!members.length) { db.prepare('DELETE FROM story_clusters WHERE id = ?').run(clusterId); return; }
  const rank = (m: any) => (m.summary_kind === 'ai' ? 2 : m.summary_kind === 'excerpt' ? 1 : 0) * 10 + m.priority * 3;
  const primary = [...members].sort((a, b) => rank(b) - rank(a) || a.published_at - b.published_at)[0];
  const pubs = new Set(members.map((m) => m.publisher));
  const importance = Math.min(1, Math.max(...members.map((m) => m.importance ?? 0.3)) + 0.04 * (pubs.size - 1));
  db.prepare(`UPDATE story_clusters SET primary_article_id=?, title=?, category=?, importance=?, article_count=?, source_count=?,
    first_published_at=?, last_published_at=? WHERE id=?`)
    .run(primary.id, primary.title, primary.ai_category, importance, members.length, pubs.size,
      Math.min(...members.map((m) => m.published_at)), Math.max(...members.map((m) => m.published_at)), clusterId);
  if (members.length === 1 || !db.prepare('SELECT summary FROM story_clusters WHERE id = ?').get(clusterId)) {
    db.prepare('UPDATE story_clusters SET summary=?, summary_kind=?, differences=NULL, summary_hash=NULL WHERE id=?').run(primary.summary, primary.summary_kind, clusterId);
  }
  if (bumpUpdated) db.prepare('UPDATE story_clusters SET updated_at = ? WHERE id = ?').run(Date.now(), clusterId);
}

/** Assigns each new article to an existing cluster, or creates a singleton. Returns touched cluster ids. */
export async function clusterArticles(db: DB, ai: Ai | null, articleIds: number[], maxAiPairs = 20): Promise<Set<number>> {
  const touched = new Set<number>();
  const uncertain: { id: number; articleId: number; clusterId: number; a: any; b: any }[] = [];
  const getArt = db.prepare('SELECT id, title, publisher, published_at FROM articles WHERE id = ?');
  const cands = db.prepare(`SELECT a.id, a.title, a.publisher, a.published_at, a.cluster_id FROM articles a
    WHERE a.cluster_id IS NOT NULL AND a.id != ? AND a.published_at BETWEEN ? AND ?`);
  let pairId = 0;
  for (const id of articleIds) {
    const art = getArt.get(id) as any;
    if (!art) continue;
    const existing = (db.prepare('SELECT cluster_id, cluster_locked FROM articles WHERE id = ?').get(id) as any);
    if (existing.cluster_id) { touched.add(existing.cluster_id); continue; }
    let best = { score: 0, clusterId: 0, other: null as any };
    for (const c of cands.all(id, art.published_at - WINDOW_MS, art.published_at + WINDOW_MS) as any[]) {
      const s = headlineSimilarity(art.title, c.title);
      if (s > best.score) best = { score: s, clusterId: c.cluster_id, other: c };
    }
    if (best.score >= MERGE_THRESHOLD) {
      moveArticle(db, id, best.clusterId); touched.add(best.clusterId);
      recomputeCluster(db, best.clusterId, true);
    } else {
      const cid = createSingleton(db, id); touched.add(cid);
      if (best.score >= UNCERTAIN_THRESHOLD && ai?.canCall() && uncertain.length < maxAiPairs) {
        uncertain.push({ id: ++pairId, articleId: id, clusterId: best.clusterId, a: art, b: best.other });
      }
    }
  }
  if (uncertain.length && ai) {
    const verdicts = await ai.verifyPairs(uncertain.map((u) => ({ id: u.id, a: { publisher: u.a.publisher, title: u.a.title, publishedAt: u.a.published_at }, b: { publisher: u.b.publisher, title: u.b.title, publishedAt: u.b.published_at } })));
    for (const u of uncertain) {
      if (verdicts.get(u.id) !== true) continue; // unknown or false => keep separate
      const locked = (db.prepare('SELECT cluster_locked FROM articles WHERE id = ?').get(u.articleId) as any).cluster_locked;
      if (locked) continue;
      const old = moveArticle(db, u.articleId, u.clusterId);
      touched.add(u.clusterId);
      if (old) { recomputeCluster(db, old); touched.delete(old); }
      recomputeCluster(db, u.clusterId, true);
    }
  }
  return touched;
}

/** Manual ungroup: article leaves its cluster and is locked out of automatic regrouping. */
export function ungroupArticle(db: DB, articleId: number): number {
  const row = db.prepare('SELECT cluster_id FROM articles WHERE id = ?').get(articleId) as any;
  if (!row) throw new Error('Article not found');
  const old = row.cluster_id as number;
  if ((db.prepare('SELECT COUNT(*) n FROM articles WHERE cluster_id = ?').get(old) as any).n < 2) return old;
  db.prepare('UPDATE articles SET cluster_id = NULL, cluster_locked = 1 WHERE id = ?').run(articleId);
  db.prepare('DELETE FROM cluster_articles WHERE article_id = ?').run(articleId);
  const fresh = createSingleton(db, articleId);
  recomputeCluster(db, old); recomputeCluster(db, fresh);
  db.prepare('UPDATE story_clusters SET summary_hash = NULL WHERE id = ?').run(old);
  return fresh;
}

/**
 * Folds the user state of `others` into `target`. Must run BEFORE the obsolete clusters are deleted, because
 * bookmarks / feedback / reading_state / feedback_sources all cascade-delete with their cluster.
 *
 * Conflict rules:
 *  - bookmark: saved if ANY cluster was saved; keeps the earliest created_at.
 *  - read: read only if EVERY cluster was read (unread wins, so nothing new is buried); read_at = latest of them.
 *    The merge also bumps updated_at, so a fully read story shows "Updated".
 *  - hidden: hidden only if EVERY cluster was hidden (hiding one part must not bury the rest).
 *  - feedback (one row per cluster): the most recently updated rating wins. Equal ratings are combined
 *    (earliest created_at, any recorded reason, union of rated publishers); a losing opposite rating is dropped.
 *    No per-rating history is kept, so the dropped opposite rating is not recoverable.
 */
function transferUserState(db: DB, target: number, others: number[]): void {
  const all = [target, ...others];
  const marks = all.map(() => '?').join(',');

  const bm = db.prepare(`SELECT MIN(created_at) AS t FROM bookmarks WHERE cluster_id IN (${marks})`).get(...all) as { t: number | null };
  if (bm.t !== null) db.prepare('INSERT OR REPLACE INTO bookmarks (cluster_id, created_at) VALUES (?, ?)').run(target, bm.t);

  const rs = db.prepare(`SELECT read_at, hidden_at FROM reading_state WHERE cluster_id IN (${marks})`).all(...all) as { read_at: number | null; hidden_at: number | null }[];
  const everyone = (col: 'read_at' | 'hidden_at') => (rs.length === all.length && rs.every((r) => r[col] !== null) ? Math.max(...rs.map((r) => r[col]!)) : null);
  const readAt = everyone('read_at'), hiddenAt = everyone('hidden_at');
  if (readAt !== null || hiddenAt !== null || rs.length) {
    db.prepare(`INSERT INTO reading_state (cluster_id, read_at, hidden_at) VALUES (?,?,?)
      ON CONFLICT(cluster_id) DO UPDATE SET read_at = excluded.read_at, hidden_at = excluded.hidden_at`).run(target, readAt, hiddenAt);
  }

  const fb = db.prepare(`SELECT * FROM feedback WHERE cluster_id IN (${marks}) ORDER BY updated_at DESC, cluster_id`).all(...all) as
    { cluster_id: number; rating: number; reason: string | null; category: string | null; created_at: number; updated_at: number }[];
  if (fb.length) {
    const winner = fb[0];
    const same = fb.filter((f) => f.rating === winner.rating);
    const sources = db.prepare(`SELECT DISTINCT source_id FROM feedback_sources WHERE cluster_id IN (${same.map(() => '?').join(',')})`).all(...same.map((f) => f.cluster_id)) as { source_id: number }[];
    db.prepare('DELETE FROM feedback WHERE cluster_id = ?').run(target);
    db.prepare('DELETE FROM feedback_sources WHERE cluster_id = ?').run(target);
    db.prepare('INSERT INTO feedback (cluster_id, rating, reason, category, created_at, updated_at) VALUES (?,?,?,?,?,?)').run(
      target, winner.rating, winner.reason ?? same.find((f) => f.reason)?.reason ?? null, winner.category,
      Math.min(...same.map((f) => f.created_at)), winner.updated_at);
    for (const s of sources) db.prepare('INSERT OR IGNORE INTO feedback_sources (cluster_id, source_id) VALUES (?,?)').run(target, s.source_id);
  }
}

/** Manual merge of several clusters into the first. Atomic: user state moves to the survivor before the others are deleted. */
export function mergeClusters(db: DB, clusterIds: number[]): number {
  const [target, ...rest] = [...new Set(clusterIds)]; // a repeated id must never be treated as "another" cluster to delete
  if (!target || !rest.length) throw new Error('Need at least two clusters');
  db.transaction(() => {
    const found = (db.prepare(`SELECT id FROM story_clusters WHERE id IN (${[target, ...rest].map(() => '?').join(',')})`).all(target, ...rest) as { id: number }[]).length;
    if (found !== rest.length + 1) throw new Error('Cluster not found');
    transferUserState(db, target, rest);
    for (const from of rest) {
      for (const m of db.prepare('SELECT id FROM articles WHERE cluster_id = ?').all(from) as { id: number }[]) {
        moveArticle(db, m.id, target, 1);
        db.prepare('UPDATE articles SET cluster_locked = 1 WHERE id = ?').run(m.id);
      }
      db.prepare('DELETE FROM story_clusters WHERE id = ?').run(from);
    }
    db.prepare('UPDATE story_clusters SET summary_hash = NULL WHERE id = ?').run(target);
    recomputeCluster(db, target, true);
  })();
  return target;
}

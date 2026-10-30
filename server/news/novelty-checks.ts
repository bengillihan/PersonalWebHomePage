import type { DB } from '../db.js';
import type { Ai } from '../ai/gemini.js';
import { sha256 } from './normalize.js';

/**
 * Durable pending "is this a genuinely new development?" checks (see novelty.ts for the local part). A check is created only for cases the local rules
 * call ambiguous, and it survives restarts: it is retried on later normal refreshes (no timer, no worker) until it is answered, expires or fails for good.
 *
 *  - BASELINE: the coverage the user had read, FROZEN when the check is created. A retry never re-reads the story (which by then contains the article itself).
 *  - ONE QUESTION PER (article, content hash): repeated refreshes cannot queue it twice, and a corrected article is a new question (the old one expires).
 *  - BUDGET: at most MAX_PER_RUN questions go to Gemini per run, and only while the atomic daily budget allows; otherwise they simply wait.
 *  - FAILURES: an unanswered question is retried with exponential backoff and gives up after MAX_ATTEMPTS ('failed'); only new article content asks again.
 *  - NEVER STALE: before asking, and again before applying a verdict, the check must still describe reality (same article text, same story, baseline still
 *    in it, story still read and not yet reopened, and not read again since the development). Otherwise it expires without a model request.
 */
export const MAX_PER_RUN = 10, MAX_ATTEMPTS = 4, BACKOFF_BASE_MS = 15 * 60_000, BACKOFF_MAX_MS = 6 * 3_600_000, PENDING_TTL_MS = 7 * 86_400_000, KEEP_DONE_MS = 14 * 86_400_000;

export interface BaselineItem { publisher: string; title: string; excerpt: string | null; hash: string; id?: number }
export const baselineHash = (b: { hash: string }[]) => sha256(b.map((x) => x.hash).sort().join(','));

/** Records one ambiguous question (idempotent: the same article text is only ever queued once). Returns whether a new row was created. */
export function enqueueCheck(db: DB, c: { clusterId: number; articleId: number; articleHash: string; baseline: BaselineItem[]; eventAt: number }, now = Date.now()): boolean {
  return db.prepare(`INSERT OR IGNORE INTO novelty_checks (article_id, cluster_id, article_hash, baseline, baseline_hash, event_at, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(c.articleId, c.clusterId, c.articleHash, JSON.stringify(c.baseline), baselineHash(c.baseline), c.eventAt, now, now).changes === 1;
}

/**
 * The article's text changed only COSMETICALLY (case, punctuation, whitespace, feed boilerplate): its open questions are still about the same news. They are
 * re-pointed at the new content hash (here, and inside other checks' frozen baselines that include this article) WITHOUT touching the baseline's wording, so
 * validation keeps passing and a retry still compares against the original baseline. If a row for the new hash already exists, the old question is expired
 * instead of creating a duplicate.
 */
export function rehashChecksFor(db: DB, articleId: number, clusterId: number | null, oldHash: string, newHash: string, now = Date.now()): void {
  const own = db.prepare("SELECT id FROM novelty_checks WHERE article_id = ? AND status = 'pending' AND article_hash = ?").get(articleId, oldHash) as { id: number } | undefined;
  if (own) {
    if (db.prepare('SELECT 1 FROM novelty_checks WHERE article_id = ? AND article_hash = ?').get(articleId, newHash)) db.prepare("UPDATE novelty_checks SET status = 'expired', updated_at = ? WHERE id = ?").run(now, own.id);
    else db.prepare('UPDATE novelty_checks SET article_hash = ?, updated_at = ? WHERE id = ?').run(newHash, now, own.id);
  }
  if (clusterId === null) return;
  for (const r of db.prepare("SELECT id, baseline FROM novelty_checks WHERE status = 'pending' AND cluster_id = ?").all(clusterId) as { id: number; baseline: string }[]) {
    const items = JSON.parse(r.baseline) as BaselineItem[]; let touched = false;
    for (const b of items) if (b.id === articleId && b.hash === oldHash) { b.hash = newHash; touched = true; } // the identity used for validation, not the compared wording
    if (touched) db.prepare('UPDATE novelty_checks SET baseline = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(items), now, r.id); // baseline_hash (the cache identity) is kept as first computed
  }
}

/** The article changed materially or moved: its open questions no longer describe it. */
export function expireChecksFor(db: DB, articleId: number, now = Date.now()): void {
  db.prepare("UPDATE novelty_checks SET status = 'expired', updated_at = ? WHERE article_id = ? AND status = 'pending'").run(now, articleId);
}

interface Row { id: number; article_id: number; cluster_id: number; article_hash: string; baseline: string; baseline_hash: string; event_at: number; attempts: number }

/** Does this check still describe reality? (Used before asking and again before applying an answer.) */
function stillValid(db: DB, r: Row): { ok: true; publisher: string; title: string; excerpt: string | null; baseline: BaselineItem[] } | { ok: false } {
  const a = db.prepare('SELECT publisher, title, excerpt, content_hash, cluster_id FROM articles WHERE id = ?').get(r.article_id) as { publisher: string; title: string; excerpt: string | null; content_hash: string; cluster_id: number | null } | undefined;
  if (!a || a.content_hash !== r.article_hash || a.cluster_id !== r.cluster_id) return { ok: false }; // corrected, moved, ungrouped or gone
  const st = db.prepare('SELECT rs.read_at, c.substantive_at FROM reading_state rs JOIN story_clusters c ON c.id = rs.cluster_id WHERE rs.cluster_id = ?').get(r.cluster_id) as { read_at: number | null; substantive_at: number | null } | undefined;
  if (!st?.read_at || r.event_at <= st.read_at || (st.substantive_at ?? 0) > st.read_at) return { ok: false }; // unread, read again since, or already reopened
  const baseline = JSON.parse(r.baseline) as BaselineItem[];
  for (const b of baseline) { // every article of the baseline must still be in the story with the text that was compared
    if (b.id === undefined) continue;
    const m = db.prepare('SELECT content_hash, cluster_id FROM articles WHERE id = ?').get(b.id) as { content_hash: string; cluster_id: number | null } | undefined;
    if (!m || m.cluster_id !== r.cluster_id || m.content_hash !== b.hash) return { ok: false };
  }
  return { ok: true, publisher: a.publisher, title: a.title, excerpt: a.excerpt, baseline };
}

/**
 * Works through due checks. Cheap when there is nothing to do (one indexed query). Called from every news refresh; never from a timer.
 * Returns how many were sent to the model (for tests and logs).
 */
export async function runNoveltyChecks(db: DB, ai: Ai | null, now = Date.now()): Promise<{ asked: number; applied: number }> {
  db.prepare("UPDATE novelty_checks SET status = 'expired', updated_at = ? WHERE status = 'pending' AND created_at < ?").run(now, now - PENDING_TTL_MS); // bounded lifetime
  db.prepare("DELETE FROM novelty_checks WHERE status != 'pending' AND updated_at < ?").run(now - KEEP_DONE_MS);
  const due = db.prepare("SELECT id, article_id, cluster_id, article_hash, baseline, baseline_hash, event_at, attempts FROM novelty_checks WHERE status = 'pending' AND next_attempt_at <= ? ORDER BY created_at, id LIMIT 50").all(now) as Row[];
  if (!due.length) return { asked: 0, applied: 0 };
  const live: { row: Row; v: Extract<ReturnType<typeof stillValid>, { ok: true }> }[] = [];
  for (const row of due) { const v = stillValid(db, row); if (v.ok) live.push({ row, v }); else db.prepare("UPDATE novelty_checks SET status = 'expired', updated_at = ? WHERE id = ?").run(now, row.id); }
  if (!live.length || !ai || typeof ai.assessDevelopments !== 'function' || !ai.canCall()) return { asked: 0, applied: 0 }; // no model or no budget: they wait for a later refresh
  const batch = live.slice(0, MAX_PER_RUN);
  const verdicts = await ai.assessDevelopments(batch.map(({ row, v }, i) => ({ id: i + 1, articleHash: row.article_hash, baselineHash: row.baseline_hash, article: { publisher: v.publisher, title: v.title, excerpt: v.excerpt }, baseline: v.baseline })));
  const budgetLeft = ai.canCall();
  let applied = 0;
  db.transaction(() => {
    batch.forEach(({ row }, i) => {
      const answer = verdicts.get(i + 1); const t = Date.now();
      if (answer === undefined) { // no usable answer
        if (!budgetLeft) return; // the budget or a quota back-off ended it: not the check's fault, it just waits
        const attempts = row.attempts + 1;
        if (attempts >= MAX_ATTEMPTS) db.prepare("UPDATE novelty_checks SET status = 'failed', attempts = ?, last_error = 'no usable answer', updated_at = ? WHERE id = ?").run(attempts, t, row.id);
        else db.prepare("UPDATE novelty_checks SET attempts = ?, next_attempt_at = ?, last_error = 'no usable answer', updated_at = ? WHERE id = ?").run(attempts, t + Math.min(BACKOFF_BASE_MS * 2 ** row.attempts, BACKOFF_MAX_MS), t, row.id);
        return;
      }
      const cur = db.prepare("SELECT id, article_id, cluster_id, article_hash, baseline, baseline_hash, event_at, attempts, status FROM novelty_checks WHERE id = ?").get(row.id) as (Row & { status: string }) | undefined;
      if (!cur || cur.status !== 'pending') return; // expired or replaced while the model was thinking
      const v = stillValid(db, cur); // the world may have changed while the model was thinking (a cosmetic edit re-pointed the row; a material one expired it)
      if (!v.ok) { db.prepare("UPDATE novelty_checks SET status = 'expired', updated_at = ? WHERE id = ?").run(t, row.id); return; }
      if (answer) { db.prepare('UPDATE story_clusters SET substantive_at = ? WHERE id = ?').run(t, row.cluster_id); applied++; }
      db.prepare("UPDATE novelty_checks SET status = 'done', verdict = ?, attempts = attempts + 1, updated_at = ? WHERE id = ?").run(answer ? 1 : 0, t, row.id);
    });
  })();
  return { asked: batch.length, applied };
}

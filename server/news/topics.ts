import type { DB } from '../db.js';
import { normalizeTitle, tokens } from './normalize.js';

export interface Topic { id: number; name: string; kind: 'category' | 'interest'; description: string; priority: number; include: string[]; exclude: string[] }

export function loadTopics(db: DB): Topic[] {
  return (db.prepare('SELECT * FROM topics ORDER BY name').all() as any[]).map((r) => ({
    id: r.id, name: r.name, kind: r.kind, description: r.description, priority: r.priority,
    include: JSON.parse(r.include_keywords), exclude: JSON.parse(r.exclude_keywords),
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

/** Recomputes article_topics for recent articles. Only local string matching: no AI calls, summaries untouched. */
export function reindexTopics(db: DB, sinceMs = Date.now() - 30 * 86_400_000): number {
  const interests = loadTopics(db).filter((t) => t.kind === 'interest');
  db.prepare('DELETE FROM article_topics').run();
  if (!interests.length) return 0;
  const ins = db.prepare('INSERT OR REPLACE INTO article_topics (article_id, topic_id, score) VALUES (?,?,?)');
  let n = 0;
  const rows = db.prepare('SELECT id, title, excerpt, summary, publisher FROM articles WHERE published_at >= ?').all(sinceMs) as any[];
  db.transaction(() => {
    for (const a of rows) {
      const text = `${a.title} ${a.summary ?? ''} ${a.excerpt ?? ''}`;
      for (const t of interests) {
        const s = topicScore(t, text);
        if (s >= 0.2) { ins.run(a.id, t.id, s); n++; }
      }
    }
  })();
  return n;
}

export function indexArticleTopics(db: DB, articleIds: number[]): void {
  const interests = loadTopics(db).filter((t) => t.kind === 'interest');
  if (!interests.length || !articleIds.length) return;
  const ins = db.prepare('INSERT OR REPLACE INTO article_topics (article_id, topic_id, score) VALUES (?,?,?)');
  const del = db.prepare('DELETE FROM article_topics WHERE article_id = ?');
  const get = db.prepare('SELECT title, excerpt, summary FROM articles WHERE id = ?');
  db.transaction(() => {
    for (const id of articleIds) {
      const a = get.get(id) as any; if (!a) continue;
      del.run(id);
      for (const t of interests) { const s = topicScore(t, `${a.title} ${a.summary ?? ''} ${a.excerpt ?? ''}`); if (s >= 0.2) ins.run(id, t.id, s); }
    }
  })();
}

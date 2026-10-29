import type { DB } from '../db.js';
import { getSetting, setSetting } from '../db.js';
import { getPrefs } from '../settings.js';
import { normalizeTitle } from './normalize.js';

/**
 * "Not interested": hard topic exclusions. Entirely local string matching: no AI request is ever made here. Stored AI classifications are
 * reused (a topic may also name categories). Results are kept per ARTICLE in article_blocks; the feed decides story eligibility from them
 * (see query.ts), so one article mentioning a topic never hides a story that other articles cover for other reasons.
 */
export interface BlockedTopic { id: number; name: string; description: string; keywords: string[]; categories: string[]; enabled: boolean; seeded: boolean }

const GENERIC = new Set(['news', 'game', 'games', 'score', 'scores', 'player', 'players', 'team', 'teams', 'trade', 'trades', 'sports', 'sport', 'season', 'coach', 'league', 'match', 'matches', 'result', 'results', 'update', 'updates', 'story', 'stories', 'article', 'articles', 'coverage', 'commentary', 'highlights']);
// Only news-ish filler is stripped from the end. Words like scores/games/trades/matches stay in the phrase ("video games" must not become "video"); the preview shows exactly what will match.
const TRAILING = /\s+(news|stories|story|articles?|coverage|updates?|highlights|commentary|rumou?rs|anymore|any more|please)$/i;
const LEADING = /^(?:i\s+(?:do\s*n['’]?t|dont)\s+(?:want|care about|like)\s+|please\s+|to\s+(?:see|hear\s+about|read)\s+|see\s+|(?:any\s+)?more\s+|no\s+|not\s+|never\s+|any\s+|all\s+|anything\s+(?:about\s+)?|everything\s+(?:about\s+)?|stories\s+(?:about\s+)?|articles\s+(?:about\s+)?|news\s+(?:about\s+)?|about\s+|related\s+to\s+|regarding\s+|on\s+)/i;

/** Turns natural language ("hockey news, NHL scores and trades") into the phrases that will be matched. Generic words never stand alone. */
export function parseBlockPhrases(input: string): string[] {
  const out: string[] = [];
  for (const raw of input.split(/[,;\n]|\band\b|\bor\b/i)) {
    let p = raw.trim().replace(/\s+/g, ' ');
    for (let i = 0; i < 4; i++) { const next = p.replace(LEADING, ''); if (next === p) break; p = next; }
    for (let i = 0; i < 3; i++) { const next = p.replace(TRAILING, ''); if (next === p) break; p = next; }
    p = p.replace(/^[\s"'“”‘’.]+|[\s"'“”‘’.!?]+$/g, '').trim();
    if (p.length < 3 || p.length > 60) continue;
    const words = normalizeTitle(p).split(' ').filter(Boolean);
    if (!words.length || words.every((w) => GENERIC.has(w))) continue;
    if (!out.some((x) => x.toLowerCase() === p.toLowerCase())) out.push(p);
  }
  return out.slice(0, 30);
}

export function loadBlockedTopics(db: DB): BlockedTopic[] {
  return (db.prepare('SELECT * FROM blocked_topics ORDER BY name').all() as any[]).map((r) => ({
    id: r.id, name: r.name, description: r.description, keywords: JSON.parse(r.keywords), categories: JSON.parse(r.categories), enabled: !!r.enabled, seeded: !!r.seed_key,
  }));
}

interface Prepared { title: string; body: string; category: string | null }
const prepare = (a: { title: string; excerpt: string | null; summary: string | null; ai_category: string | null }): Prepared => ({
  title: ` ${normalizeTitle(a.title)} `, body: ` ${normalizeTitle(`${a.excerpt ?? ''} ${a.summary ?? ''}`)} `, category: a.ai_category,
});
const hit = (hay: string, phrase: string) => hay.includes(` ${phrase} `);

/**
 * An article is about the topic if a keyword is in its HEADLINE, or at least two different keywords appear in its text, or its stored AI
 * classification is one of the topic's categories. A single passing mention in the body is not enough.
 */
export function matchesBlock(topic: Pick<BlockedTopic, 'keywords' | 'categories'>, p: Prepared): boolean {
  if (p.category && topic.categories.some((c) => c.toLowerCase() === p.category!.toLowerCase())) return true;
  const phrases = topic.keywords.map((k) => normalizeTitle(k)).filter(Boolean);
  if (phrases.some((k) => hit(p.title, k))) return true;
  return phrases.filter((k) => hit(p.body, k)).length >= 2;
}

/** Matches for new/changed/re-classified articles against every topic (enabled or not, so toggling later needs no recompute). */
export function indexArticleBlocks(db: DB, articleIds: number[]): void {
  if (!articleIds.length) return;
  const topics = loadBlockedTopics(db); if (!topics.length) return;
  const get = db.prepare('SELECT title, excerpt, summary, ai_category FROM articles WHERE id = ?');
  const del = db.prepare('DELETE FROM article_blocks WHERE article_id = ?');
  const ins = db.prepare('INSERT OR IGNORE INTO article_blocks (article_id, topic_id) VALUES (?,?)');
  db.transaction(() => {
    for (const id of articleIds) {
      const a = get.get(id) as any; if (!a) continue;
      const p = prepare(a); del.run(id);
      for (const t of topics) if (matchesBlock(t, p)) ins.run(id, t.id);
    }
  })();
}

/** Recomputes matches over the retention window for one topic (after it is added/edited) or all topics. Local and fast; no AI. */
export function reindexBlocks(db: DB, onlyTopicId?: number): number {
  const topics = loadBlockedTopics(db).filter((t) => (onlyTopicId ? t.id === onlyTopicId : true));
  const since = Date.now() - getPrefs(db).retentionDays * 86_400_000;
  let n = 0;
  db.transaction(() => {
    if (onlyTopicId) db.prepare('DELETE FROM article_blocks WHERE topic_id = ?').run(onlyTopicId); else db.prepare('DELETE FROM article_blocks').run();
    if (!topics.length) return;
    const ins = db.prepare('INSERT OR IGNORE INTO article_blocks (article_id, topic_id) VALUES (?,?)');
    for (const a of db.prepare('SELECT id, title, excerpt, summary, ai_category FROM articles WHERE published_at >= ?').all(since) as any[]) {
      const p = prepare(a);
      for (const t of topics) if (matchesBlock(t, p)) { ins.run(a.id, t.id); n++; }
    }
  })();
  return n;
}

/** What a topic definition WOULD hide among recent articles (nothing is saved). Used for previews before blocking. */
export function previewBlock(db: DB, def: { keywords: string[]; categories: string[] }): { matches: number; samples: { title: string; publisher: string }[] } {
  const since = Date.now() - getPrefs(db).retentionDays * 86_400_000;
  let matches = 0; const samples: { title: string; publisher: string }[] = [];
  for (const a of db.prepare('SELECT title, publisher, excerpt, summary, ai_category FROM articles WHERE published_at >= ? ORDER BY published_at DESC').all(since) as any[]) {
    if (!matchesBlock(def, prepare(a))) continue;
    matches++; if (samples.length < 3) samples.push({ title: a.title, publisher: a.publisher });
  }
  return { matches, samples };
}

/** One-time backfill so a deployment that already has articles gets its matches (e.g. the seeded Hockey topic). */
export function ensureBlockIndex(db: DB): boolean {
  if (getSetting(db, 'block_index_v1', false)) return false;
  reindexBlocks(db); setSetting(db, 'block_index_v1', true);
  return true;
}

const SKIP_WORDS = new Set(['how', 'why', 'what', 'when', 'where', 'who', 'the', 'this', 'that', 'these', 'those', 'after', 'before', 'with', 'from', 'over', 'into', 'report', 'reports', 'says', 'latest', 'new', 'news', 'here', 'your', 'our', 'his', 'her', 'its', 'and', 'for']);

/** A starting point for the thumbs-down "Never show this topic" form, from the headline and the article's stored classification. Always editable. */
export function suggestBlock(title: string, category: string | null): { name: string; keywords: string[]; category: string | null } {
  const words: string[] = [];
  for (const m of title.matchAll(/\b[A-Z][A-Za-z'’]{2,}\b/g)) {
    const w = m[0].replace(/['’]s$/i, '');
    if (w.length >= 3 && !SKIP_WORDS.has(w.toLowerCase()) && !words.some((x) => x.toLowerCase() === w.toLowerCase())) words.push(w);
  }
  const picked = words.slice(0, 2); const cat = category && category !== 'Other' ? category : null;
  return { name: picked.length ? picked.join(' / ') : cat ?? 'This topic', keywords: picked.map((w) => w.toLowerCase()), category: cat };
}

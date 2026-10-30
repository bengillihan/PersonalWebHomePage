import type { DB } from '../db.js';
import { BASE_CATEGORIES, type Ai } from '../ai/gemini.js';
import { entities, jaccard, sha256, tokens } from './normalize.js';
import { contradicts } from './contradiction.js';
import { assessNovelty, BASELINE_MAX } from './novelty.js';
import { enqueueCheck, expireChecksFor, runNoveltyChecks, type BaselineItem } from './novelty-checks.js';

export const MERGE_THRESHOLD = 0.55;
export const UNCERTAIN_THRESHOLD = 0.36;
const WINDOW_MS = 48 * 3600_000;

export interface Headline { title: string; publishedAt: number }
export interface ArticleText { title: string; excerpt?: string | null }
/** How many viable candidate stories one incoming article is weighed against (the strongest may be ruled out by a contradiction or a chain). */
export const MAX_CANDIDATES = 3;
const MIN_EXCERPT = 40, EXCERPT_CHARS = 400, EXCERPT_DISAGREE = 0.2;

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

// Aliases and action words are canonicalised for SIMILARITY only (contradicts() still reads the raw headline). Case-sensitive acronyms first.
const ACRONYMS: [RegExp, string][] = [[/\bU\.?S\.?(?=\s|$|[,:;])/g, 'United States'], [/\bUK\b/g, 'United Kingdom'], [/\bEU\b/g, 'European Union'], [/\bGOP\b/g, 'Republican'],
  [/\bDOJ\b/g, 'Justice Department'], [/\bSEC\b/g, 'Securities Exchange Commission'], [/\bFAA\b/g, 'Federal Aviation Administration'], [/\bFed\b/g, 'Federal Reserve'],
  [/\bFOMC\b/g, 'Federal Reserve'], [/\bWash\./g, 'Washington'], [/\bQ([1-4])\b/g, 'quarter$1'], [/\b(first|1st) quarter\b/gi, 'quarter1'], [/\b(second|2nd) quarter\b/gi, 'quarter2'],
  [/\b(third|3rd) quarter\b/gi, 'quarter3'], [/\b(fourth|4th) quarter\b/gi, 'quarter4']];
const ACTION_WORDS: [string, RegExp][] = [
  ['launch', /\b(unveil|debut|launch)(s|ed|ing)?\b/i], ['earnings', /\b(earnings|quarterly results|profit|revenue|eps)\b/i], ['acquire', /\b(acquir(e|es|ed|ing)|acquisition|takeover|buys?|bought|purchase[sd]?)\b/i],
  ['approve', /\bapprov(e|es|ed|al)\b/i], ['layoff', /\b(layoffs?|lays? off|laid off|job cuts)\b/i], ['recall', /\brecall(s|ed)?\b/i], ['lawsuit', /\b(lawsuit|sues|sued|suing)\b/i],
  ['resign', /\b(resign(s|ed|ation)?|steps? down|stepped down)\b/i], ['rates', /\b(interest rates?|rate (cut|hike|decision))\b/i], ['stock', /\b(shares|stocks?)\b/i]];
/** "Snohomish County" vs "King County": the same sentence about different places is a different event. */
const placeNames = (title: string) => new Set([...title.matchAll(/\b([A-Z][a-z]+(?: [A-Z][a-z]+)?) (?:County|City)\b/g)].map((m) => m[1].toLowerCase()));
const ALIAS_ACTION: [RegExp, string][] = [[/\b(unveil|debut|launch)(s|ed|ing)?\b/gi, 'launch'], [/\bapprov(e|es|ed|al)\b/gi, 'approve'], [/\b(acquir(e|es|ed|ing)|acquisition|takeover|purchase[sd]?)\b/gi, 'acquire']];
/** Text a feed appends to every excerpt; shared by unrelated stories, so it must not count as agreement. */
const FEED_BOILERPLATE = /\b(the post .{0,200}? appeared first on .{0,80}|appeared first on .{0,80}|continue reading|read (the )?(full|more)( story| article)?|click here|sign up for .{0,60}newsletter)\b\.?/gi;
/** Words that appear in almost every news story: they say little about WHICH event this is. */
const COMMON = new Set('report reports say state city official officials announce plan plans week year company group people house public court new latest update news today first major big top set time'.split(' '));

/** Rewrites acronyms and aliases to one canonical form ("Fed" and "Federal Reserve" become the same words). */
export function canonicalText(text: string): string {
  let t = text; for (const [re, to] of ACRONYMS) t = t.replace(re, to); for (const [re, to] of ALIAS_ACTION) t = t.replace(re, to); return t;
}
/** The kinds of development a headline describes ('earnings', 'launch', ...). Two headlines naming different ones are different developments. */
export function eventActions(title: string): Set<string> { return new Set(ACTION_WORDS.filter(([, re]) => re.test(title)).map(([k]) => k)); }

/** Distinctive terms count more than common news vocabulary; headline terms count double against excerpt terms. */
function evidence(a: ArticleText): Map<string, number> {
  const out = new Map<string, number>();
  const add = (text: string, factor: number) => {
    const canon = canonicalText(text);
    for (const t of tokens(canon)) out.set(t, Math.max(out.get(t) ?? 0, factor * (COMMON.has(t) ? 0.4 : 1)));
    for (const e of entities(canon)) out.set(e, Math.max(out.get(e) ?? 0, factor * 1.5));
  };
  add(a.title, 2); if (usableExcerpt(a)) add(a.excerpt!.replace(FEED_BOILERPLATE, ' ').slice(0, EXCERPT_CHARS), 1);
  return out;
}
const usableExcerpt = (a: ArticleText) => typeof a.excerpt === 'string' && a.excerpt.trim().length >= MIN_EXCERPT;
/** Dice overlap of weighted terms: unlike Jaccard it is not diluted by the extra sentences one publisher's excerpt happens to carry. */
function weightedOverlap(a: Map<string, number>, b: Map<string, number>): number {
  let inter = 0, total = 0;
  for (const [k, x] of a) { inter += Math.min(x, b.get(k) ?? 0); total += x; }
  for (const x of b.values()) total += x;
  return total ? (2 * inter) / total : 0;
}
const figures = (text: string) => new Set(text.match(/\d[\d,.]*/g)?.map((x) => x.replace(/[,.]+$/, '')) ?? []);

/**
 * Local similarity of two articles' EVENT, in [0,1]: the headline score (with aliases normalised), which a matching excerpt can raise but never lower.
 * An excerpt only helps when the headlines already share something (otherwise two stories on a common theme would join); headlines describing
 * different kinds of development (earnings vs. a product launch) are held below the merge threshold so they are never grouped without a second opinion.
 */
export function articleSimilarity(a: ArticleText, b: ArticleText): number {
  const ca = canonicalText(a.title), cb = canonicalText(b.title);
  const h = headlineSimilarity(ca, cb);
  let score = h;
  if (usableExcerpt(a) && usableExcerpt(b)) {
    const e = weightedOverlap(evidence(a), evidence(b));
    if (h >= 0.12) score = Math.max(h, 0.55 * h + 0.45 * e);
    const fa = figures(`${a.title} ${a.excerpt}`), fb = figures(`${b.title} ${b.excerpt}`);
    const figuresDisagree = fa.size > 0 && fb.size > 0 && ![...fa].some((x) => fb.has(x)); // different vote counts, amounts, dates
    if (e < EXCERPT_DISAGREE || figuresDisagree) score = Math.min(score, MERGE_THRESHOLD - 0.01); // similar headline, different details: a different development
  }
  const pa = placeNames(a.title), pb = placeNames(b.title);
  if (pa.size && pb.size && ![...pa].some((x) => pb.has(x))) score = Math.min(score, MERGE_THRESHOLD - 0.01);
  const xa = eventActions(a.title), xb = eventActions(b.title);
  if (xa.size && xb.size && ![...xa].some((x) => xb.has(x))) score = Math.min(score, MERGE_THRESHOLD - 0.01);
  return score;
}

/**
 * An article joins a story only if it fits the story as a whole, not just one member: a strict majority of members must be similar to it (so A~B and
 * B~C cannot chain A and C together), unless it is a near-duplicate of a member. Single-article stories need no extra check.
 */
export function fitsStory(art: ArticleText, members: ArticleText[], bestScore: number): boolean {
  if (members.length < 2 || bestScore >= 0.8) return true;
  const close = members.filter((m) => articleSimilarity(art, m) >= UNCERTAIN_THRESHOLD).length;
  return close > members.length / 2;
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
  expireChecksFor(db, articleId); // a question about the article in its old story no longer applies
  const from = (db.prepare('SELECT cluster_id FROM articles WHERE id = ?').get(articleId) as any)?.cluster_id as number | null;
  db.prepare('UPDATE articles SET cluster_id = ? WHERE id = ?').run(to, articleId);
  db.prepare('INSERT OR REPLACE INTO cluster_articles (cluster_id, article_id, manual, added_at) VALUES (?,?,?,?)').run(to, articleId, manual, Date.now());
  if (from && from !== to) db.prepare('DELETE FROM cluster_articles WHERE cluster_id = ? AND article_id = ?').run(from, articleId);
  return from;
}

/**
 * A niche (interest-only) source with exactly ONE configured category defaults its articles to it. Broad publishers never do,
 * and multi-category sources are ambiguous, so neither is forced into a narrow category (they remain AI hints only).
 */
export function sourceDefaultCategory(categoriesJson: string | null, coverage: string | null): string | null {
  if (coverage !== 'interest') return null;
  let list: unknown; try { list = JSON.parse(categoriesJson ?? '[]'); } catch { return null; }
  return Array.isArray(list) && list.length === 1 && typeof list[0] === 'string' && list[0].trim() ? list[0].trim() : null;
}

/** Matches a typed category to a known one case-insensitively ('automotive' -> 'Automotive'), else keeps it as typed. */
function canonicalCategory(db: DB, name: string): string {
  const known = [...BASE_CATEGORIES, ...(db.prepare("SELECT name FROM topics WHERE kind = 'category'").all() as { name: string }[]).map((r) => r.name)];
  return known.find((k) => k.toLowerCase() === name.toLowerCase()) ?? name;
}

/** Story category: a specific AI classification always wins; the generic 'Other' or a missing one falls back to a source default. */
function pickCategory(db: DB, ordered: any[]): string | null {
  const cats = ordered.map((m) => {
    const ai = m.ai_category as string | null;
    if (ai && ai !== 'Other') return ai;
    const def = sourceDefaultCategory(m.src_categories, m.src_coverage);
    return def ? canonicalCategory(db, def) : ai;
  }).filter((x): x is string => Boolean(x));
  return cats.find((x) => x !== 'Other') ?? cats[0] ?? null;
}

/** A summary is usable only if it has real text, not merely a row/NULL/blank. */
export const isUsableSummary = (s: string | null | undefined): s is string => typeof s === 'string' && s.trim().length >= 20;

/** Identifies the exact member content a consolidated summary was written from. Order-independent. */
export function clusterContentHash(contentHashes: string[]): string { return sha256([...contentHashes].sort().join(',')); }

/** The story's own ordering of its articles (best first): AI/excerpt text and source priority, then earliest. The stored primary is the first of these. */
export const articleRank = (m: { summary_kind: string | null; priority: number }) => (m.summary_kind === 'ai' ? 2 : m.summary_kind === 'excerpt' ? 1 : 0) * 10 + m.priority * 3;
export const byRank = (a: { summary_kind: string | null; priority: number; published_at: number }, b: { summary_kind: string | null; priority: number; published_at: number }) => articleRank(b) - articleRank(a) || a.published_at - b.published_at;

/** Recomputes derived cluster fields from members. Deletes the cluster if empty. Writes only when something changed. */
export function recomputeCluster(db: DB, clusterId: number, bumpUpdated = false, substantive = false): void {
  const members = db.prepare(`SELECT a.id, a.title, a.publisher, a.published_at, a.importance, a.ai_category, a.summary, a.summary_kind, a.content_hash, s.priority, s.categories AS src_categories, s.coverage AS src_coverage
    FROM articles a JOIN sources s ON s.id = a.source_id WHERE a.cluster_id = ?`).all(clusterId) as any[];
  if (!members.length) { db.prepare('DELETE FROM story_clusters WHERE id = ?').run(clusterId); return; }
  const ordered = [...members].sort(byRank);
  const primary = ordered[0];
  const pubs = new Set(members.map((m) => String(m.publisher).trim().toLowerCase())); // distinct publishers, never feed entries
  const cur = db.prepare('SELECT * FROM story_clusters WHERE id = ?').get(clusterId) as any;
  if (!cur) return;
  const next = {
    primary_article_id: primary.id, title: primary.title, category: pickCategory(db, ordered),
    importance: Math.min(1, Math.max(...members.map((m) => m.importance ?? 0.3)) + 0.04 * (pubs.size - 1)),
    article_count: members.length, source_count: pubs.size,
    first_published_at: Math.min(...members.map((m) => m.published_at)), last_published_at: Math.max(...members.map((m) => m.published_at)),
  };
  if ((Object.keys(next) as (keyof typeof next)[]).some((k) => cur[k] !== next[k])) {
    db.prepare(`UPDATE story_clusters SET primary_article_id=?, title=?, category=?, importance=?, article_count=?, source_count=?,
      first_published_at=?, last_published_at=? WHERE id=?`).run(next.primary_article_id, next.title, next.category, next.importance, next.article_count, next.source_count, next.first_published_at, next.last_published_at, clusterId);
  }
  refreshClusterSummary(db, cur, ordered);
  if (bumpUpdated) db.prepare('UPDATE story_clusters SET updated_at = ? WHERE id = ?').run(Date.now(), clusterId); // new coverage: shown as recently active, never reopens a read story
  if (substantive) db.prepare('UPDATE story_clusters SET substantive_at = ? WHERE id = ?').run(Date.now(), clusterId); // a material development: reopens it (once) for anyone who read it earlier
}

/**
 * Keeps the cluster's displayed summary usable without any AI call.
 *  - Single article: that article's summary.
 *  - Several articles: a current AI consolidated summary is kept; otherwise the best usable publisher-derived summary among
 *    the members (primary first), never text that is not in a source; if none has usable text the cluster is headline-only (NULL).
 * The AI step (summarizeClusters) upgrades this later and is told not to re-ask via summary_hash.
 */
function refreshClusterSummary(db: DB, cur: any, ordered: any[]): void {
  const hash = clusterContentHash(ordered.map((m) => m.content_hash));
  let summary: string | null; let kind: string | null; let marker: string | null = null;
  if (ordered.length === 1) { summary = ordered[0].summary; kind = ordered[0].summary_kind; }
  else {
    if (cur.summary_kind === 'ai' && cur.summary_hash === hash && isUsableSummary(cur.summary)) return; // current consolidated summary
    const src = ordered.find((m) => isUsableSummary(m.summary));
    summary = src ? src.summary : null; kind = src ? src.summary_kind : 'headline';
    if (cur.summary_kind !== 'ai' && cur.summary_hash === hash) marker = hash; // keep "already judged for this content"
  }
  if (cur.summary === summary && cur.summary_kind === kind && cur.differences === null && cur.summary_hash === marker) return;
  db.prepare('UPDATE story_clusters SET summary=?, summary_kind=?, differences=NULL, summary_hash=? WHERE id=?').run(summary, kind, marker, cur.id);
}

/**
 * An article has just joined `clusterId` (or was materially corrected). If the user has already read that story, decide whether it reports a genuinely new
 * development after they read it (novelty.ts). Returns true when it clearly does (the caller records substantive_at). An ambiguous case becomes a durable
 * pending check (novelty-checks.ts) that later refreshes settle with the model; everything else, and every doubt, leaves the story read. Never touches the
 * read timestamp. Unread stories, and stories already reopened since the last read, are not examined at all.
 *  - `eventAt`: when the development happened (the article's publication time for a join; now for a correction).
 *  - `earlier`: older versions of this same article to compare against (a correction compares the article with what it said before).
 */
export function judgeJoin(db: DB, clusterId: number, articleId: number, o: { eventAt?: number; earlier?: BaselineItem[] } = {}): boolean {
  const st = db.prepare('SELECT rs.read_at, c.substantive_at FROM reading_state rs JOIN story_clusters c ON c.id = rs.cluster_id WHERE rs.cluster_id = ?').get(clusterId) as { read_at: number | null; substantive_at: number | null } | undefined;
  if (!st?.read_at || (st.substantive_at ?? 0) > st.read_at) return false;
  const art = db.prepare('SELECT publisher, title, excerpt, content_hash, published_at FROM articles WHERE id = ?').get(articleId) as { publisher: string; title: string; excerpt: string | null; content_hash: string; published_at: number } | undefined;
  const eventAt = o.eventAt ?? art?.published_at ?? 0;
  if (!art || eventAt <= st.read_at) return false; // happened before the user read the story: not news since
  const others = db.prepare(`SELECT id, publisher, title, excerpt, content_hash AS hash FROM articles WHERE cluster_id = ? AND id != ? ORDER BY published_at DESC, id DESC LIMIT ${BASELINE_MAX}`).all(clusterId, articleId) as BaselineItem[];
  const baseline = [...(o.earlier ?? []), ...others].slice(0, BASELINE_MAX);
  const n = assessNovelty(art, baseline);
  if (n.kind === 'substantive') return true;
  if (n.kind === 'ambiguous') enqueueCheck(db, { clusterId, articleId, articleHash: art.content_hash, baseline, eventAt }); // durable; one per article text
  return false;
}

/** True if any article already in the story makes a claim opposite to this headline. */
function storyContradicts(db: DB, clusterId: number, title: string): boolean {
  return (db.prepare('SELECT title FROM articles WHERE cluster_id = ?').all(clusterId) as { title: string }[]).some((m) => contradicts(title, m.title));
}

/**
 * Assigns each new article to an existing cluster, or creates a singleton. Returns touched cluster ids.
 *
 * Two phases, each ONE transaction, because a cluster can disappear between steps (moving an article out of its singleton deletes that
 * singleton) and a later step that remembered the old cluster id would point at a row that no longer exists (FOREIGN KEY constraint failed):
 *  1. (synchronous) assign every article. All-or-nothing: a failure leaves no half-clustered batch, and the articles that are still
 *     unclustered are picked up again by the next refresh (see processNewArticles).
 *  2. (after the model answers) apply the confirmed matches. The target is the cluster the matched ARTICLE lives in NOW, re-read here, never a
 *     cluster id remembered from phase 1. A target that vanished during the await (another refresh, "Check now") is skipped, not followed.
 */
export async function clusterArticles(db: DB, ai: Ai | null, articleIds: number[], maxAiPairs = 20): Promise<Set<number>> {
  const touched = new Set<number>();
  const uncertain: { id: number; articleId: number; otherArticleId: number; hashA: string; hashB: string; a: any; b: any }[] = [];
  const getArt = db.prepare('SELECT id, title, excerpt, publisher, published_at, content_hash FROM articles WHERE id = ?');
  const storyMembers = db.prepare('SELECT title, excerpt FROM articles WHERE cluster_id = ?');
  const cands = db.prepare(`SELECT a.id, a.title, a.excerpt, a.publisher, a.published_at, a.content_hash, a.cluster_id FROM articles a
    WHERE a.cluster_id IS NOT NULL AND a.id != ? AND a.published_at BETWEEN ? AND ?`);
  let pairId = 0;
  db.transaction(() => {
    for (const id of articleIds) {
      const art = getArt.get(id) as any;
      if (!art) continue;
      const existing = (db.prepare('SELECT cluster_id, cluster_locked FROM articles WHERE id = ?').get(id) as any);
      if (existing.cluster_id) { touched.add(existing.cluster_id); continue; }
      // Best member per candidate story, strongest first. Stories ruled out by a contradiction are skipped, so a valid runner-up is still considered.
      const perStory = new Map<number, { score: number; clusterId: number; other: any }>();
      for (const c of cands.all(id, art.published_at - WINDOW_MS, art.published_at + WINDOW_MS) as any[]) {
        const s = articleSimilarity(art, c);
        if (s < UNCERTAIN_THRESHOLD || contradicts(art.title, c.title)) continue; // similar wording, opposite claim: never a candidate, local or AI
        if (s > (perStory.get(c.cluster_id)?.score ?? 0)) perStory.set(c.cluster_id, { score: s, clusterId: c.cluster_id, other: c });
      }
      let target: number | null = null, fallback: { score: number; other: any } | null = null, weighed = 0;
      for (const cand of [...perStory.values()].sort((x, y) => y.score - x.score)) {
        if (weighed >= MAX_CANDIDATES) break;
        if (storyContradicts(db, cand.clusterId, art.title)) continue; // one article of that story may contradict even though the closest one does not
        weighed++;
        const members = storyMembers.all(cand.clusterId) as ArticleText[];
        if (cand.score >= MERGE_THRESHOLD && fitsStory(art, members, cand.score)) { target = cand.clusterId; break; }
        fallback ??= cand; // viable but not clear-cut (borderline, or fits only part of the story): the model may decide
      }
      if (target !== null) {
        moveArticle(db, id, target); touched.add(target);
        recomputeCluster(db, target, true, judgeJoin(db, target, id));
      } else {
        const cid = createSingleton(db, id); touched.add(cid);
        if (fallback && ai?.canCall() && uncertain.length < maxAiPairs) {
          uncertain.push({ id: ++pairId, articleId: id, otherArticleId: fallback.other.id, hashA: art.content_hash, hashB: fallback.other.content_hash, a: art, b: fallback.other });
        }
      }
    }
  })();
  if (uncertain.length && ai) {
    const verdicts = await ai.verifyPairs(uncertain.map((u) => ({ id: u.id, a: { publisher: u.a.publisher, title: u.a.title, publishedAt: u.a.published_at }, b: { publisher: u.b.publisher, title: u.b.title, publishedAt: u.b.published_at } })));
    db.transaction(() => {
      for (const u of uncertain) {
        if (verdicts.get(u.id) !== true) continue; // unknown or false => keep separate
        // The verdict is about the two headlines as they were when asked. If either article was corrected meanwhile, it no longer applies.
        const now = db.prepare('SELECT id, content_hash FROM articles WHERE id IN (?, ?)').all(u.articleId, u.otherArticleId) as { id: number; content_hash: string }[];
        if (now.length !== 2 || now.some((r) => r.content_hash !== (r.id === u.articleId ? u.hashA : u.hashB))) continue;
        const mine = db.prepare('SELECT cluster_id, cluster_locked FROM articles WHERE id = ?').get(u.articleId) as { cluster_id: number | null; cluster_locked: number } | undefined;
        if (!mine || mine.cluster_locked) continue;
        const target = (db.prepare('SELECT cluster_id FROM articles WHERE id = ?').get(u.otherArticleId) as { cluster_id: number | null } | undefined)?.cluster_id;
        if (!target || target === mine.cluster_id) continue; // the matched article is gone, unclustered, or already in the same story
        if (!db.prepare('SELECT 1 FROM story_clusters WHERE id = ?').get(target)) continue;
        // The model only said the two are about the same event; it cannot tell that the target story has since gained an opposing report.
        const myTitle = (db.prepare('SELECT title FROM articles WHERE id = ?').get(u.articleId) as { title: string }).title;
        if (storyContradicts(db, target, myTitle)) continue;
        // Moving the LAST article out of a story deletes that story, and everything the user attached to it (bookmark, rating, rated publishers,
        // read/hidden) would cascade away with it, including anything done while the model was thinking. Carry it to the target first, with the same
        // rules as a manual merge, in this same transaction (state transfer, move and deletion succeed or fail together).
        if (mine.cluster_id && mine.cluster_id !== target && (db.prepare('SELECT COUNT(*) n FROM articles WHERE cluster_id = ?').get(mine.cluster_id) as { n: number }).n === 1) {
          transferUserState(db, target, [mine.cluster_id]);
        }
        const old = moveArticle(db, u.articleId, target);
        touched.add(target);
        if (old) { recomputeCluster(db, old); touched.delete(old); }
        recomputeCluster(db, target, true, judgeJoin(db, target, u.articleId));
      }
    })();
  }
  await runNoveltyChecks(db, ai); // pending questions from this and earlier refreshes (bounded, budget-aware, retried later if unanswered)
  return touched;
}

/** Manual ungroup: article leaves its cluster and is locked out of automatic regrouping. */
export function ungroupArticle(db: DB, articleId: number): number {
  const row = db.prepare('SELECT cluster_id FROM articles WHERE id = ?').get(articleId) as any;
  if (!row) throw new Error('Article not found');
  const old = row.cluster_id as number;
  if ((db.prepare('SELECT COUNT(*) n FROM articles WHERE cluster_id = ?').get(old) as any).n < 2) return old;
  expireChecksFor(db, articleId);
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
 *  - read: the shared event counts as read if ANY copy was read (a duplicate you never opened must not undo your reading); read_at = the latest
 *    read. Nothing is bumped by the merge itself. What can reopen it is a material development already recorded on any copy (substantive_at,
 *    which the merged story keeps as the latest of them) that is newer than that read.
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
  const everyone = (col: 'hidden_at') => (rs.length === all.length && rs.every((r) => r[col] !== null) ? Math.max(...rs.map((r) => r[col]!)) : null);
  const reads = rs.map((r) => r.read_at).filter((x): x is number => x !== null);
  const readAt = reads.length ? Math.max(...reads) : null, hiddenAt = everyone('hidden_at');
  const sub = db.prepare(`SELECT MAX(substantive_at) AS t FROM story_clusters WHERE id IN (${marks})`).get(...all) as { t: number | null };
  if (sub.t !== null) db.prepare('UPDATE story_clusters SET substantive_at = ? WHERE id = ?').run(sub.t, target);
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

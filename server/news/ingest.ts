import type { DB } from '../db.js';
import { getSetting, setSetting } from '../db.js';
import type { Ai, ArticleInput } from '../ai/gemini.js';
import { BASE_CATEGORIES, MIN_CLUSTER_EXCERPT } from '../ai/gemini.js';
import { fetchWithRetry } from '../net/safeFetch.js';
import { getPrefs } from '../settings.js';
import { cleanAggregatorItem, googleNewsFeedUrl, itemOnDomain, parseFeed, type FeedItem } from './feed.js';
import { refreshHealth } from './health.js';
import { canonicalizeUrl, normalizeTitle, sha1, sha256 } from './normalize.js';
import { clusterArticles, clusterContentHash, isUsableSummary, recomputeCluster } from './cluster.js';
import { indexArticleTopics, loadTopics } from './topics.js';
import { sentencesFallback } from './summary.js';

export interface SourceRow {
  id: number; name: string; site_url: string; feed_url: string | null; kind: 'rss' | 'aggregator'; aggregator_query: string | null;
  priority: number; enabled: number; is_local: number; coverage: string; etag: string | null; last_modified: string | null;
}
export interface RefreshStats { sources: number; ok: number; failed: number; newArticles: number; aiSummarized: number; clusters: number; durationMs: number }

export interface IngestDeps { db: DB; ai: Ai | null; log: { info: (o: any, m?: string) => void; warn: (o: any, m?: string) => void; error: (o: any, m?: string) => void }; fetchOpts?: { allowPrivate?: boolean } }

export function feedUrlFor(s: SourceRow): string | null {
  return s.kind === 'aggregator' && s.aggregator_query ? googleNewsFeedUrl(s.aggregator_query) : s.feed_url;
}

async function pool<T>(items: T[], limit: number, fn: (x: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(Array.from({ length: Math.min(limit, queue.length) }, async () => { for (let x = queue.shift(); x; x = queue.shift()) await fn(x); }));
}

function domainOf(q: string | null): string | null { return q?.match(/site:([^\s/]+)/)?.[1]?.replace(/^www\./, '') ?? null; }

interface ExistingArticle { id: number; source_id: number; title: string; excerpt: string | null; content_hash: string; cluster_id: number | null; summary: string | null; summary_kind: string | null; ai_content_hash: string | null }

/** Wording of the story with case, punctuation, whitespace, accents and feed boilerplate removed. Equal keys = cosmetic edit only. */
export function materialKey(title: string, excerpt: string | null): string {
  const body = (excerpt ?? '').replace(/\s*(The post .* appeared first on .*|Read more.*|Continue reading.*)$/i, '');
  return `${normalizeTitle(title)}|${normalizeTitle(body)}`;
}

/**
 * Applies a publisher edit to an already-stored article AND its cluster in one synchronous step (the caller's transaction),
 * entirely locally so it works with Gemini off, failing or out of budget.
 *  - Any text change updates the stored headline/excerpt, so the corrected text is what the dashboard shows.
 *  - Cosmetic-only edits (see materialKey) keep the AI summary and carry the AI marker over, so no Gemini call is made.
 *  - Material edits drop the now-stale AI summary in favour of the publisher excerpt/headline-only fallback and mark the
 *    story Updated; AI is re-run later only if it is available. Bookmarks, feedback, read state and the article's
 *    cluster/source links are untouched (the cluster row is updated in place, never deleted).
 * Returns true when the change is material (caller should queue the article for AI).
 */
function applyCorrection(db: DB, ex: ExistingArticle, item: FeedItem, contentHash: string): boolean {
  const material = materialKey(ex.title, ex.excerpt) !== materialKey(item.title, item.excerpt);
  const keepAi = !material && ex.summary_kind === 'ai';
  const fb = sentencesFallback(item.excerpt, item.title);
  const summary = keepAi ? ex.summary : fb.text;
  const kind = keepAi ? 'ai' : fb.kind;
  const aiHash = !material && ex.ai_content_hash === ex.content_hash ? contentHash : ex.ai_content_hash;
  const hashes = () => (ex.cluster_id ? (db.prepare('SELECT content_hash FROM articles WHERE cluster_id=?').all(ex.cluster_id) as { content_hash: string }[]).map((r) => r.content_hash) : []);
  const clusterHashBefore = clusterContentHash(hashes());
  db.prepare('UPDATE articles SET title=?, title_norm=?, excerpt=?, content_hash=?, availability=?, summary=?, summary_kind=?, ai_content_hash=? WHERE id=?')
    .run(item.title, normalizeTitle(item.title), item.excerpt, contentHash, item.excerpt ? 'excerpt' : 'headline_only', summary, kind, aiHash, ex.id);
  if (ex.cluster_id && !material) { // cosmetic edit: the consolidated summary is still valid, so move its content marker instead of discarding it
    db.prepare('UPDATE story_clusters SET summary_hash=? WHERE id=? AND summary_hash=?').run(clusterContentHash(hashes()), ex.cluster_id, clusterHashBefore);
  }
  if (ex.cluster_id) {
    recomputeCluster(db, ex.cluster_id, material); // refreshes title/primary; single-article clusters also take the new summary
    if (material) { // a consolidated multi-source summary was written from the old text: fall back to the primary's summary until AI regenerates it
      db.prepare(`UPDATE story_clusters SET differences=NULL, summary_hash=NULL,
        summary=(SELECT summary FROM articles WHERE id = story_clusters.primary_article_id),
        summary_kind=(SELECT summary_kind FROM articles WHERE id = story_clusters.primary_article_id)
        WHERE id=? AND article_count > 1`).run(ex.cluster_id);
    }
  }
  return material;
}

/** A source's configured categories, passed to Gemini only as weak hints. */
function sectionHints(json: string | null): string[] {
  try { const l = JSON.parse(json ?? '[]'); return Array.isArray(l) ? l.filter((x): x is string => typeof x === 'string' && x.trim() !== '').slice(0, 5) : []; } catch { return []; }
}

/** Fetches one source, updates its health, inserts new/changed articles. Returns ids of articles needing processing. */
export async function ingestSource(deps: IngestDeps, s: SourceRow, now = Date.now()): Promise<number[]> {
  const { db } = deps;
  const url = feedUrlFor(s);
  // Connectivity and content freshness are tracked separately: last_success_at moves on any successful connection (200 or 304),
  // last_item_at only moves when a newer article publication date is actually seen. Health is then re-evaluated from stored data.
  const record = db.prepare(`UPDATE sources SET last_checked_at=@now, last_success_at=CASE WHEN @ok=1 THEN @now ELSE last_success_at END,
    last_item_at=CASE WHEN @newest IS NOT NULL AND (last_item_at IS NULL OR @newest > last_item_at) THEN @newest ELSE last_item_at END,
    last_error=@error, etag=COALESCE(@etag, etag), last_modified=COALESCE(@lm, last_modified) WHERE id=@id`);
  const finish = (p: { ok: boolean; newest?: number | null; error?: string | null; etag?: string | null; lm?: string | null }) => {
    record.run({ now, ok: p.ok ? 1 : 0, newest: p.newest ?? null, error: p.error ?? null, etag: p.etag ?? null, lm: p.lm ?? null, id: s.id });
    refreshHealth(db, s.id, now);
  };
  if (!url) { finish({ ok: false, error: 'No feed URL configured' }); return []; }
  const retentionCut = now - getPrefs(db).retentionDays * 86_400_000;
  try {
    const headers: Record<string, string> = {};
    if (s.etag) headers['if-none-match'] = s.etag;
    if (s.last_modified) headers['if-modified-since'] = s.last_modified;
    const res = await fetchWithRetry(url, { timeoutMs: 12_000, maxBytes: 3_000_000, headers, retries: 2, ...deps.fetchOpts });
    if (res.status === 304) { finish({ ok: true }); return []; } // connected fine; freshness is judged from the stored newest-article date
    if (res.status >= 400) throw new Error(res.status === 403 ? 'HTTP 403 (the site blocks automated feed readers)' : `HTTP ${res.status}`);
    const feed = parseFeed(res.text(), now);
    const dates = feed.items.map((it) => it.publishedAt).filter((d): d is number => d != null);
    const meta = { etag: String(res.headers.etag ?? '') || null, lm: String(res.headers['last-modified'] ?? '') || null };
    if (!dates.length) { finish({ ok: true, error: 'Feed has no valid dated items', ...meta }); return []; }
    finish({ ok: true, newest: Math.max(...dates), ...meta });
    const domain = s.kind === 'aggregator' ? domainOf(s.aggregator_query) : null;
    const ids: number[] = [];
    const seen = new Set<string>(); // in-batch duplicates (same canonical URL twice in one feed)
    const find = db.prepare('SELECT id, source_id, title, excerpt, content_hash, cluster_id, summary, summary_kind, ai_content_hash FROM articles WHERE canonical_hash = ?');
    const link = db.prepare('INSERT OR IGNORE INTO article_sources (article_id, source_id, first_seen_at) VALUES (?,?,?)'); // every feed that carries an article
    const insert = db.prepare(`INSERT INTO articles (source_id, guid, url, canonical_url, canonical_hash, publisher, title, title_norm, excerpt, image_url, published_at, fetched_at, content_hash, availability, importance)
      VALUES (@source_id,@guid,@url,@canonical_url,@canonical_hash,@publisher,@title,@title_norm,@excerpt,@image_url,@published_at,@fetched_at,@content_hash,@availability,@importance)`);
    db.transaction(() => {
      let position = 0;
      for (const raw of feed.items) {
        let item: FeedItem | null = raw;
        if (s.kind === 'aggregator') {
          if (!domain || !itemOnDomain(raw, domain)) continue; // source-restricted: ignore anything off-domain
          item = cleanAggregatorItem(raw);
        }
        if (!item || item.publishedAt == null || item.publishedAt < retentionCut) continue;
        const canonical = s.kind === 'aggregator' ? item.url : canonicalizeUrl(item.url);
        const hash = sha1(canonical);
        if (seen.has(hash)) continue;
        seen.add(hash);
        const contentHash = sha256(`${item.title}\n${item.excerpt ?? ''}`);
        const existing = find.get(hash) as ExistingArticle | undefined;
        if (existing) {
          // Exact duplicate (same canonical URL): no new article, no AI. Just remember this feed carries it. Only the feed that
          // first discovered the article may correct its text; another feed's differing excerpt must not overwrite it (it would
          // flip-flop on every refresh and re-queue the article for Gemini each time).
          link.run(existing.id, s.id, now);
          if (existing.source_id === s.id && existing.content_hash !== contentHash && applyCorrection(db, existing, item, contentHash)) ids.push(existing.id); // only material changes need AI
          continue;
        }
        // Heuristic until Gemini scores it: feeds list top stories first, so early items from non-local sources count as major.
        // A feed's coverage setting is deliberately NOT part of this: interest-only is an eligibility filter (see query.ts), not a score.
        const importance = !s.is_local ? (position < 8 ? 0.62 : position < 20 ? 0.45 : 0.3) : 0.3;
        position++;
        const r = insert.run({
          source_id: s.id, guid: item.guid, url: item.url, canonical_url: canonical, canonical_hash: hash, publisher: item.publisher ?? s.name,
          title: item.title, title_norm: normalizeTitle(item.title), excerpt: item.excerpt, image_url: item.imageUrl,
          published_at: item.publishedAt, fetched_at: now, content_hash: contentHash, availability: item.excerpt ? 'excerpt' : 'headline_only', importance,
        });
        link.run(Number(r.lastInsertRowid), s.id, now);
        ids.push(Number(r.lastInsertRowid));
      }
    })();
    return ids;
  } catch (e) {
    finish({ ok: false, error: String((e as Error).message).slice(0, 300) });
    deps.log.warn({ source: s.name, err: (e as Error).message }, 'source fetch failed');
    return [];
  }
}

export async function processNewArticles(deps: IngestDeps, ids: number[]): Promise<{ ai: number; clusters: number }> {
  const { db, ai } = deps;
  if (ids.length) {
    // 1. Local fallback summaries immediately so the reader never waits on AI.
    const upd = db.prepare(`UPDATE articles SET summary=@s, summary_kind=@k WHERE id=@id AND (summary_kind IS NULL OR summary_kind != 'ai' OR ai_content_hash != content_hash) AND (summary IS NOT @s OR summary_kind IS NOT @k)`);
    for (const id of ids) {
      const a = db.prepare('SELECT excerpt, title FROM articles WHERE id=?').get(id) as any;
      const fb = sentencesFallback(a.excerpt, a.title);
      upd.run({ s: fb.text, k: fb.kind, id });
    }
  }
  const clustered = (id: number) => (db.prepare('SELECT cluster_id FROM articles WHERE id=?').get(id) as any)?.cluster_id as number | null;
  const clusters = await clusterArticles(db, ai, ids.filter((id) => !clustered(id)));
  for (const id of ids) { const cid = clustered(id); if (cid) clusters.add(cid); } // corrected articles: let AI summaries regenerate when available
  // 2. AI classification/summaries for anything not yet analysed at its current content hash.
  let aiCount = 0;
  if (ai?.canCall()) {
    const pending = db.prepare(`SELECT a.id, a.publisher, a.title, a.excerpt, a.published_at, a.content_hash, s.categories AS src_categories FROM articles a JOIN sources s ON s.id = a.source_id
      WHERE (a.ai_content_hash IS NULL OR a.ai_content_hash != a.content_hash) AND a.published_at >= ? ORDER BY a.published_at DESC LIMIT 60`).all(Date.now() - 14 * 86_400_000) as any[];
    const inputs: ArticleInput[] = pending.map((p) => ({ id: p.id, publisher: p.publisher, title: p.title, excerpt: p.excerpt, publishedAt: p.published_at, contentHash: p.content_hash, sourceHints: sectionHints(p.src_categories) }));
    const cats = [...new Set([...BASE_CATEGORIES, ...loadTopics(db).filter((t) => t.kind === 'category').map((t) => t.name)])];
    const result = await ai.analyzeArticles(inputs, cats);
    const setAi = db.prepare(`UPDATE articles SET ai_category=?, importance=?, ai_content_hash=content_hash, summary=COALESCE(?, summary), summary_kind=CASE WHEN ? IS NOT NULL THEN 'ai' ELSE summary_kind END WHERE id=?`);
    db.transaction(() => {
      for (const [id, a] of result) { setAi.run(a.category, a.importance, a.summary, a.summary, id); aiCount++; const cid = (db.prepare('SELECT cluster_id FROM articles WHERE id=?').get(id) as any)?.cluster_id; if (cid) clusters.add(cid); }
    })();
  }
  // Repair/upgrade recent grouped stories that still lack a usable summary or were never judged for an AI summary (bounded per refresh).
  const needSummary = db.prepare(`SELECT id FROM story_clusters WHERE article_count > 1 AND last_published_at >= ?
    AND (summary IS NULL OR TRIM(summary) = '' OR summary_hash IS NULL) ORDER BY last_published_at DESC LIMIT 10`).all(Date.now() - 7 * 86_400_000) as { id: number }[];
  for (const r of needSummary) clusters.add(r.id);
  for (const cid of clusters) recomputeCluster(db, cid);
  await summarizeClusters(deps, clusters);
  indexArticleTopics(db, ids);
  return { ai: aiCount, clusters: clusters.size };
}

/**
 * Consolidated multi-source summaries from Gemini. Skips a cluster whose summary is already current for its content
 * (summary_hash), asks at most once per distinct content, and never asks without >=2 usable excerpts. On any Gemini failure
 * the local publisher-excerpt summary stays and we stop for this run (no hammering); a later refresh retries.
 */
export async function summarizeClusters(deps: IngestDeps, clusterIds: Iterable<number>): Promise<void> {
  const { db, ai } = deps;
  for (const cid of clusterIds) {
    const members = db.prepare('SELECT id, publisher, title, excerpt, published_at, content_hash FROM articles WHERE cluster_id=?').all(cid) as any[];
    if (members.length < 2) continue;
    const hash = clusterContentHash(members.map((m) => m.content_hash));
    const cur = db.prepare('SELECT summary, summary_hash, summary_kind FROM story_clusters WHERE id=?').get(cid) as any;
    if (!cur) continue;
    if (cur.summary_hash === hash && (cur.summary_kind !== 'ai' || isUsableSummary(cur.summary))) continue; // current, or already judged
    if (members.filter((m) => (m.excerpt?.length ?? 0) >= MIN_CLUSTER_EXCERPT).length < 2) { // not enough source text to consolidate
      db.prepare('UPDATE story_clusters SET summary_hash=? WHERE id=?').run(hash, cid);
      continue;
    }
    if (!ai?.enabled) continue;
    const res = await ai.summarizeCluster(members.map((m) => ({ id: m.id, publisher: m.publisher, title: m.title, excerpt: m.excerpt, publishedAt: m.published_at, contentHash: m.content_hash })));
    if (!res) break;
    db.prepare("UPDATE story_clusters SET summary=?, differences=?, summary_kind='ai', summary_hash=? WHERE id=?").run(res.summary, res.differences, hash, cid);
  }
}

export function pruneOldData(db: DB, now = Date.now()): { articles: number } {
  const cut = now - getPrefs(db).retentionDays * 86_400_000;
  // Keep any story that is bookmarked or carries feedback; everything else ages out.
  const keep = `(SELECT cluster_id FROM bookmarks UNION SELECT cluster_id FROM feedback)`;
  const r = db.prepare(`DELETE FROM articles WHERE published_at < ? AND (cluster_id IS NULL OR cluster_id NOT IN ${keep})`).run(cut);
  db.prepare('DELETE FROM story_clusters WHERE id NOT IN (SELECT DISTINCT cluster_id FROM articles WHERE cluster_id IS NOT NULL)').run();
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
  db.prepare('DELETE FROM processing_jobs WHERE started_at < ?').run(now - 30 * 86_400_000);
  db.prepare('DELETE FROM ai_cache WHERE created_at < ?').run(now - 45 * 86_400_000);
  db.pragma('wal_checkpoint(PASSIVE)');
  return { articles: r.changes };
}

export type RefreshTrigger = 'stale' | 'manual' | 'cron';

/**
 * Stale-while-revalidate coordinator. Nothing here runs on a timer: refreshes start only from an
 * authenticated request (or an external cron calling `trigger('cron')`), so the instance can sleep.
 * Concurrent triggers share one in-flight promise.
 */
export class Refresher {
  private inflight: Promise<RefreshStats> | null = null;
  constructor(private deps: IngestDeps) {}

  get running(): boolean { return this.inflight !== null; }
  lastRefreshAt(): number { return getSetting<number>(this.deps.db, 'last_news_refresh_at', 0); }
  isStale(now = Date.now()): boolean { return now - this.lastRefreshAt() > getPrefs(this.deps.db).staleMinutes * 60_000; }

  /** Fire-and-forget when stale. Returns true if a refresh is (now) running. */
  maybeRefresh(): boolean { if (this.inflight) return true; if (this.isStale()) { void this.trigger('stale').catch(() => {}); return true; } return false; }

  trigger(reason: RefreshTrigger): Promise<RefreshStats> {
    if (this.inflight) return this.inflight;
    this.inflight = this.run(reason).finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private async run(reason: RefreshTrigger): Promise<RefreshStats> {
    const { db, log } = this.deps;
    const started = Date.now();
    const job = Number(db.prepare("INSERT INTO processing_jobs (kind, status, trigger, started_at) VALUES ('news_refresh','running',?,?)").run(reason, started).lastInsertRowid);
    try {
      const sources = db.prepare('SELECT * FROM sources WHERE enabled = 1').all() as SourceRow[];
      const ids: number[] = [];
      let ok = 0, failed = 0;
      await pool(sources, 3, async (s) => {
        const got = await ingestSource(this.deps, s);
        const h = (db.prepare('SELECT health FROM sources WHERE id=?').get(s.id) as any).health;
        if (h === 'ok') ok++; else failed++;
        ids.push(...got);
      });
      const { ai, clusters } = await processNewArticles(this.deps, [...new Set(ids)]);
      const lastPrune = getSetting<number>(db, 'last_prune_at', 0);
      if (Date.now() - lastPrune > 86_400_000) { pruneOldData(db); setSetting(db, 'last_prune_at', Date.now()); }
      setSetting(db, 'last_news_refresh_at', Date.now());
      const stats: RefreshStats = { sources: sources.length, ok, failed, newArticles: ids.length, aiSummarized: ai, clusters, durationMs: Date.now() - started };
      db.prepare("UPDATE processing_jobs SET status='ok', finished_at=?, stats=? WHERE id=?").run(Date.now(), JSON.stringify(stats), job);
      log.info(stats, 'news refresh complete');
      return stats;
    } catch (e) {
      db.prepare("UPDATE processing_jobs SET status='error', finished_at=?, error=? WHERE id=?").run(Date.now(), String((e as Error).message).slice(0, 500), job);
      log.error({ err: (e as Error).message }, 'news refresh failed');
      throw e;
    }
  }
}

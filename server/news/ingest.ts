import type { DB } from '../db.js';
import { getSetting, setSetting } from '../db.js';
import type { Ai, ArticleInput } from '../ai/gemini.js';
import { BASE_CATEGORIES } from '../ai/gemini.js';
import { fetchWithRetry } from '../net/safeFetch.js';
import { getPrefs } from '../settings.js';
import { assessFreshness, cleanAggregatorItem, googleNewsFeedUrl, itemOnDomain, parseFeed, type FeedItem } from './feed.js';
import { canonicalizeUrl, normalizeTitle, sha1, sha256 } from './normalize.js';
import { clusterArticles, recomputeCluster } from './cluster.js';
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

interface ExistingArticle { id: number; title: string; excerpt: string | null; content_hash: string; cluster_id: number | null; summary: string | null; summary_kind: string | null; ai_content_hash: string | null }

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
  db.prepare('UPDATE articles SET title=?, title_norm=?, excerpt=?, content_hash=?, availability=?, summary=?, summary_kind=?, ai_content_hash=? WHERE id=?')
    .run(item.title, normalizeTitle(item.title), item.excerpt, contentHash, item.excerpt ? 'excerpt' : 'headline_only', summary, kind, aiHash, ex.id);
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

/** Fetches one source, updates its health, inserts new/changed articles. Returns ids of articles needing processing. */
export async function ingestSource(deps: IngestDeps, s: SourceRow, now = Date.now()): Promise<number[]> {
  const { db } = deps;
  const url = feedUrlFor(s);
  const touch = db.prepare('UPDATE sources SET health=?, last_checked_at=?, last_success_at=COALESCE(?, last_success_at), last_item_at=COALESCE(?, last_item_at), last_error=?, etag=COALESCE(?, etag), last_modified=COALESCE(?, last_modified) WHERE id=?');
  if (!url) { touch.run('error', now, null, null, 'No feed URL configured', null, null, s.id); return []; }
  const retentionCut = now - getPrefs(db).retentionDays * 86_400_000;
  try {
    const headers: Record<string, string> = {};
    if (s.etag) headers['if-none-match'] = s.etag;
    if (s.last_modified) headers['if-modified-since'] = s.last_modified;
    const res = await fetchWithRetry(url, { timeoutMs: 12_000, maxBytes: 3_000_000, headers, retries: 2, ...deps.fetchOpts });
    if (res.status === 304) { db.prepare("UPDATE sources SET last_checked_at=?, last_error=NULL, health=CASE WHEN health='unknown' THEN 'ok' ELSE health END WHERE id=?").run(now, s.id); return []; }
    if (res.status >= 400) throw new Error(res.status === 403 ? 'HTTP 403 (the site blocks automated feed readers)' : `HTTP ${res.status}`);
    const feed = parseFeed(res.text(), now);
    const fresh = assessFreshness(feed, now);
    touch.run(fresh.status, now, fresh.status === 'error' ? null : now, fresh.newest, fresh.status === 'ok' ? null : fresh.reason ?? null,
      String(res.headers.etag ?? '') || null, String(res.headers['last-modified'] ?? '') || null, s.id);
    const domain = s.kind === 'aggregator' ? domainOf(s.aggregator_query) : null;
    const ids: number[] = [];
    const seen = new Set<string>(); // in-batch duplicates (same canonical URL twice in one feed)
    const find = db.prepare('SELECT id, title, excerpt, content_hash, cluster_id, summary, summary_kind, ai_content_hash FROM articles WHERE canonical_hash = ?');
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
          if (existing.content_hash !== contentHash && applyCorrection(db, existing, item, contentHash)) ids.push(existing.id); // only material changes need AI
          continue;
        }
        // Heuristic until Gemini scores it: feeds list top stories first, so early items from general (non-local) sources count as major.
        const importance = !s.is_local && s.coverage === 'comprehensive' ? (position < 8 ? 0.62 : position < 20 ? 0.45 : 0.3) : 0.3;
        position++;
        const r = insert.run({
          source_id: s.id, guid: item.guid, url: item.url, canonical_url: canonical, canonical_hash: hash, publisher: item.publisher ?? s.name,
          title: item.title, title_norm: normalizeTitle(item.title), excerpt: item.excerpt, image_url: item.imageUrl,
          published_at: item.publishedAt, fetched_at: now, content_hash: contentHash, availability: item.excerpt ? 'excerpt' : 'headline_only', importance,
        });
        ids.push(Number(r.lastInsertRowid));
      }
    })();
    return ids;
  } catch (e) {
    touch.run('error', now, null, null, String((e as Error).message).slice(0, 300), null, null, s.id);
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
    const pending = db.prepare(`SELECT id, publisher, title, excerpt, published_at, content_hash FROM articles
      WHERE (ai_content_hash IS NULL OR ai_content_hash != content_hash) AND published_at >= ? ORDER BY published_at DESC LIMIT 60`).all(Date.now() - 14 * 86_400_000) as any[];
    const inputs: ArticleInput[] = pending.map((p) => ({ id: p.id, publisher: p.publisher, title: p.title, excerpt: p.excerpt, publishedAt: p.published_at, contentHash: p.content_hash }));
    const cats = [...new Set([...BASE_CATEGORIES, ...loadTopics(db).filter((t) => t.kind === 'category').map((t) => t.name)])];
    const result = await ai.analyzeArticles(inputs, cats);
    const setAi = db.prepare(`UPDATE articles SET ai_category=?, importance=?, ai_content_hash=content_hash, summary=COALESCE(?, summary), summary_kind=CASE WHEN ? IS NOT NULL THEN 'ai' ELSE summary_kind END WHERE id=?`);
    db.transaction(() => {
      for (const [id, a] of result) { setAi.run(a.category, a.importance, a.summary, a.summary, id); aiCount++; const cid = (db.prepare('SELECT cluster_id FROM articles WHERE id=?').get(id) as any)?.cluster_id; if (cid) clusters.add(cid); }
    })();
  }
  for (const cid of clusters) recomputeCluster(db, cid);
  await summarizeClusters(deps, clusters);
  indexArticleTopics(db, ids);
  return { ai: aiCount, clusters: clusters.size };
}

/** Consolidated multi-source summaries; regenerated only when the member content hashes change. */
export async function summarizeClusters(deps: IngestDeps, clusterIds: Iterable<number>): Promise<void> {
  const { db, ai } = deps;
  for (const cid of clusterIds) {
    const members = db.prepare('SELECT id, publisher, title, excerpt, published_at, content_hash FROM articles WHERE cluster_id=?').all(cid) as any[];
    if (members.length < 2) continue;
    const hash = sha256(members.map((m) => m.content_hash).sort().join(','));
    const cur = db.prepare('SELECT summary_hash, summary_kind FROM story_clusters WHERE id=?').get(cid) as any;
    if (!cur || cur.summary_hash === hash) continue;
    if (!ai?.canCall()) continue;
    const res = await ai.summarizeCluster(members.map((m) => ({ id: m.id, publisher: m.publisher, title: m.title, excerpt: m.excerpt, publishedAt: m.published_at, contentHash: m.content_hash })));
    if (res) db.prepare("UPDATE story_clusters SET summary=?, differences=?, summary_kind='ai', summary_hash=? WHERE id=?").run(res.summary, res.differences, hash, cid);
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

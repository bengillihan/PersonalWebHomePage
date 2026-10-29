import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { DB } from '../db.js';
import { getSetting, setSetting } from '../db.js';
import type { Ai } from '../ai/gemini.js';
import type { Refresher } from '../news/ingest.js';
import { feedUrlFor, ingestSource, processNewArticles, type SourceRow } from '../news/ingest.js';
import { discoverFeeds, probeFeed } from '../news/discover.js';
import { FetchError, validateUrl } from '../net/safeFetch.js';
import { explainStory, queryFeed } from '../news/query.js';
import { mergeClusters, recomputeCluster, ungroupArticle } from '../news/cluster.js';
import { reindexTopics, loadTopics } from '../news/topics.js';
import { getPrefs, savePrefs } from '../settings.js';
import { evaluateSource, MAX_FRESHNESS_HOURS, refreshHealth } from '../news/health.js';
import { RANGES, type MarketService, type Range } from '../market/service.js';
import { ProviderError, type MarketProvider } from '../market/provider.js';

export interface ApiDeps { cfg: Config; db: DB; ai: Ai; refresher: Refresher; market: MarketService; provider: MarketProvider; fetchOpts?: { allowPrivate?: boolean } }

const idParam = z.object({ id: z.coerce.number().int().positive() });
const prio = z.enum(['high', 'normal', 'low']).transform((p) => ({ high: 2, normal: 1, low: 0 })[p]);
const prioOut = (n: number) => (['low', 'normal', 'high'] as const)[n];
const kw = z.array(z.string().trim().min(1).max(60)).max(30);

function sourceDto(s: any) {
  const feed = feedUrlFor(s);
  const ev = evaluateSource(s); // evaluated now from stored columns: no network, and correct even if no check ran recently
  return {
    id: s.id, name: s.name, siteUrl: s.site_url, feedUrl: feed && s.kind === 'rss' ? feed : null, kind: s.kind,
    aggregatorLabel: s.kind === 'aggregator' ? `Aggregated via Google News: domain-restricted search "${s.aggregator_query}" (keyword-based, not the publisher's own section feed); links open through Google News` : null,
    priority: prioOut(s.priority), enabled: !!s.enabled, coverage: s.coverage, categories: JSON.parse(s.categories), isLocal: !!s.is_local,
    health: ev.status, statusReason: ev.status === 'stale' ? ev.reason : null, freshnessHours: s.freshness_hours ?? null, freshnessDefaultHours: ev.defaultHours, lastCheckedAt: s.last_checked_at, lastSuccessAt: s.last_success_at, lastItemAt: s.last_item_at, lastError: s.last_error,
    articleCount: s.article_count ?? 0,
  };
}

export function registerApi(app: FastifyInstance, d: ApiDeps) {
  const { db, ai, refresher, market } = d;
  const heavy = { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } };
  const medium = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };
  const status = () => ({
    newsRefreshing: refresher.running, marketRefreshing: market.running, lastNewsRefreshAt: refresher.lastRefreshAt() || null,
    lastMarketFetchAt: market.lastFetch(), stale: refresher.isStale(), aiEnabled: ai.enabled,
  });

  app.addHook('onSend', async (req, reply) => { if (req.url.startsWith('/api/')) reply.header('cache-control', 'private, no-store'); });

  app.get('/api/me', async (req) => ({ email: req.session!.email, name: req.session!.name, csrfToken: req.session!.csrf, theme: getPrefs(db).theme }));
  app.get('/api/status', async () => status());

  // ---- feed (stale-while-revalidate: serve cached rows now, refresh in the background) ----
  app.get('/api/feed', async (req) => {
    const q = z.object({ tab: z.string().max(30).default('foryou'), q: z.string().max(100).optional(), topic: z.string().max(80).optional(), cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(50).optional() }).parse(req.query);
    if (!q.cursor) { refresher.maybeRefresh(); void market.refreshIfNeeded().catch(() => {}); }
    const page = queryFeed(db, q);
    const total = (db.prepare('SELECT COUNT(*) n FROM story_clusters').get() as any).n;
    return { ...page, status: status(), hasAnyStories: total > 0, showImages: getPrefs(db).showImages, showRead: getPrefs(db).showRead };
  });
  app.post('/api/refresh', heavy, async (_req, reply) => { void refresher.trigger('manual').catch(() => {}); void market.refreshIfNeeded(true).catch(() => {}); return reply.code(202).send(status()); });

  app.get('/api/stories/:id/why', async (req, reply) => { const { id } = idParam.parse(req.params); const w = explainStory(db, id); return w ?? reply.code(404).send({ error: 'not_found' }); });
  const exists = (id: number) => db.prepare('SELECT 1 FROM story_clusters WHERE id = ?').get(id);

  app.post('/api/stories/:id/read', async (req, reply) => {
    const { id } = idParam.parse(req.params); const { read } = z.object({ read: z.boolean() }).parse(req.body);
    if (!exists(id)) return reply.code(404).send({ error: 'not_found' });
    db.prepare(`INSERT INTO reading_state (cluster_id, read_at) VALUES (?,?) ON CONFLICT(cluster_id) DO UPDATE SET read_at = excluded.read_at`).run(id, read ? Date.now() : null);
    return { ok: true };
  });
  app.post('/api/stories/:id/hide', async (req, reply) => {
    const { id } = idParam.parse(req.params); const { hidden } = z.object({ hidden: z.boolean() }).parse(req.body);
    if (!exists(id)) return reply.code(404).send({ error: 'not_found' });
    db.prepare(`INSERT INTO reading_state (cluster_id, hidden_at) VALUES (?,?) ON CONFLICT(cluster_id) DO UPDATE SET hidden_at = excluded.hidden_at`).run(id, hidden ? Date.now() : null);
    return { ok: true };
  });
  app.post('/api/stories/:id/bookmark', async (req, reply) => {
    const { id } = idParam.parse(req.params); const { on } = z.object({ on: z.boolean() }).parse(req.body);
    if (!exists(id)) return reply.code(404).send({ error: 'not_found' });
    if (on) db.prepare('INSERT OR IGNORE INTO bookmarks (cluster_id, created_at) VALUES (?,?)').run(id, Date.now()); else db.prepare('DELETE FROM bookmarks WHERE cluster_id = ?').run(id);
    return { ok: true };
  });
  app.post('/api/stories/:id/feedback', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = z.object({ rating: z.union([z.literal(1), z.literal(-1), z.literal(0)]), reason: z.enum(['topic', 'already_knew', 'low_importance', 'source', 'duplicate']).nullable().optional() }).parse(req.body);
    const c = db.prepare('SELECT category FROM story_clusters WHERE id = ?').get(id) as any;
    if (!c) return reply.code(404).send({ error: 'not_found' });
    db.transaction(() => {
      db.prepare('DELETE FROM feedback_sources WHERE cluster_id = ?').run(id);
      if (body.rating === 0) { db.prepare('DELETE FROM feedback WHERE cluster_id = ?').run(id); return; } // reversible
      const now = Date.now();
      db.prepare(`INSERT INTO feedback (cluster_id, rating, reason, category, created_at, updated_at) VALUES (?,?,?,?,?,?)
        ON CONFLICT(cluster_id) DO UPDATE SET rating=excluded.rating, reason=excluded.reason, category=excluded.category, updated_at=excluded.updated_at`).run(id, body.rating, body.rating === -1 ? body.reason ?? null : null, c.category, now, now);
      for (const r of db.prepare('SELECT DISTINCT source_id FROM articles WHERE cluster_id = ?').all(id) as any[]) db.prepare('INSERT OR IGNORE INTO feedback_sources (cluster_id, source_id) VALUES (?,?)').run(id, r.source_id);
    })();
    return { ok: true };
  });
  app.post('/api/stories/:id/ungroup', async (req) => {
    const { id } = idParam.parse(req.params); const { articleId } = z.object({ articleId: z.number().int() }).parse(req.body);
    const a = db.prepare('SELECT cluster_id FROM articles WHERE id = ?').get(articleId) as any;
    if (!a || a.cluster_id !== id) throw new FetchError('Article is not in this story', 'bad_request');
    return { clusterId: ungroupArticle(db, articleId) };
  });
  app.post('/api/clusters/merge', async (req) => ({ clusterId: mergeClusters(db, z.object({ ids: z.array(z.number().int()).min(2).max(10) }).parse(req.body).ids) }));

  // ---- sources ----
  const listSources = () => (db.prepare(`SELECT s.*, (SELECT COUNT(*) FROM articles a WHERE a.source_id = s.id) AS article_count FROM sources s ORDER BY s.priority DESC, s.name`).all() as any[]).map(sourceDto);
  app.get('/api/sources', async () => listSources());
  app.post('/api/sources/discover', medium, async (req) => discoverFeeds(z.object({ url: z.string().max(500) }).parse(req.body).url, d.fetchOpts));
  app.post('/api/sources', medium, async (req, reply) => {
    const b = z.object({
      url: z.string().max(500), feedUrl: z.string().max(600).optional(), aggregator: z.boolean().optional(), name: z.string().trim().min(1).max(80).optional(),
      priority: prio.optional(), coverage: z.enum(['comprehensive', 'interest']).optional(), categories: kw.optional(), isLocal: z.boolean().optional(),
    }).parse(req.body);
    const site = validateUrl(b.url, d.fetchOpts);
    let feedUrl: string | null = null; let kind: 'rss' | 'aggregator' = 'rss'; let query: string | null = null; let name = b.name ?? site.hostname.replace(/^www\./, '');
    if (b.aggregator) {
      kind = 'aggregator'; const seg = site.pathname.split('/').filter(Boolean)[0]; // Google News ignores path restrictions, so a first path segment becomes a keyword
      query = `site:${site.hostname.replace(/^www\./, '')}${seg ? ' ' + seg : ''}`;
    } else {
      let cand;
      if (b.feedUrl) { cand = await probeFeed(validateUrl(b.feedUrl, d.fetchOpts).toString(), d.fetchOpts).catch((e) => { throw new FetchError(`Feed check failed: ${e.message}`, 'bad_feed'); }); }
      else { const disc = await discoverFeeds(b.url, d.fetchOpts); cand = disc.candidates.find((c) => c.freshness.status === 'ok');
        if (!cand) return reply.code(422).send({ error: 'no_working_feed', message: 'No fresh publisher RSS/Atom feed was found. You can add this site through the labeled Google News aggregator instead.', discovery: disc, aggregatorAvailable: true }); }
      if (cand.freshness.status !== 'ok') return reply.code(422).send({ error: 'stale_feed', message: `Feed is not fresh: ${cand.freshness.reason}`, aggregatorAvailable: true });
      feedUrl = cand.feedUrl; if (!b.name && cand.title) name = cand.title.slice(0, 80);
    }
    try {
      const r = db.prepare(`INSERT INTO sources (name, site_url, feed_url, kind, aggregator_query, priority, coverage, categories, is_local, created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(name, site.toString(), feedUrl, kind, query, b.priority ?? 1, b.coverage ?? 'comprehensive', JSON.stringify(b.categories ?? []), b.isLocal ? 1 : 0, Date.now());
      void refresher.trigger('manual').catch(() => {});
      return reply.code(201).send({ id: Number(r.lastInsertRowid) });
    } catch (e) { if (String(e).includes('UNIQUE')) return reply.code(409).send({ error: 'duplicate', message: 'This source already exists' }); throw e; }
  });
  app.patch('/api/sources/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const b = z.object({ name: z.string().trim().min(1).max(80).optional(), enabled: z.boolean().optional(), priority: prio.optional(), coverage: z.enum(['comprehensive', 'interest']).optional(), categories: kw.optional(), isLocal: z.boolean().optional(), freshnessHours: z.number().int().min(1).max(MAX_FRESHNESS_HOURS).nullable().optional() }).parse(req.body);
    if (!db.prepare('SELECT 1 FROM sources WHERE id = ?').get(id)) return reply.code(404).send({ error: 'not_found' });
    const sets: string[] = []; const vals: any[] = [];
    const add = (c: string, v: unknown) => { sets.push(`${c} = ?`); vals.push(v); };
    if (b.name !== undefined) add('name', b.name); if (b.enabled !== undefined) add('enabled', b.enabled ? 1 : 0);
    if (b.priority !== undefined) add('priority', b.priority); if (b.coverage !== undefined) add('coverage', b.coverage);
    if (b.categories !== undefined) add('categories', JSON.stringify(b.categories)); if (b.isLocal !== undefined) add('is_local', b.isLocal ? 1 : 0);
    if (b.freshnessHours !== undefined) add('freshness_hours', b.freshnessHours);
    if (sets.length) db.prepare(`UPDATE sources SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
    refreshHealth(db, id); // thresholds / locality / enabled changed: re-evaluate from stored data (local, no network)
    // Coverage is evaluated at query time, so it takes effect immediately. Categories feed story categories: refresh the affected stories (local, no AI).
    if (b.categories !== undefined) {
      const clusters = db.prepare(`SELECT cluster_id FROM articles WHERE source_id = @id AND cluster_id IS NOT NULL
        UNION SELECT a.cluster_id FROM article_sources x JOIN articles a ON a.id = x.article_id WHERE x.source_id = @id AND a.cluster_id IS NOT NULL`).all({ id }) as { cluster_id: number }[];
      db.transaction(() => { for (const r of clusters) recomputeCluster(db, r.cluster_id); })();
    }
    return { ok: true };
  });
  app.delete('/api/sources/:id', async (req) => {
    const { id } = idParam.parse(req.params);
    db.transaction(() => {
      // Articles that another feed also carries survive: hand them to a remaining feed before the cascade removes this feed's own articles.
      db.prepare(`UPDATE articles SET source_id = (SELECT MIN(x.source_id) FROM article_sources x WHERE x.article_id = articles.id AND x.source_id != @id)
        WHERE source_id = @id AND EXISTS (SELECT 1 FROM article_sources x WHERE x.article_id = articles.id AND x.source_id != @id)`).run({ id });
      db.prepare('DELETE FROM sources WHERE id = ?').run(id);
      db.prepare('DELETE FROM story_clusters WHERE id NOT IN (SELECT DISTINCT cluster_id FROM articles WHERE cluster_id IS NOT NULL)').run();
    })();
    return { ok: true };
  });
  app.post('/api/sources/:id/check', medium, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const s = db.prepare('SELECT * FROM sources WHERE id = ?').get(id) as SourceRow | undefined;
    if (!s) return reply.code(404).send({ error: 'not_found' });
    const ids = await ingestSource({ db, ai, log: req.log, fetchOpts: d.fetchOpts }, s);
    await processNewArticles({ db, ai, log: req.log, fetchOpts: d.fetchOpts }, ids);
    return { imported: ids.length, source: listSources().find((x) => x.id === id) };
  });

  // ---- interests / topics ----
  const topicBody = z.object({ name: z.string().trim().min(1).max(80), kind: z.enum(['category', 'interest']).default('interest'), description: z.string().trim().max(400).default(''), priority: prio.default(1), include: kw.default([]), exclude: kw.default([]) });
  const topicDto = (t: any) => ({ id: t.id, name: t.name, kind: t.kind, description: t.description, priority: prioOut(t.priority), include: t.include, exclude: t.exclude });
  app.get('/api/topics', async () => loadTopics(db).map(topicDto));
  app.post('/api/topics', async (req, reply) => {
    const b = topicBody.parse(req.body);
    try { const r = db.prepare('INSERT INTO topics (name, kind, description, priority, include_keywords, exclude_keywords, created_at) VALUES (?,?,?,?,?,?,?)').run(b.name, b.kind, b.description, b.priority, JSON.stringify(b.include), JSON.stringify(b.exclude), Date.now()); reindexTopics(db); return reply.code(201).send({ id: Number(r.lastInsertRowid) }); }
    catch (e) { if (String(e).includes('UNIQUE')) return reply.code(409).send({ error: 'duplicate' }); throw e; }
  });
  app.put('/api/topics/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params); const b = topicBody.parse(req.body);
    const r = db.prepare('UPDATE topics SET name=?, kind=?, description=?, priority=?, include_keywords=?, exclude_keywords=? WHERE id=?').run(b.name, b.kind, b.description, b.priority, JSON.stringify(b.include), JSON.stringify(b.exclude), id);
    if (!r.changes) return reply.code(404).send({ error: 'not_found' });
    reindexTopics(db); return { ok: true }; // local-only: cached AI summaries are reused
  });
  app.delete('/api/topics/:id', async (req) => { const { id } = idParam.parse(req.params); db.prepare('DELETE FROM topics WHERE id = ?').run(id); reindexTopics(db); return { ok: true }; }); // also clears blocked flags the topic caused

  // ---- preferences ----
  const prefsSchema = z.object({
    weights: z.object({ interests: z.number().min(0).max(1), importance: z.number().min(0).max(1), recency: z.number().min(0).max(1), source: z.number().min(0).max(1), feedback: z.number().min(0).max(1) }),
    quotas: z.object({ personalized: z.number().min(0).max(1), major: z.number().min(0).max(1), local: z.number().min(0).max(1) }),
    preferredPublishers: z.array(z.string().max(80)).max(50), mutedPublishers: z.array(z.string().max(80)).max(50),
    theme: z.enum(['light', 'dark', 'system']).optional(), showRead: z.boolean().optional(), showImages: z.boolean(), retentionDays: z.number().int().min(7).max(365), staleMinutes: z.number().int().min(15).max(1440),
  });
  app.get('/api/prefs', async () => ({ prefs: getPrefs(db), publishers: (db.prepare('SELECT DISTINCT publisher FROM articles ORDER BY publisher').all() as any[]).map((r) => r.publisher) }));
  app.put('/api/prefs', async (req) => { const p = prefsSchema.parse(req.body); const cur = getPrefs(db); savePrefs(db, { ...p, theme: p.theme ?? cur.theme, showRead: p.showRead ?? cur.showRead }); return { ok: true }; }); // fields an older client omits are kept
  // Light/dark choice is stored server-side so it follows you across devices and survives deploys. No write if unchanged.
  app.put('/api/theme', async (req) => { const { theme } = z.object({ theme: z.enum(['light', 'dark', 'system']) }).parse(req.body); const cur = getPrefs(db); if (cur.theme !== theme) savePrefs(db, { ...cur, theme }); return { theme }; });
  app.put('/api/ai/budget', async (req) => { const { budget } = z.object({ budget: z.number().int().min(0).max(100000) }).parse(req.body); setSetting(db, 'ai_daily_budget', budget); return { ok: true }; });

  // ---- market ----
  app.get('/api/market', async () => ({ provider: market.providerInfo, quotes: market.quotes(), lastFetchedAt: market.lastFetch(), refreshing: market.running }));
  app.get('/api/market/series', async (req) => {
    const q = z.object({ symbol: z.string().max(20), range: z.enum(RANGES as [Range, ...Range[]]).default('1M') }).parse(req.query);
    return market.series(q.symbol, q.range);
  });
  app.get('/api/watchlist/search', medium, async (req, reply) => {
    const { q } = z.object({ q: z.string().trim().min(1).max(40) }).parse(req.query);
    try { return await d.provider.search(q); } catch (e) { if (e instanceof ProviderError) return reply.code(e.kind === 'no_key' ? 503 : 502).send({ error: e.kind, message: e.message }); throw e; }
  });
  const watchBody = z.object({ symbol: z.string().trim().toUpperCase().regex(/^[A-Z0-9.\-:^]{1,20}$/), name: z.string().trim().min(1).max(120), type: z.enum(['equity', 'etf', 'mutual_fund', 'index']), providerSymbol: z.string().trim().max(30).nullable().optional() });
  app.post('/api/watchlist', async (req, reply) => {
    const b = watchBody.parse(req.body);
    try {
      const pos = ((db.prepare('SELECT MAX(position) m FROM watchlist').get() as any).m ?? 0) + 1;
      db.prepare('INSERT INTO watchlist (symbol, name, instrument_type, provider_symbol, position) VALUES (?,?,?,?,?)').run(b.symbol, b.name, b.type, b.providerSymbol || null, pos);
      void market.refreshIfNeeded().catch(() => {});
      return reply.code(201).send({ ok: true });
    } catch (e) { if (String(e).includes('UNIQUE')) return reply.code(409).send({ error: 'duplicate' }); throw e; }
  });
  app.patch('/api/watchlist/:id', async (req) => {
    const { id } = idParam.parse(req.params); const b = watchBody.partial().parse(req.body);
    const cur = db.prepare('SELECT * FROM watchlist WHERE id = ?').get(id) as any; if (!cur) throw new FetchError('not found', 'not_found');
    db.prepare('UPDATE watchlist SET name=?, instrument_type=?, provider_symbol=? WHERE id=?').run(b.name ?? cur.name, b.type ?? cur.instrument_type, b.providerSymbol === undefined ? cur.provider_symbol : b.providerSymbol || null, id);
    db.prepare("DELETE FROM market_prices WHERE symbol = ?").run(cur.symbol); // provider mapping changed: drop stale cache
    void market.refreshIfNeeded().catch(() => {});
    return { ok: true };
  });
  app.delete('/api/watchlist/:id', async (req) => { const { id } = idParam.parse(req.params); const w = db.prepare('SELECT symbol FROM watchlist WHERE id = ?').get(id) as any; if (w) { db.prepare('DELETE FROM watchlist WHERE id = ?').run(id); db.prepare('DELETE FROM market_prices WHERE symbol = ?').run(w.symbol); } return { ok: true }; });
  app.get('/api/watchlist', async () => db.prepare('SELECT id, symbol, name, instrument_type AS type, provider_symbol AS providerSymbol FROM watchlist ORDER BY position, id').all());

  // ---- diagnostics + export ----
  app.get('/api/diagnostics', async () => {
    const n = (sql: string) => (db.prepare(sql).get() as any).n as number;
    const pages = (db.pragma('page_count', { simple: true }) as number) * (db.pragma('page_size', { simple: true }) as number);
    const mem = process.memoryUsage();
    return {
      status: status(), version: process.env.npm_package_version ?? '1.0.0', node: process.version, uptimeSec: Math.round(process.uptime()),
      memoryMB: { rss: Math.round(mem.rss / 1048576), heapUsed: Math.round(mem.heapUsed / 1048576) },
      counts: { articles: n('SELECT COUNT(*) n FROM articles'), clusters: n('SELECT COUNT(*) n FROM story_clusters'), multiSourceClusters: n('SELECT COUNT(*) n FROM story_clusters WHERE article_count > 1'), bookmarks: n('SELECT COUNT(*) n FROM bookmarks'), feedback: n('SELECT COUNT(*) n FROM feedback'), aiCacheEntries: n('SELECT COUNT(*) n FROM ai_cache'), headlineOnly: n("SELECT COUNT(*) n FROM articles WHERE availability = 'headline_only'") },
      db: { path: d.cfg.sqlitePath, approxSizeMB: +(pages / 1048576).toFixed(2), walSizeMB: +((fs.existsSync(d.cfg.sqlitePath + '-wal') ? fs.statSync(d.cfg.sqlitePath + '-wal').size : 0) / 1048576).toFixed(2) },
      sources: listSources(), ai: ai.usage(),
      market: { provider: market.providerInfo, lastFetchedAt: market.lastFetch(), cached: n("SELECT COUNT(*) n FROM market_prices WHERE error IS NULL"), errors: (db.prepare("SELECT symbol, error FROM market_prices WHERE error IS NOT NULL").all() as any[]) },
      jobs: (db.prepare('SELECT id, kind, status, trigger, started_at, finished_at, stats, error FROM processing_jobs ORDER BY started_at DESC LIMIT 10').all() as any[]).map((j) => ({ ...j, stats: j.stats ? JSON.parse(j.stats) : null })),
      cache: { staleAfterMinutes: getPrefs(db).staleMinutes, retentionDays: getPrefs(db).retentionDays },
    };
  });
  // Consistent online snapshot (SQLite backup API, WAL-safe), gzipped and streamed to the browser so the copy lives OFF the volume.
  app.get('/api/backup', heavy, async (_req, reply) => {
    const tmp = path.join(os.tmpdir(), `dash-backup-${process.pid}-${Date.now()}.sqlite`);
    await db.backup(tmp);
    const stream = fs.createReadStream(tmp).pipe(zlib.createGzip({ level: 6 }));
    stream.on('close', () => fs.rm(tmp, () => {}));
    reply.header('content-type', 'application/gzip').header('content-disposition', `attachment; filename="dashboard-${new Date().toISOString().slice(0, 10)}.sqlite.gz"`);
    return reply.send(stream);
  });
  app.get('/api/export', async (_req, reply) => {
    reply.header('content-disposition', 'attachment; filename="dashboard-settings.json"');
    return {
      exportedAt: new Date().toISOString(), prefs: getPrefs(db), topics: loadTopics(db).map(topicDto), watchlist: db.prepare('SELECT symbol, name, instrument_type, provider_symbol FROM watchlist').all(),
      sources: listSources().map((s) => ({ name: s.name, siteUrl: s.siteUrl, kind: s.kind, priority: s.priority, enabled: s.enabled })),
      bookmarks: db.prepare('SELECT c.title, a.url FROM bookmarks b JOIN story_clusters c ON c.id = b.cluster_id JOIN articles a ON a.id = c.primary_article_id').all(),
      settings: getSetting(db, 'ai_daily_budget', null),
    };
  });
}

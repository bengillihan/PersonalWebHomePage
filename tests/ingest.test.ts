import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { memDb, fixtureServer, rss, hoursAgo, logger, type Fixture } from './helpers.js';
import { ingestSource, processNewArticles, Refresher, pruneOldData, type SourceRow } from '../server/news/ingest.js';
import { headlineSimilarity, ungroupArticle, mergeClusters } from '../server/news/cluster.js';
import { discoverFeeds } from '../server/news/discover.js';
import { evaluateSource } from '../server/news/health.js';
import { seedDefaults } from '../server/seed.js';

let fx: Fixture;
beforeAll(async () => { fx = await fixtureServer(); });
afterAll(async () => { await fx.close(); });
const fo = { allowPrivate: true };

function addSource(db: ReturnType<typeof memDb>, name: string, path: string, priority = 1): SourceRow {
  const id = Number(db.prepare("INSERT INTO sources (name, site_url, feed_url, kind, priority, created_at) VALUES (?,?,?,'rss',?,?)").run(name, fx.url + '/site-' + name, fx.url + path, priority, Date.now()).lastInsertRowid);
  return db.prepare('SELECT * FROM sources WHERE id = ?').get(id) as SourceRow;
}

describe('ingestion', () => {
  it('imports once, dedupes exact duplicate URLs, skips unchanged, reprocesses changed', async () => {
    const db = memDb();
    fx.routes.set('/f1', { body: rss([
      { title: 'City council approves new park budget', link: 'https://ex.com/a?utm_source=rss', date: hoursAgo(2), desc: 'The council voted Tuesday to approve a new budget for parks across the city, funding three projects.' },
      { title: 'City council approves new park budget', link: 'https://www.ex.com/a/', date: hoursAgo(2), desc: 'dup' },
    ]) });
    const s = addSource(db, 'one', '/f1');
    const deps = { db, ai: null, log: logger, fetchOpts: fo };
    const first = await ingestSource(deps, s);
    expect(first).toHaveLength(1);
    expect(await ingestSource(deps, s)).toHaveLength(0); // unchanged -> nothing to reprocess
    expect((db.prepare('SELECT COUNT(*) n FROM articles').get() as any).n).toBe(1);
    fx.routes.set('/f1', { body: rss([{ title: 'City council approves new park budget', link: 'https://ex.com/a', date: hoursAgo(2), desc: 'Updated: the council also set aside money for trails and a dog park next year.' }]) });
    expect(await ingestSource(deps, s)).toHaveLength(1); // changed content -> reprocess
    expect((db.prepare("SELECT health FROM sources WHERE id=?").get(s.id) as any).health).toBe('ok');
  });

  it('marks stale and broken feeds honestly; never "ok"', async () => {
    const db = memDb();
    fx.routes.set('/stale', { body: `<rss><channel><title>Old</title><item><title>Old news</title><link>https://ex.com/o</link><pubDate>Thu, 01 Nov 2018 16:50:27 EDT</pubDate></item></channel></rss>` });
    fx.routes.set('/html', { type: 'text/html', body: '<html><body>not a feed</body></html>' });
    fx.routes.set('/blocked', { status: 403, type: 'text/html', body: 'forbidden' });
    const deps = { db, ai: null, log: logger, fetchOpts: fo };
    const stale = addSource(db, 'stale', '/stale'), html = addSource(db, 'html', '/html'), blocked = addSource(db, 'blocked', '/blocked');
    await Promise.all([stale, html, blocked].map((s) => ingestSource(deps, s)));
    const h = (id: number) => db.prepare('SELECT health, last_error FROM sources WHERE id=?').get(id) as any;
    expect(h(stale.id).health).toBe('stale'); expect(h(stale.id).last_error).toBeNull(); // stale content is not a failure: last_error is for failed checks only
    expect(evaluateSource(db.prepare('SELECT * FROM sources WHERE id=?').get(stale.id) as any).reason).toMatch(/Newest article is \d+h old/);
    expect(h(html.id).health).toBe('error');
    expect(h(blocked.id).health).toBe('error'); expect(h(blocked.id).last_error).toMatch(/403/);
    expect((db.prepare('SELECT COUNT(*) n FROM articles').get() as any).n).toBe(0); // 2018 item is older than retention
  });

  it('clusters same-event headlines from different publishers, keeps distinct developments apart', async () => {
    const db = memDb();
    fx.routes.set('/pa', { body: rss([
      { title: 'Boeing strike ends after union approves new contract', link: 'https://a.com/1', date: hoursAgo(5), desc: 'Boeing machinists voted to approve a new four-year contract, ending a strike that lasted several weeks.' },
      { title: 'Seattle Mariners trade pitcher before deadline', link: 'https://a.com/2', date: hoursAgo(5), desc: 'The Mariners acquired a veteran pitcher in a deal announced late Tuesday night before the deadline.' },
    ]) });
    fx.routes.set('/pb', { body: rss([
      { title: 'Union approves new contract, ending Boeing strike', link: 'https://b.com/9', date: hoursAgo(4), desc: 'Striking Boeing workers ratified a new contract on Wednesday, ending the walkout that started weeks ago.' },
      { title: 'Boeing strike talks resume with new offer on table', link: 'https://b.com/10', date: hoursAgo(60), desc: 'Talks resumed.' },
    ]) });
    const a = addSource(db, 'pa', '/pa'), b = addSource(db, 'pb', '/pb');
    const deps = { db, ai: null, log: logger, fetchOpts: fo };
    const ids = [...await ingestSource(deps, a), ...await ingestSource(deps, b)];
    await processNewArticles(deps, ids);
    const clusters = db.prepare('SELECT * FROM story_clusters ORDER BY article_count DESC').all() as any[];
    expect(clusters[0].article_count).toBe(2); expect(clusters[0].source_count).toBe(2);
    expect(clusters).toHaveLength(3); // boeing pair, mariners, old boeing talks story (outside 48h window)
    // every article keeps its link to its own publisher URL
    const members = db.prepare('SELECT url FROM articles WHERE cluster_id = ?').all(clusters[0].id) as any[];
    expect(members.map((m) => m.url).sort()).toEqual(['https://a.com/1', 'https://b.com/9']);
    // manual ungroup then merge
    const art = db.prepare('SELECT id FROM articles WHERE cluster_id = ? ORDER BY id DESC LIMIT 1').get(clusters[0].id) as any;
    const fresh = ungroupArticle(db, art.id);
    expect((db.prepare('SELECT article_count n FROM story_clusters WHERE id = ?').get(clusters[0].id) as any).n).toBe(1);
    expect((db.prepare('SELECT cluster_locked l FROM articles WHERE id = ?').get(art.id) as any).l).toBe(1);
    mergeClusters(db, [clusters[0].id, fresh]);
    expect((db.prepare('SELECT article_count n FROM story_clusters WHERE id = ?').get(clusters[0].id) as any).n).toBe(2);
    expect((db.prepare('SELECT COUNT(*) n FROM story_clusters WHERE id = ?').get(fresh) as any).n).toBe(0);
  });

  it('heuristics: same company different developments do not merge', () => {
    expect(headlineSimilarity('Apple unveils new iPhone with faster chip', 'Apple unveils new iPhone with faster chip and camera')).toBeGreaterThan(0.55);
    expect(headlineSimilarity('Apple unveils new iPhone with faster chip', 'Apple faces antitrust lawsuit over App Store fees')).toBeLessThan(0.36);
    expect(headlineSimilarity('Tesla recalls 20,000 vehicles over brake issue', 'Tesla recalls 5,000 trucks over seat belt fault')).toBeLessThan(0.55);
  });

  it('refresher coalesces concurrent triggers and never polls on its own', async () => {
    const db = memDb();
    fx.routes.set('/c1', { body: rss([{ title: 'Something happens locally today', link: 'https://c.com/1', date: hoursAgo(1), desc: 'x'.repeat(120) }]) });
    addSource(db, 'c', '/c1');
    const r = new Refresher({ db, ai: null, log: logger, fetchOpts: fo });
    const before = fx.hits.filter((h) => h === '/c1').length;
    const [s1, s2, s3] = await Promise.all([r.trigger('manual'), r.trigger('stale'), r.trigger('manual')]);
    expect(s1).toBe(s2); expect(s2).toBe(s3);
    expect(fx.hits.filter((h) => h === '/c1').length - before).toBe(1);
    expect(r.isStale()).toBe(false);
    await new Promise((ok) => setTimeout(ok, 50));
    expect(fx.hits.filter((h) => h === '/c1').length - before).toBe(1); // no background activity
    expect(r.maybeRefresh()).toBe(false); // fresh -> no refresh started
  });

  it('prunes old articles but preserves bookmarked stories', async () => {
    const db = memDb();
    const s = addSource(db, 'p', '/none');
    const ins = (title: string, ageDays: number) => { const id = Number(db.prepare(`INSERT INTO articles (source_id,url,canonical_url,canonical_hash,publisher,title,title_norm,published_at,fetched_at,content_hash,availability) VALUES (?,?,?,?,?,?,?,?,?,?,'headline_only')`).run(s.id, 'https://x/' + title, 'https://x/' + title, title, 'P', title, title, Date.now() - ageDays * 86_400_000, Date.now(), title).lastInsertRowid);
      const c = Number(db.prepare('INSERT INTO story_clusters (primary_article_id,title,first_published_at,last_published_at,updated_at,created_at) VALUES (?,?,?,?,?,?)').run(id, title, 0, Date.now() - ageDays * 86_400_000, 0, 0).lastInsertRowid);
      db.prepare('UPDATE articles SET cluster_id=? WHERE id=?').run(c, id); return c; };
    ins('fresh', 1); ins('old', 120); const keep = ins('old-bookmarked', 130);
    db.prepare('INSERT INTO bookmarks (cluster_id, created_at) VALUES (?,?)').run(keep, Date.now());
    pruneOldData(db);
    expect((db.prepare('SELECT title FROM articles ORDER BY title').all() as any[]).map((r) => r.title)).toEqual(['fresh', 'old-bookmarked']);
  });
});

describe('discovery + seeds', () => {
  it('discovers feeds from <link rel=alternate> and flags stale ones', async () => {
    fx.routes.set('/site', { type: 'text/html', body: `<html><head><title>My Site</title><link rel="alternate" type="application/rss+xml" href="/live.xml"><link rel="alternate" type="application/rss+xml" href="/dead.xml"></head></html>` });
    fx.routes.set('/live.xml', { body: rss([{ title: 'a', link: 'https://s.com/a', date: hoursAgo(3) }], 'Live') });
    fx.routes.set('/dead.xml', { body: `<rss><channel><title>Dead</title><item><title>x</title><link>https://s.com/x</link><pubDate>Thu, 01 Nov 2018 16:50:27 EDT</pubDate></item></channel></rss>` });
    const d = await discoverFeeds(fx.url + '/site', fo);
    expect(d.siteTitle).toBe('My Site');
    expect(d.candidates[0]).toMatchObject({ title: 'Live', freshness: { status: 'ok' } });
    expect(d.candidates.find((c) => c.title === 'Dead')!.freshness.status).toBe('stale');
    expect(d.rejected.length).toBeGreaterThan(0); // common paths that 404
  });
  it('discovery refuses private targets by default (SSRF)', async () => {
    await expect(discoverFeeds('http://127.0.0.1:8080/')).rejects.toThrow();
  });
  it('seeds are idempotent and a deleted seed is not resurrected', () => {
    const db = memDb();
    seedDefaults(db); seedDefaults(db);
    expect((db.prepare('SELECT COUNT(*) n FROM sources').get() as any).n).toBe(4);
    expect((db.prepare('SELECT COUNT(*) n FROM watchlist').get() as any).n).toBe(6);
    expect((db.prepare("SELECT kind FROM sources WHERE seed_key='mynorthwest'").get() as any).kind).toBe('aggregator');
    db.prepare("DELETE FROM sources WHERE seed_key='bbc-news'").run();
    seedDefaults(db);
    expect((db.prepare('SELECT COUNT(*) n FROM sources').get() as any).n).toBe(3);
  });
});

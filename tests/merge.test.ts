import { describe, it, expect, beforeEach } from 'vitest';
import { memDb } from './helpers.js';
import { mergeClusters } from '../server/news/cluster.js';
import { queryFeed } from '../server/news/query.js';
import type { DB } from '../server/db.js';

let db: DB;
let n = 0;
const sources: number[] = [];

/** Creates one story cluster holding one article from its own publisher. */
function story(title: string, publisher = `Pub${n}`): { cluster: number; article: number; source: number } {
  n++;
  const source = Number(db.prepare("INSERT INTO sources (name, site_url, created_at) VALUES (?,?,0)").run(publisher, `https://s${n}.example`).lastInsertRowid);
  sources.push(source);
  const now = Date.now();
  const article = Number(db.prepare(`INSERT INTO articles (source_id,url,canonical_url,canonical_hash,publisher,title,title_norm,published_at,fetched_at,content_hash,availability)
    VALUES (?,?,?,?,?,?,?,?,?,?,'headline_only')`).run(source, `https://s${n}.example/a`, `https://s${n}.example/a`, `h${n}`, publisher, title, title, now, now, `c${n}`).lastInsertRowid);
  const cluster = Number(db.prepare('INSERT INTO story_clusters (primary_article_id,title,first_published_at,last_published_at,updated_at,created_at) VALUES (?,?,?,?,?,?)').run(article, title, now, now, now, now).lastInsertRowid);
  db.prepare('UPDATE articles SET cluster_id = ? WHERE id = ?').run(cluster, article);
  db.prepare('INSERT INTO cluster_articles (cluster_id, article_id, manual, added_at) VALUES (?,?,0,?)').run(cluster, article, now);
  return { cluster, article, source };
}
const count = (sql: string, ...p: unknown[]) => (db.prepare(sql).get(...p) as { n: number }).n;
const bookmark = (c: number, at = Date.now()) => db.prepare('INSERT INTO bookmarks (cluster_id, created_at) VALUES (?,?)').run(c, at);
const rate = (s: { cluster: number; source: number }, rating: 1 | -1, o: { reason?: string | null; created?: number; updated?: number } = {}) => {
  db.prepare('INSERT INTO feedback (cluster_id, rating, reason, category, created_at, updated_at) VALUES (?,?,?,?,?,?)').run(s.cluster, rating, o.reason ?? null, 'Business', o.created ?? 100, o.updated ?? 100);
  db.prepare('INSERT INTO feedback_sources (cluster_id, source_id) VALUES (?,?)').run(s.cluster, s.source);
};
const readState = (c: number) => db.prepare('SELECT read_at, hidden_at FROM reading_state WHERE cluster_id = ?').get(c) as { read_at: number | null; hidden_at: number | null } | undefined;

beforeEach(() => { db = memDb(); sources.length = 0; });

describe('mergeClusters preserves user state (regression: merge used to cascade-delete it)', () => {
  it('REGRESSION: a bookmark on the merged-away cluster survives and stays in the Saved view', () => {
    const a = story('Boeing strike ends'), b = story('Union approves contract');
    bookmark(b.cluster, 555);
    expect(queryFeed(db, { tab: 'saved' }).items).toHaveLength(1); // before: saved via cluster b
    mergeClusters(db, [a.cluster, b.cluster]);
    expect(count('SELECT COUNT(*) n FROM story_clusters WHERE id = ?', b.cluster)).toBe(0);
    expect(db.prepare('SELECT created_at FROM bookmarks WHERE cluster_id = ?').get(a.cluster)).toEqual({ created_at: 555 });
    const saved = queryFeed(db, { tab: 'saved' }).items;
    expect(saved).toHaveLength(1); expect(saved[0].id).toBe(a.cluster); expect(saved[0].bookmarked).toBe(true); expect(saved[0].sourceCount).toBe(2);
    expect(count('SELECT COUNT(*) n FROM bookmarks')).toBe(1);
  });

  it('keeps a single bookmark with the earliest date when both clusters were saved', () => {
    const a = story('A'), b = story('B'), c = story('C');
    bookmark(a.cluster, 900); bookmark(b.cluster, 300); bookmark(c.cluster, 600);
    mergeClusters(db, [a.cluster, b.cluster, c.cluster]);
    expect(db.prepare('SELECT cluster_id, created_at FROM bookmarks').all()).toEqual([{ cluster_id: a.cluster, created_at: 300 }]);
  });

  it('transfers feedback (and the rated publisher) from a merged-away cluster; no duplicates', () => {
    const a = story('A'), b = story('B');
    rate(b, 1, { created: 50, updated: 60 });
    mergeClusters(db, [a.cluster, b.cluster]);
    expect(db.prepare('SELECT cluster_id, rating, created_at FROM feedback').all()).toEqual([{ cluster_id: a.cluster, rating: 1, created_at: 50 }]);
    expect(db.prepare('SELECT cluster_id, source_id FROM feedback_sources').all()).toEqual([{ cluster_id: a.cluster, source_id: b.source }]);
  });

  it('keeps the survivor\'s own feedback when the merged-away cluster has none', () => {
    const a = story('A'), b = story('B');
    rate(a, -1, { reason: 'topic' });
    mergeClusters(db, [a.cluster, b.cluster]);
    expect(db.prepare('SELECT rating, reason FROM feedback WHERE cluster_id = ?').get(a.cluster)).toEqual({ rating: -1, reason: 'topic' });
  });

  it('conflicting ratings: the most recent opinion wins and the other is dropped', () => {
    const a = story('A'), b = story('B');
    rate(a, 1, { updated: 100 }); rate(b, -1, { reason: 'source', updated: 200 });
    mergeClusters(db, [a.cluster, b.cluster]);
    expect(db.prepare('SELECT rating, reason FROM feedback').all()).toEqual([{ rating: -1, reason: 'source' }]);
    expect((db.prepare('SELECT source_id FROM feedback_sources').all() as any[]).map((r) => r.source_id)).toEqual([b.source]); // only the winning rating's publisher
    // and the reverse ordering
    const c = story('C'), d = story('D');
    rate(c, -1, { updated: 500 }); rate(d, 1, { updated: 400 });
    mergeClusters(db, [d.cluster, c.cluster]);
    expect(db.prepare('SELECT rating FROM feedback WHERE cluster_id = ?').get(d.cluster)).toEqual({ rating: -1 });
  });

  it('agreeing ratings combine: earliest created_at, any recorded reason, union of publishers', () => {
    const a = story('A'), b = story('B');
    rate(a, -1, { reason: null, created: 70, updated: 300 }); rate(b, -1, { reason: 'duplicate', created: 20, updated: 100 });
    mergeClusters(db, [a.cluster, b.cluster]);
    expect(db.prepare('SELECT rating, reason, created_at, updated_at FROM feedback').all()).toEqual([{ rating: -1, reason: 'duplicate', created_at: 20, updated_at: 300 }]);
    expect(count('SELECT COUNT(*) n FROM feedback_sources')).toBe(2);
  });

  it('read state: unread wins; read only when every merged story was read; hidden only when all were hidden', () => {
    const a = story('A'), b = story('B');
    db.prepare('INSERT INTO reading_state (cluster_id, read_at, hidden_at) VALUES (?,?,?)').run(b.cluster, 111, 222);
    mergeClusters(db, [a.cluster, b.cluster]);
    expect(readState(a.cluster)).toEqual({ read_at: null, hidden_at: null }); // a was untouched => unread & visible
    expect(queryFeed(db, { tab: 'unread' }).items.map((i) => i.id)).toContain(a.cluster);

    const c = story('C'), d = story('D');
    db.prepare('INSERT INTO reading_state (cluster_id, read_at, hidden_at) VALUES (?,?,?)').run(c.cluster, 100, 300);
    db.prepare('INSERT INTO reading_state (cluster_id, read_at, hidden_at) VALUES (?,?,?)').run(d.cluster, 200, 400);
    mergeClusters(db, [c.cluster, d.cluster]);
    expect(readState(c.cluster)).toEqual({ read_at: 200, hidden_at: 400 });
    expect(count('SELECT COUNT(*) n FROM reading_state WHERE cluster_id = ?', d.cluster)).toBe(0);
  });

  it('keeps every article, its own publisher/URL, manual+locked flags, and recomputes counts', () => {
    const a = story('A', 'Alpha'), b = story('B', 'Beta'), c = story('C', 'Gamma');
    mergeClusters(db, [a.cluster, b.cluster, c.cluster]);
    const arts = db.prepare('SELECT id, publisher, url, cluster_id, cluster_locked FROM articles ORDER BY id').all() as any[];
    expect(arts.map((x) => [x.publisher, x.cluster_id, x.cluster_locked])).toEqual([['Alpha', a.cluster, 0], ['Beta', a.cluster, 1], ['Gamma', a.cluster, 1]]);
    expect(arts.every((x) => x.url.startsWith('https://s'))).toBe(true);
    expect(db.prepare('SELECT article_count, source_count FROM story_clusters').all()).toEqual([{ article_count: 3, source_count: 3 }]);
    expect((db.prepare('SELECT article_id, cluster_id FROM cluster_articles ORDER BY article_id').all() as any[]).map((r) => r.cluster_id)).toEqual([a.cluster, a.cluster, a.cluster]);
    expect(count('SELECT COUNT(*) n FROM story_clusters')).toBe(1);
  });

  it('is atomic: a failure part-way rolls back articles, bookmarks, feedback and clusters', () => {
    const a = story('A'), b = story('B');
    bookmark(b.cluster, 1); rate(b, 1);
    db.exec(`CREATE TRIGGER boom BEFORE DELETE ON story_clusters BEGIN SELECT RAISE(ABORT, 'boom'); END;`);
    expect(() => mergeClusters(db, [a.cluster, b.cluster])).toThrow(/boom/);
    expect(count('SELECT COUNT(*) n FROM story_clusters')).toBe(2);
    expect(db.prepare('SELECT cluster_id FROM bookmarks').all()).toEqual([{ cluster_id: b.cluster }]); // not half-moved
    expect(db.prepare('SELECT cluster_id FROM feedback').all()).toEqual([{ cluster_id: b.cluster }]);
    expect((db.prepare('SELECT cluster_id FROM articles ORDER BY id').all() as any[]).map((r) => r.cluster_id)).toEqual([a.cluster, b.cluster]);
  });

  it('rejects repeated ids and unknown clusters without deleting anything', () => {
    const a = story('A'), b = story('B');
    bookmark(a.cluster);
    expect(() => mergeClusters(db, [a.cluster, a.cluster])).toThrow(/at least two/);
    expect(() => mergeClusters(db, [a.cluster, 99999])).toThrow(/not found/);
    expect(count('SELECT COUNT(*) n FROM story_clusters')).toBe(2); expect(count('SELECT COUNT(*) n FROM bookmarks')).toBe(1);
    mergeClusters(db, [a.cluster, b.cluster, a.cluster]); // duplicate ignored, merge still works
    expect(count('SELECT COUNT(*) n FROM story_clusters')).toBe(1); expect(count('SELECT COUNT(*) n FROM bookmarks')).toBe(1);
  });
});

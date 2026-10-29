import { describe, it, expect, beforeEach } from 'vitest';
import { memDb } from './helpers.js';
import { pruneOldData } from '../server/news/ingest.js';
import { recomputeCluster, clusterContentHash } from '../server/news/cluster.js';
import { queryFeed } from '../server/news/query.js';
import { savePrefs, getPrefs } from '../server/settings.js';
import type { DB } from '../server/db.js';

let db: DB; let n = 0; const DAY = 86_400_000;
const src = (name: string) => Number(db.prepare('INSERT INTO sources (name, site_url, created_at) VALUES (?,?,0)').run(name, `https://${name}${++n}.example`).lastInsertRowid);
/** An article `ageDays` old in the story (a new story if `cluster` is omitted). */
function art(source: number, title: string, ageDays: number, cluster?: number) {
  n++; const at = Date.now() - ageDays * DAY; const pub = (db.prepare('SELECT name FROM sources WHERE id = ?').get(source) as any).name;
  const excerpt = `${title}. Details from ${pub} about this story, long enough to be a real excerpt.`;
  const a = Number(db.prepare(`INSERT INTO articles (source_id,url,canonical_url,canonical_hash,publisher,title,title_norm,excerpt,published_at,fetched_at,content_hash,availability,summary,summary_kind,importance)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,'excerpt',?,?,0.5)`).run(source, `https://x.example/${n}`, `https://x.example/${n}`, `h${n}`, pub, title, title.toLowerCase(), excerpt, at, at, `c${n}`, `${pub} summary: ${excerpt}`, 'excerpt').lastInsertRowid);
  const c = cluster ?? Number(db.prepare('INSERT INTO story_clusters (primary_article_id,title,first_published_at,last_published_at,updated_at,created_at) VALUES (?,?,?,?,?,?)').run(a, title, at, at, at, at).lastInsertRowid);
  db.prepare('UPDATE articles SET cluster_id = ? WHERE id = ?').run(c, a);
  db.prepare('INSERT INTO cluster_articles VALUES (?,?,0,?)').run(c, a, at);
  db.prepare('INSERT INTO article_sources VALUES (?,?,?)').run(a, source, at);
  recomputeCluster(db, c); return { cluster: c, article: a };
}
/** Gives a multi-article story the AI consolidated summary Gemini would have written from its CURRENT members. */
function aiSummarise(cluster: number, text = 'AI consolidated summary covering the old and new articles') {
  const hashes = (db.prepare('SELECT content_hash h FROM articles WHERE cluster_id = ?').all(cluster) as any[]).map((r) => r.h);
  db.prepare("UPDATE story_clusters SET summary = ?, summary_kind = 'ai', differences = 'Old source adds detail', summary_hash = ? WHERE id = ?").run(text, clusterContentHash(hashes), cluster);
}
const cluster = (id: number) => db.prepare('SELECT * FROM story_clusters WHERE id = ?').get(id) as any;
const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
const fk = () => db.pragma('foreign_key_check') as unknown[];
beforeEach(() => { db = memDb(); savePrefs(db, { ...getPrefs(db), retentionDays: 15 }); });

describe('retention pruning keeps surviving stories consistent', () => {
  it('REGRESSION: a story that loses its old primary article is recomputed (primary, title, counts, dates) with a safe local summary', () => {
    const a = src('Alpha'), b = src('Beta');
    const old = art(a, 'Alpha headline from long ago about the contract', 40);          // the old article is the primary (earliest, same rank)
    const fresh = art(b, 'Beta headline about the contract this week', 2, old.cluster);
    aiSummarise(old.cluster);
    expect(cluster(old.cluster)).toMatchObject({ article_count: 2, source_count: 2, primary_article_id: old.article, title: 'Alpha headline from long ago about the contract' });

    pruneOldData(db);

    const c = cluster(old.cluster);
    expect(c).toMatchObject({ article_count: 1, source_count: 1, primary_article_id: fresh.article, title: 'Beta headline about the contract this week' }); // before: still 2 / 2 / old primary / old title
    expect(c.summary).toContain('Beta summary'); expect(c.summary).not.toMatch(/AI consolidated|old and new/); // the AI summary described deleted content
    expect(c.summary_kind).toBe('excerpt'); expect(c.differences).toBeNull(); expect(c.summary_hash).toBeNull();
    expect(Math.round((Date.now() - c.first_published_at) / DAY)).toBe(2); expect(c.last_published_at).toBe(c.first_published_at); // dates follow the survivor
    expect(count(`SELECT COUNT(*) n FROM articles WHERE id = ${old.article}`)).toBe(0); expect(fk()).toEqual([]);
    const [item] = queryFeed(db, { tab: 'latest', limit: 10 }).items;
    expect(item).toMatchObject({ id: old.cluster, sourceCount: 1, title: 'Beta headline about the contract this week' }); expect(item.articles.map((x) => x.publisher)).toEqual(['Beta']);
  });

  it('multi-source coverage is recounted from the articles that remain, keeping their source relationships', () => {
    const a = src('Alpha'), b = src('Beta'), c = src('Gamma');
    const first = art(a, 'Alpha early report on the strike', 30), second = art(b, 'Beta early report on the strike', 25, first.cluster);
    const third = art(c, 'Gamma fresh report on the strike', 3, first.cluster); const fourth = art(b, 'Beta fresh follow up on the strike', 1, first.cluster);
    db.prepare('INSERT INTO article_sources VALUES (?,?,0)').run(third.article, a); // Alpha's feed also carries Gamma's article
    aiSummarise(first.cluster);
    expect(cluster(first.cluster)).toMatchObject({ article_count: 4, source_count: 3 });
    pruneOldData(db);
    const cl = cluster(first.cluster);
    expect(cl).toMatchObject({ article_count: 2, source_count: 2 }); expect(cl.summary_kind).not.toBe('ai' as never); // Gamma + Beta remain; AI text about deleted articles is gone
    expect((db.prepare('SELECT article_id, source_id FROM article_sources ORDER BY article_id, source_id').all() as any[]).map((r) => [r.article_id, r.source_id])).toEqual([[third.article, a], [third.article, c], [fourth.article, b]]);
    expect(db.prepare('SELECT COUNT(*) n FROM cluster_articles WHERE cluster_id = ?').get(first.cluster)).toEqual({ n: 2 });
    const [item] = queryFeed(db, { tab: 'latest', limit: 10 }).items; expect(item.articles.find((x) => x.id === third.article)!.alsoVia).toEqual(['Alpha']);
    expect(second.article).toBeGreaterThan(0);
  });

  it('keeps user state on surviving stories (read state) and still removes fully aged-out ones, with their cascade', () => {
    const a = src('Alpha'), b = src('Beta');
    const partial = art(a, 'Alpha old take', 40), partialNew = art(b, 'Beta new take on the same thing', 1, partial.cluster);
    db.prepare('INSERT INTO reading_state (cluster_id, read_at) VALUES (?,?)').run(partial.cluster, 123);
    const gone = art(a, 'Entirely old story', 50); db.prepare('INSERT INTO reading_state (cluster_id, read_at) VALUES (?,?)').run(gone.cluster, 5);
    const fresh = art(b, 'Entirely fresh story', 1);
    pruneOldData(db);
    expect(db.prepare('SELECT read_at FROM reading_state WHERE cluster_id = ?').all(partial.cluster)).toEqual([{ read_at: 123 }]); // survivor keeps its state
    expect(count(`SELECT COUNT(*) n FROM story_clusters WHERE id = ${gone.cluster}`)).toBe(0); expect(count(`SELECT COUNT(*) n FROM reading_state WHERE cluster_id = ${gone.cluster}`)).toBe(0);
    expect(count(`SELECT COUNT(*) n FROM story_clusters WHERE id IN (${partial.cluster}, ${fresh.cluster})`)).toBe(2);
    expect(partialNew.article).toBeGreaterThan(0); expect(fk()).toEqual([]);
  });

  it('saved and rated stories are still protected whole: nothing is pruned from them and they are not recomputed', () => {
    const a = src('Alpha'), b = src('Beta');
    const saved = art(a, 'Saved story old article', 40), savedNew = art(b, 'Saved story new article', 1, saved.cluster); aiSummarise(saved.cluster);
    db.prepare('INSERT INTO bookmarks VALUES (?,5)').run(saved.cluster);
    const rated = art(a, 'Rated story old article', 40), ratedNew = art(b, 'Rated story new article', 1, rated.cluster);
    db.prepare("INSERT INTO feedback (cluster_id, rating, reason, category, created_at, updated_at) VALUES (?,1,NULL,NULL,1,1)").run(rated.cluster); db.prepare('INSERT INTO feedback_sources VALUES (?,?)').run(rated.cluster, a);
    const before = JSON.stringify([cluster(saved.cluster), cluster(rated.cluster)]);
    pruneOldData(db);
    expect(JSON.stringify([cluster(saved.cluster), cluster(rated.cluster)])).toBe(before); // byte-identical: AI summary, counts, everything
    expect(count(`SELECT COUNT(*) n FROM articles WHERE cluster_id IN (${saved.cluster}, ${rated.cluster})`)).toBe(4);
    expect(db.prepare('SELECT cluster_id FROM bookmarks').all()).toEqual([{ cluster_id: saved.cluster }]); expect(db.prepare('SELECT cluster_id, source_id FROM feedback_sources').all()).toEqual([{ cluster_id: rated.cluster, source_id: a }]);
    expect(savedNew.article + ratedNew.article).toBeGreaterThan(0);
  });

  it('is one transaction: if recomputing a survivor fails, nothing at all is deleted', () => {
    const a = src('Alpha'), b = src('Beta');
    const old = art(a, 'Old article', 40), fresh = art(b, 'Fresh article', 1, old.cluster); const alone = art(a, 'Entirely old story', 50);
    db.exec(`CREATE TRIGGER boom BEFORE UPDATE ON story_clusters BEGIN SELECT RAISE(ABORT, 'boom'); END;`);
    expect(() => pruneOldData(db)).toThrow(/boom/);
    expect(count('SELECT COUNT(*) n FROM articles')).toBe(3); expect(count('SELECT COUNT(*) n FROM story_clusters')).toBe(2); expect(cluster(old.cluster).article_count).toBe(2); // all rolled back
    db.exec('DROP TRIGGER boom'); pruneOldData(db);
    expect(count('SELECT COUNT(*) n FROM articles')).toBe(1); expect(cluster(old.cluster)).toMatchObject({ article_count: 1, primary_article_id: fresh.article }); expect(alone.article).toBeGreaterThan(0); expect(fk()).toEqual([]);
  });

  it('pruning is local: it needs no AI object at all, and a second run changes nothing', () => {
    const a = src('Alpha'), b = src('Beta'); const old = art(a, 'Old', 40); art(b, 'Fresh', 1, old.cluster);
    expect(pruneOldData.length).toBeLessThanOrEqual(2); // (db, now?): no Gemini client is even reachable from here
    pruneOldData(db); const after = JSON.stringify(db.prepare('SELECT * FROM story_clusters').all());
    expect(pruneOldData(db).articles).toBe(0); expect(JSON.stringify(db.prepare('SELECT * FROM story_clusters').all())).toBe(after);
  });
});

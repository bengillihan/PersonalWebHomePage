import { describe, it, expect, beforeEach } from 'vitest';
import { memDb } from './helpers.js';
import { clusterArticles, createSingleton, mergeClusters, recomputeCluster } from '../server/news/cluster.js';
import { queryFeed } from '../server/news/query.js';
import type { Ai } from '../server/ai/gemini.js';
import type { DB } from '../server/db.js';

let db: DB; let n = 0; const HOUR = 3_600_000;
const source = (name: string) => Number(db.prepare('INSERT INTO sources (name, site_url, created_at) VALUES (?,?,0)').run(name, `https://${name}${++n}.example`).lastInsertRowid);
/** An ingested article, not yet clustered. */
function article(src: number, title: string, ageH = 2, excerpt = `${title}. Officials gave further detail on Wednesday.`) {
  n++; const at = Date.now() - ageH * HOUR; const pub = (db.prepare('SELECT name FROM sources WHERE id = ?').get(src) as any).name;
  const id = Number(db.prepare(`INSERT INTO articles (source_id,url,canonical_url,canonical_hash,publisher,title,title_norm,excerpt,published_at,fetched_at,content_hash,availability,summary,summary_kind)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,'excerpt',?,'excerpt')`).run(src, `https://e.example/${n}`, `https://e.example/${n}`, `h${n}`, pub, title, title.toLowerCase(), excerpt, at, at, `c${n}`, excerpt).lastInsertRowid);
  db.prepare('INSERT INTO article_sources VALUES (?,?,?)').run(id, src, at); return id;
}
const clusterOf = (a: number) => (db.prepare('SELECT cluster_id c FROM articles WHERE id = ?').get(a) as any).c as number;
const markRead = (c: number, at = Date.now()) => db.prepare('INSERT INTO reading_state (cluster_id, read_at) VALUES (?,?) ON CONFLICT(cluster_id) DO UPDATE SET read_at = excluded.read_at').run(c, at);
const feed = (extra: Record<string, string> = {}) => queryFeed(db, { tab: 'latest', limit: 50, ...extra }).items;
const sub = (c: number) => (db.prepare('SELECT substantive_at s, updated_at u FROM story_clusters WHERE id = ?').get(c) as { s: number | null; u: number });
const sameEvent = { canCall: () => true, enabled: true, verifyPairs: async (pairs: any[]) => new Map(pairs.map((p) => [p.id, true])) } as unknown as Ai;
const T = 'Seattle council approves housing proposal';
beforeEach(() => { db = memDb(); });

describe('coverage joining a story you already read does not bring it back', () => {
  it('REGRESSION: another publisher reporting the same facts (grouped locally) leaves it read and hidden; the story still records the new source', async () => {
    const a = source('Alpha'), b = source('Beta'); const x = article(a, T, 5); await clusterArticles(db, null, [x]);
    const c = clusterOf(x); markRead(c, Date.now() - 3 * HOUR); const before = sub(c);
    const y = article(b, 'Seattle council approves housing proposal after revisions', 1); await clusterArticles(db, null, [y]);
    expect(clusterOf(y)).toBe(c); expect(sub(c).u).toBeGreaterThan(before.u); // recently active...
    expect(sub(c).s).toBeNull(); // ...but no substantive version
    expect(feed()).toEqual([]); // before: updated_at > read_at made it reappear as "Updated"
    expect(feed({ q: 'housing' })[0]).toMatchObject({ id: c, isRead: true, isUpdated: false, sourceCount: 2 });
  });
  it('REGRESSION: the same holds when Gemini confirms the match', async () => {
    const a = source('Alpha'), b = source('Beta'); const x = article(a, 'Seahawks beat 49ers in overtime thriller at Lumen Field', 6); await clusterArticles(db, null, [x]);
    const c = clusterOf(x); markRead(c, Date.now() - 4 * HOUR);
    const y = article(b, 'Seahawks win overtime thriller over 49ers on Sunday', 1); await clusterArticles(db, sameEvent, [y]);
    expect(clusterOf(y)).toBe(c); expect(feed()).toEqual([]); expect(feed({ q: 'seahawks' })[0]).toMatchObject({ isRead: true, isUpdated: false, sourceCount: 2 });
  });
  it('an unread story is unaffected: it simply shows, with its new coverage', async () => {
    const a = source('Alpha'), b = source('Beta'); const x = article(a, T, 5); await clusterArticles(db, null, [x]);
    const y = article(b, 'Seattle council approves housing proposal after revisions', 1); await clusterArticles(db, null, [y]);
    expect(feed().map((s) => ({ id: s.id, isRead: s.isRead, sourceCount: s.sourceCount }))).toEqual([{ id: clusterOf(x), isRead: false, sourceCount: 2 }]);
  });
  it('a story that was already "Updated" only through new coverage (before this change) is read again, not resurfaced', () => {
    const a = source('Alpha'); const x = article(a, T, 5); db.prepare('INSERT INTO story_clusters (primary_article_id,title,first_published_at,last_published_at,updated_at,created_at) VALUES (?,?,?,?,?,?)').run(x, T, 1, 1, Date.now(), 1);
    const c = Number((db.prepare('SELECT MAX(id) m FROM story_clusters').get() as any).m); db.prepare('UPDATE articles SET cluster_id = ? WHERE id = ?').run(c, x); db.prepare('INSERT INTO cluster_articles VALUES (?,?,0,?)').run(c, x, 1);
    markRead(c, Date.now() - HOUR); expect(feed()).toEqual([]);
  });
});

describe('merging duplicate stories keeps what you have read', () => {
  const pair = () => { const a = source('Alpha'), b = source('Beta'); const x = article(a, T, 5), y = article(b, 'Council backs housing plan in Seattle vote', 4); return Promise.resolve([createSingleton(db, x), createSingleton(db, y)] as const); }; // two separate copies of one event
  it('REGRESSION: reading either copy counts as reading the shared event (manual merge)', async () => {
    const [c1, c2] = await pair(); expect(c1).not.toBe(c2); markRead(c2, Date.now() - HOUR); // only the second copy was opened
    mergeClusters(db, [c1, c2]);
    expect(feed()).toEqual([]); expect(feed({ q: 'housing' })[0]).toMatchObject({ id: c1, isRead: true, isUpdated: false }); // before: unread, back in the feed
    expect(queryFeed(db, { tab: 'unread' }).items).toEqual([]);
  });
  it('REGRESSION: the same when the first copy was the one read', async () => {
    const [c1, c2] = await pair(); markRead(c1, Date.now() - HOUR); mergeClusters(db, [c1, c2]); expect(feed()).toEqual([]);
  });
  it('a material development recorded on the other copy after you read reopens the story once, labelled Updated', async () => {
    const [c1, c2] = await pair(); markRead(c1, Date.now() - 2 * HOUR); db.prepare('UPDATE story_clusters SET substantive_at = ? WHERE id = ?').run(Date.now() - HOUR, c2);
    mergeClusters(db, [c1, c2]); expect(feed()[0]).toMatchObject({ id: c1, isRead: true, isUpdated: true });
    markRead(c1); expect(feed()).toEqual([]); // read again: hidden again
  });
  it('a development you had already seen (read after it) does not reopen it', async () => {
    const [c1, c2] = await pair(); db.prepare('UPDATE story_clusters SET substantive_at = ? WHERE id = ?').run(Date.now() - 3 * HOUR, c2); markRead(c1, Date.now() - HOUR);
    mergeClusters(db, [c1, c2]); expect(feed()).toEqual([]);
  });
  it('hidden still needs every copy hidden (hiding one part never buries the rest)', async () => {
    const [c1, c2] = await pair(); db.prepare('INSERT INTO reading_state (cluster_id, hidden_at) VALUES (?,?)').run(c2, Date.now()); mergeClusters(db, [c1, c2]);
    expect(feed().map((s) => s.id)).toEqual([c1]);
  });
  it('merging never touches unread stories or leaves orphaned state', async () => {
    const [c1, c2] = await pair(); mergeClusters(db, [c1, c2]); expect(feed()[0]).toMatchObject({ id: c1, isRead: false, isUpdated: false }); expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});

describe('only a material change advances the substantive version', () => {
  it('recomputing a story (summary refresh, new member) leaves it alone; the substantive flag does not', () => {
    const a = source('Alpha'); const x = article(a, T, 5); db.prepare('INSERT INTO story_clusters (primary_article_id,title,first_published_at,last_published_at,updated_at,created_at) VALUES (?,?,?,?,?,?)').run(x, T, 1, 1, 1, 1);
    const c = Number((db.prepare('SELECT MAX(id) m FROM story_clusters').get() as any).m); db.prepare('UPDATE articles SET cluster_id = ? WHERE id = ?').run(c, x); db.prepare('INSERT INTO cluster_articles VALUES (?,?,0,?)').run(c, x, 1);
    recomputeCluster(db, c, true); expect(sub(c).s).toBeNull(); expect(sub(c).u).toBeGreaterThan(1);
    recomputeCluster(db, c, true, true); expect(sub(c).s).toBeGreaterThan(0);
  });
});

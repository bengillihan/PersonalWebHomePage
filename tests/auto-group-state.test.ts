import { describe, it, expect, beforeEach } from 'vitest';
import { memDb } from './helpers.js';
import { clusterArticles } from '../server/news/cluster.js';
import type { Ai } from '../server/ai/gemini.js';
import type { DB } from '../server/db.js';

// A~B scores 0.367 (the "uncertain" band), so a model is asked whether B belongs with A. While it thinks, the user acts on B's own story.
const A = 'Seahawks beat 49ers in overtime thriller at Lumen Field';
const B = 'Seahawks win overtime thriller over 49ers on Sunday';

let db: DB; let n = 0; const HOUR = 3_600_000;
const source = (name: string) => Number(db.prepare('INSERT INTO sources (name, site_url, created_at) VALUES (?,?,0)').run(name, `https://${name}${++n}.example`).lastInsertRowid);
function article(src: number, title: string, ageH: number) {
  n++; const at = Date.now() - ageH * HOUR;
  const id = Number(db.prepare(`INSERT INTO articles (source_id,url,canonical_url,canonical_hash,publisher,title,title_norm,excerpt,published_at,fetched_at,content_hash,availability,summary,summary_kind)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,'excerpt',?,?)`).run(src, `https://e.example/${n}`, `https://e.example/${n}`, `h${n}`, `Pub${src}`, title, title.toLowerCase(), `${title}. Detail follows.`, at, at, `c${n}`, `${title}. Detail follows.`, 'excerpt').lastInsertRowid);
  db.prepare('INSERT INTO article_sources VALUES (?,?,?)').run(id, src, at); return id;
}
const clusterOf = (id: number) => (db.prepare('SELECT cluster_id c FROM articles WHERE id = ?').get(id) as any).c as number | null;
const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
const fk = () => db.pragma('foreign_key_check') as unknown[];
/** A model that says "same event", and lets the test act as the user at the moment it is thinking. */
const thinking = (whileThinking: () => void): Ai => ({ canCall: () => true, enabled: true, verifyPairs: async (pairs: any[]) => { whileThinking(); return new Map(pairs.map((p) => [p.id, true])); } }) as unknown as Ai;
const put = {
  bookmark: (c: number, at = 500) => db.prepare('INSERT OR REPLACE INTO bookmarks VALUES (?,?)').run(c, at),
  read: (c: number, at = 900) => db.prepare('INSERT INTO reading_state (cluster_id, read_at) VALUES (?,?) ON CONFLICT(cluster_id) DO UPDATE SET read_at = excluded.read_at').run(c, at),
  hidden: (c: number, at = 700) => db.prepare('INSERT INTO reading_state (cluster_id, hidden_at) VALUES (?,?) ON CONFLICT(cluster_id) DO UPDATE SET hidden_at = excluded.hidden_at').run(c, at),
  rate: (c: number, rating: 1 | -1, src: number, updated: number, o: { reason?: string | null; created?: number } = {}) => {
    db.prepare('INSERT OR REPLACE INTO feedback (cluster_id, rating, reason, category, created_at, updated_at) VALUES (?,?,?,?,?,?)').run(c, rating, o.reason ?? null, 'Sports', o.created ?? updated, updated);
    db.prepare('INSERT OR IGNORE INTO feedback_sources VALUES (?,?)').run(c, src);
  },
};
beforeEach(() => { db = memDb(); });

/** Phase 1 puts A in its own story and B in another; the model then merges B into A's story, which empties and deletes B's. */
async function run(whileThinking: (ctx: { a: number; b: number; ca: number; cb: number; s: number }) => void) {
  const s = source('ESPN'); const a = article(s, A, 3), b = article(s, B, 2); let ctx!: { a: number; b: number; ca: number; cb: number; s: number };
  await clusterArticles(db, thinking(() => { ctx = { a, b, ca: clusterOf(a)!, cb: clusterOf(b)!, s }; whileThinking(ctx); }), [a, b]);
  return ctx;
}

describe('automatic Gemini grouping never destroys user state', () => {
  it('REGRESSION: a story saved, rated and read while the model was thinking keeps all of it after being merged away', async () => {
    const ctx = await run(({ cb, s }) => { put.bookmark(cb, 555); put.rate(cb, 1, s, 600); put.read(cb, 900); });
    expect(clusterOf(ctx.b)).toBe(ctx.ca); expect(clusterOf(ctx.a)).toBe(ctx.ca); // merged into one story
    expect(count(`SELECT COUNT(*) n FROM story_clusters WHERE id = ${ctx.cb}`)).toBe(0); // the emptied story is gone, and not revived
    expect(db.prepare('SELECT cluster_id, created_at FROM bookmarks').all()).toEqual([{ cluster_id: ctx.ca, created_at: 555 }]); // before the fix: no rows
    expect(db.prepare('SELECT cluster_id, rating FROM feedback').all()).toEqual([{ cluster_id: ctx.ca, rating: 1 }]);
    expect(db.prepare('SELECT cluster_id, source_id FROM feedback_sources').all()).toEqual([{ cluster_id: ctx.ca, source_id: ctx.s }]);
    expect(fk()).toEqual([]); expect(count('SELECT COUNT(*) n FROM story_clusters')).toBe(1); expect(count('SELECT COUNT(*) n FROM cluster_articles')).toBe(2);
  });

  it('hidden and read status are carried too, following the documented merge rules (hidden/read only if every merged story was)', async () => {
    const ctx = await run(({ cb, ca }) => { put.hidden(cb, 800); put.hidden(ca, 710); put.read(cb, 900); put.read(ca, 450); }); // both hidden, both read
    expect(db.prepare('SELECT cluster_id, read_at, hidden_at FROM reading_state').all()).toEqual([{ cluster_id: ctx.ca, read_at: 900, hidden_at: 800 }]); // latest of each (before the fix: 450 / 710)
    expect(count(`SELECT COUNT(*) n FROM reading_state WHERE cluster_id = ${ctx.cb}`)).toBe(0);
  });

  it('...and a story only the obsolete side had read or hidden does not bury the merged story', async () => {
    const ctx = await run(({ cb }) => { put.hidden(cb, 800); put.read(cb, 900); }); // the target story was untouched
    expect(db.prepare('SELECT cluster_id, read_at, hidden_at FROM reading_state').all()).toEqual([{ cluster_id: ctx.ca, read_at: null, hidden_at: null }]);
  });

  it('REGRESSION: user changes made to the TARGET story during the wait are preserved and merged, with the latest opinion winning', async () => {
    const ctx = await run(({ ca, cb, s }) => { put.bookmark(ca, 800); put.rate(ca, -1, s, 300, { reason: 'topic' }); put.bookmark(cb, 400); put.rate(cb, 1, s, 650); });
    expect(db.prepare('SELECT cluster_id, created_at FROM bookmarks').all()).toEqual([{ cluster_id: ctx.ca, created_at: 400 }]); // one bookmark, earliest date
    expect(db.prepare('SELECT rating, reason FROM feedback').all()).toEqual([{ rating: 1, reason: null }]); // the later rating (650 > 300) wins
    expect(count('SELECT COUNT(*) n FROM feedback')).toBe(1); expect(count('SELECT COUNT(*) n FROM bookmarks')).toBe(1);
  });

  it('a user action on the target alone survives untouched', async () => {
    const ctx = await run(({ ca }) => { put.bookmark(ca, 123); put.read(ca, 456); });
    expect(db.prepare('SELECT cluster_id, created_at FROM bookmarks').all()).toEqual([{ cluster_id: ctx.ca, created_at: 123 }]);
    expect(db.prepare('SELECT read_at FROM reading_state').all()).toEqual([{ read_at: null }]); // obsolete story was unread, so the merged story is unread
  });

  it('a story that keeps other articles after one moves out is NOT deleted and keeps its own state', async () => {
    const s = source('ESPN'); const a = article(s, A, 3), b = article(s, B, 2), x = article(s, 'Seahawks win overtime thriller over 49ers Sunday afternoon', 1); // x merges with b (0.91) but not with a
    let ca = 0; let cb = 0;
    await clusterArticles(db, thinking(() => { ca = clusterOf(a)!; cb = clusterOf(b)!; put.bookmark(cb, 77); put.rate(cb, 1, s, 99); put.read(cb, 88); }), [a, b, x]);
    expect(cb).not.toBe(ca); expect(clusterOf(x)).toBe(cb); // x joined b's story in phase 1
    expect(clusterOf(b)).toBe(ca); // the model moved b into a's story...
    expect(db.prepare('SELECT id, article_count FROM story_clusters WHERE id = ?').get(cb)).toEqual({ id: cb, article_count: 1 }); // ...b's old story survives with x, recomputed
    expect(db.prepare('SELECT cluster_id FROM bookmarks').all()).toEqual([{ cluster_id: cb }]); // state stays with the story that remains
    expect(db.prepare('SELECT cluster_id FROM feedback').all()).toEqual([{ cluster_id: cb }]); expect(db.prepare('SELECT cluster_id FROM reading_state').all()).toEqual([{ cluster_id: cb }]);
    expect(fk()).toEqual([]);
  });

  it('is atomic: if the story cannot be deleted, the move and the state transfer are rolled back together', async () => {
    const s = source('ESPN'); const a = article(s, A, 3), b = article(s, B, 2); let ca = 0; let cb = 0;
    const ai = thinking(() => { ca = clusterOf(a)!; cb = clusterOf(b)!; put.bookmark(cb, 55); put.rate(cb, 1, s, 66); db.exec(`CREATE TRIGGER boom BEFORE DELETE ON story_clusters BEGIN SELECT RAISE(ABORT, 'boom'); END;`); });
    await expect(clusterArticles(db, ai, [a, b])).rejects.toThrow(/boom/);
    expect(clusterOf(b)).toBe(cb); expect(clusterOf(a)).toBe(ca); // b did not move
    expect(db.prepare('SELECT cluster_id FROM bookmarks').all()).toEqual([{ cluster_id: cb }]); // and nothing was copied to the other story
    expect(db.prepare('SELECT cluster_id FROM feedback').all()).toEqual([{ cluster_id: cb }]); expect(fk()).toEqual([]);
  });

  it('unrelated stories are never touched', async () => {
    const s = source('ESPN'); const other = article(s, 'Mayor unveils plan for harbor repairs this spring', 5);
    await clusterArticles(db, null, [other]); const co = clusterOf(other)!; put.bookmark(co, 11); put.rate(co, -1, s, 12); put.read(co, 13);
    const before = JSON.stringify(['bookmarks', 'feedback', 'feedback_sources', 'reading_state'].map((tb) => db.prepare(`SELECT * FROM ${tb}`).all()));
    const a = article(s, A, 3), b = article(s, B, 2);
    await clusterArticles(db, thinking(() => {}), [a, b]);
    expect(JSON.stringify(['bookmarks', 'feedback', 'feedback_sources', 'reading_state'].map((tb) => db.prepare(`SELECT * FROM ${tb}`).all()))).toBe(before);
    expect(clusterOf(other)).toBe(co);
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { memDb } from './helpers.js';
import { clusterArticles, headlineSimilarity, MERGE_THRESHOLD, UNCERTAIN_THRESHOLD } from '../server/news/cluster.js';
import { queryFeed } from '../server/news/query.js';
import type { Ai } from '../server/ai/gemini.js';
import type { DB } from '../server/db.js';

let db: DB; let n = 0; const HOUR = 3_600_000;
const source = (name: string) => Number(db.prepare('INSERT INTO sources (name, site_url, created_at) VALUES (?,?,0)').run(name, `https://${name}${++n}.example`).lastInsertRowid);
/** An ingested, not-yet-clustered article published `ageH` hours ago. */
function article(src: number, title: string, ageH = 2) {
  n++; const at = Date.now() - ageH * HOUR; const pub = (db.prepare('SELECT name FROM sources WHERE id = ?').get(src) as any).name;
  const id = Number(db.prepare(`INSERT INTO articles (source_id,url,canonical_url,canonical_hash,publisher,title,title_norm,excerpt,published_at,fetched_at,content_hash,availability,summary,summary_kind)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,'excerpt',?,?)`).run(src, `https://e.example/${n}`, `https://e.example/${n}`, `h${n}`, pub, title, title.toLowerCase(), `${title}. Detail follows.`, at, at, `c${n}`, `${title}. Detail follows.`, 'excerpt').lastInsertRowid);
  db.prepare('INSERT INTO article_sources VALUES (?,?,?)').run(id, src, at); return id;
}
const clusterOf = (id: number) => (db.prepare('SELECT cluster_id c FROM articles WHERE id = ?').get(id) as any).c as number | null;
const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
/** A model that records how often it is asked. */
const model = (answer: boolean) => { const st = { asked: 0, pairs: 0 }; return { st, ai: { canCall: () => true, enabled: true, verifyPairs: async (pairs: any[]) => { st.asked++; st.pairs += pairs.length; return new Map(pairs.map((p: any) => [p.id, answer])); } } as unknown as Ai }; };
beforeEach(() => { db = memDb(); });

describe('contradictory headlines are not merged just because they look alike', () => {
  it('REGRESSION: the reported pair scores 0.80 and used to merge automatically; now they stay separate stories', async () => {
    const s = source('Alpha'), t = source('Beta');
    const a = article(s, 'Seattle council approves housing proposal', 3), b = article(t, 'Seattle council rejects housing proposal', 2);
    expect(headlineSimilarity('Seattle council approves housing proposal', 'Seattle council rejects housing proposal')).toBeGreaterThan(MERGE_THRESHOLD); // the premise
    const { ai, st } = model(true);
    await clusterArticles(db, ai, [a, b]);
    expect(clusterOf(a)).not.toBe(clusterOf(b)); // before the fix: one story
    expect(count('SELECT COUNT(*) n FROM story_clusters')).toBe(2); expect(st.asked).toBe(0); // and no Gemini request was spent deciding it
    expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it.each([
    ['State senate passes budget bill', 'State senate fails budget bill'], ['City raises parking fees downtown', 'City cuts parking fees downtown'],
    ['Fed raises interest rates by a quarter point', 'Fed cuts interest rates by a quarter point'], ['Judge blocks new state law on rent', 'Judge upholds new state law on rent'],
    ['Seahawks beat 49ers in overtime thriller at Lumen Field', 'Seahawks lose overtime thriller to 49ers at Lumen Field'],
    ['Seahawks beat 49ers 27-24', '49ers beat Seahawks 27-24'], // opposite results, similarity 1.0
  ])('stays separate: %s / %s', async (x, y) => {
    const s = source('Alpha'); const a = article(s, x, 3), b = article(s, y, 2);
    await clusterArticles(db, null, [a, b]);
    expect(clusterOf(a)).not.toBe(clusterOf(b));
  });

  it('normal duplicates and updates still merge locally, with no Gemini request', async () => {
    const s = source('Alpha'), t = source('Beta');
    const a = article(s, 'Seattle council approves housing proposal', 3), b = article(t, 'Seattle council approves housing proposal after revisions', 2), c = article(t, 'Seahawks beat 49ers 27-24', 1), d = article(s, 'Seahawks beat 49ers 27-24', 1);
    const { ai, st } = model(true); await clusterArticles(db, ai, [a, b, c, d]);
    expect(clusterOf(a)).toBe(clusterOf(b)); expect(clusterOf(c)).toBe(clusterOf(d)); expect(clusterOf(a)).not.toBe(clusterOf(c));
    expect(st.asked).toBe(0);
  });

  it('sequential developments at different times stay separate, while later updates still join the right story', async () => {
    const s = source('Alpha');
    const monday = article(s, 'Seattle council approves housing proposal', 40), wednesday = article(s, 'Seattle council rejects housing proposal', 2); // 38 hours apart: inside the grouping window
    const update = article(s, 'Seattle council approves housing proposal after revisions', 1);
    await clusterArticles(db, null, [monday, wednesday, update]);
    expect(clusterOf(monday)).not.toBe(clusterOf(wednesday)); // two developments, two stories
    expect(clusterOf(update)).toBe(clusterOf(monday)); // an update to the approval belongs with the approval, not the rejection
  });

  it('an ambiguous (uncertain-band) pair without a contradiction still goes to Gemini, once, and follows its verdict', async () => {
    const A = 'Seahawks beat 49ers in overtime thriller at Lumen Field', B = 'Seahawks win overtime thriller over 49ers on Sunday';
    expect(headlineSimilarity(A, B)).toBeGreaterThanOrEqual(UNCERTAIN_THRESHOLD); expect(headlineSimilarity(A, B)).toBeLessThan(MERGE_THRESHOLD);
    for (const verdict of [true, false]) {
      db = memDb(); const s = source('ESPN'); const a = article(s, A, 3), b = article(s, B, 2); const { ai, st } = model(verdict);
      await clusterArticles(db, ai, [a, b]);
      expect(st.asked).toBe(1); expect(st.pairs).toBe(1); expect(clusterOf(a) === clusterOf(b)).toBe(verdict);
    }
  });

  it('REGRESSION: a contradictory pair inside the uncertain band is not sent to Gemini at all, and stays separate even if the model would have said "same"', async () => {
    const A = 'Seahawks win overtime thriller over 49ers on Sunday', B = 'Seahawks lose overtime thriller to 49ers at Lumen Field';
    expect(headlineSimilarity(A, B)).toBeGreaterThanOrEqual(UNCERTAIN_THRESHOLD); expect(headlineSimilarity(A, B)).toBeLessThan(MERGE_THRESHOLD);
    const s = source('ESPN'); const a = article(s, A, 3), b = article(s, B, 2); const { ai, st } = model(true);
    await clusterArticles(db, ai, [a, b]);
    expect(st.asked).toBe(0); expect(clusterOf(a)).not.toBe(clusterOf(b));
  });

  it('a story is not joined if ANY of its articles contradicts the new one, not just the closest', async () => {
    const s = source('Alpha');
    const neutral = article(s, 'Seattle council housing proposal vote', 4), rejects = article(s, 'Seattle council rejects housing proposal', 3), approves = article(s, 'Seattle council approves housing proposal', 2);
    await clusterArticles(db, null, [neutral, rejects, approves]);
    expect(clusterOf(neutral)).toBe(clusterOf(rejects)); // the neutral headline fits with the rejection
    expect(clusterOf(approves)).not.toBe(clusterOf(neutral)); // ...but the approval contradicts a member, so it is not pulled into that story
  });

  it('Gemini-assisted grouping is guarded too: a verdict is ignored if the target story turned out to contain a contradiction', async () => {
    const A = 'Seahawks beat 49ers in overtime thriller at Lumen Field', B = 'Seahawks win overtime thriller over 49ers on Sunday';
    const s = source('ESPN'); const a = article(s, A, 3), b = article(s, B, 2); let intruder = 0;
    const ai = { canCall: () => true, enabled: true, verifyPairs: async (pairs: any[]) => { // while the model thinks, a contradictory report is added to A's story
      intruder = article(s, 'Seahawks lose overtime thriller to 49ers at Lumen Field', 1);
      db.prepare('UPDATE articles SET cluster_id = ? WHERE id = ?').run(clusterOf(a), intruder); db.prepare('INSERT INTO cluster_articles VALUES (?,?,0,1)').run(clusterOf(a), intruder);
      return new Map(pairs.map((p: any) => [p.id, true]));
    } } as unknown as Ai;
    await clusterArticles(db, ai, [a, b]);
    expect(clusterOf(b)).not.toBe(clusterOf(a)); expect(clusterOf(intruder)).toBe(clusterOf(a)); expect(db.pragma('foreign_key_check')).toEqual([]);
  });

  it('keeps independent attribution and user state on both stories', async () => {
    const s = source('Alpha'), t = source('Beta');
    const a = article(s, 'Seattle council approves housing proposal', 3), b = article(t, 'Seattle council rejects housing proposal', 2);
    await clusterArticles(db, null, [a, b]);
    const ca = clusterOf(a)!, cb = clusterOf(b)!;
    db.prepare('INSERT INTO bookmarks VALUES (?,5)').run(ca); db.prepare("INSERT INTO feedback (cluster_id, rating, reason, category, created_at, updated_at) VALUES (?,1,NULL,NULL,1,1)").run(cb); db.prepare('INSERT INTO reading_state (cluster_id, read_at) VALUES (?,9)').run(cb);
    const items = queryFeed(db, { tab: 'latest', limit: 10, q: 'housing' }).items;
    expect(items).toHaveLength(2); expect(items.map((i) => [i.primary!.publisher, i.sourceCount]).sort()).toEqual([['Alpha', 1], ['Beta', 1]]); // each keeps its own publisher
    expect(items.find((i) => i.id === ca)).toMatchObject({ bookmarked: true }); expect(items.find((i) => i.id === cb)).toMatchObject({ rating: 1, isRead: true });
  });
});

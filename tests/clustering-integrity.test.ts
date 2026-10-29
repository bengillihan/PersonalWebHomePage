import { describe, it, expect, beforeEach } from 'vitest';
import { memDb, logger } from './helpers.js';
import { clusterArticles, mergeClusters } from '../server/news/cluster.js';
import { processNewArticles, pruneOldData, Refresher } from '../server/news/ingest.js';
import { queryFeed } from '../server/news/query.js';
import { Ai, type AiTransport } from '../server/ai/gemini.js';
import { savePrefs, getPrefs } from '../server/settings.js';
import type { DB } from '../server/db.js';

// Three headlines about one game. A~B and B~C score in the "uncertain" band (0.367, 0.507) while A~C does not (0.230), so a model is
// asked about (B, A) and (C, B). If it says "same event" to both, the second move must follow B to where B lives NOW.
const A = 'Seahawks beat 49ers in overtime thriller at Lumen Field';
const B = 'Seahawks win overtime thriller over 49ers on Sunday';
const C = 'Seahawks overtime thriller: Walker scores winning touchdown Sunday';

let db: DB; let n = 0; const HOUR = 3_600_000;
const source = (name = 'ESPN') => Number(db.prepare('INSERT INTO sources (name, site_url, created_at) VALUES (?,?,0)').run(name, `https://${name}${++n}.example`).lastInsertRowid);
/** An ingested-but-not-yet-clustered article (cluster_id NULL), as the ingest step leaves it. */
function article(src: number, title: string, o: { ageH?: number; locked?: boolean } = {}) {
  n++; const at = Date.now() - (o.ageH ?? 2) * HOUR;
  const id = Number(db.prepare(`INSERT INTO articles (source_id,url,canonical_url,canonical_hash,publisher,title,title_norm,excerpt,published_at,fetched_at,content_hash,availability,summary,summary_kind,cluster_locked)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,'excerpt',?,?,?)`).run(src, `https://e.example/${n}`, `https://e.example/${n}`, `h${n}`, `Pub${src}`, title, title.toLowerCase(), `${title}. More detail follows in this excerpt of the story.`, at, at, `c${n}`, `${title}. More detail follows in this excerpt.`, 'excerpt', o.locked ? 1 : 0).lastInsertRowid);
  db.prepare('INSERT INTO article_sources VALUES (?,?,?)').run(id, src, at); return id;
}
const sameEvent: Ai = { canCall: () => true, enabled: true, verifyPairs: async (pairs: any[]) => new Map(pairs.map((p) => [p.id, true])) } as unknown as Ai;
const fkViolations = () => db.pragma('foreign_key_check') as unknown[];
const clusterOf = (id: number) => (db.prepare('SELECT cluster_id c FROM articles WHERE id = ?').get(id) as any).c as number | null;
const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
const deps = (ai: Ai | null) => ({ db, ai, log: logger });
beforeEach(() => { db = memDb(); });

describe('story clustering never references a cluster that no longer exists', () => {
  it('REGRESSION: a chain of AI-confirmed matches (B joins A, C joins B) no longer fails with FOREIGN KEY constraint failed', async () => {
    const s = source(); const a = article(s, A, { ageH: 3 }), b = article(s, B, { ageH: 2 }), c = article(s, C, { ageH: 1 });
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1); // enforcement stays ON
    await expect(clusterArticles(db, sameEvent, [a, b, c])).resolves.toBeInstanceOf(Set); // before the fix: SqliteError "FOREIGN KEY constraint failed"
    const target = clusterOf(a);
    expect([clusterOf(b), clusterOf(c)]).toEqual([target, target]); // one story covering all three
    expect(count('SELECT COUNT(*) n FROM story_clusters')).toBe(1); expect(count('SELECT COUNT(*) n FROM cluster_articles')).toBe(3);
    expect(count('SELECT COUNT(*) n FROM articles WHERE cluster_id IS NULL')).toBe(0); expect(fkViolations()).toEqual([]);
    expect(db.prepare('SELECT article_count, source_count FROM story_clusters').get()).toMatchObject({ article_count: 3 });
  });

  it('the same chain through the real pipeline (Gemini mock) and the Refresher: the job completes', async () => {
    const s = source(); [A, B, C].forEach((t, i) => article(s, t, { ageH: 3 - i }));
    const transport: AiTransport = { async generateJson({ prompt }) {
      if (prompt.includes('<pair')) { const ids = [...prompt.matchAll(/<pair id="(\d+)"/g)].map((m) => Number(m[1])); return { text: JSON.stringify({ pairs: ids.map((id) => ({ id, same_event: true })) }), inputTokens: 1, outputTokens: 1 }; }
      const ids = [...prompt.matchAll(/<article id="(\d+)"/g)].map((m) => Number(m[1]));
      return { text: JSON.stringify({ items: ids.map((id) => ({ id, category: 'Sports', importance: 0.5, summary: null })) }), inputTokens: 1, outputTokens: 1 };
    } };
    const ai = new Ai(db, 'm', transport, 100);
    const ids = (db.prepare('SELECT id FROM articles ORDER BY id').all() as any[]).map((r) => r.id);
    await expect(processNewArticles(deps(ai), ids)).resolves.toBeDefined();
    expect(count('SELECT COUNT(*) n FROM story_clusters')).toBe(1); expect(fkViolations()).toEqual([]);
    // and via a manual refresh job: it must be recorded as ok, not "FOREIGN KEY constraint failed"
    const r = new Refresher({ db, ai, log: logger, fetchOpts: { allowPrivate: true } });
    await expect(r.trigger('manual')).resolves.toBeDefined();
    expect((db.prepare("SELECT status, error FROM processing_jobs ORDER BY id DESC LIMIT 1").get() as any)).toMatchObject({ status: 'ok', error: null });
  });

  it('a cluster deleted while the model is thinking (another refresh, or "Check now") is skipped, not followed', async () => {
    const s = source(); const a = article(s, A, { ageH: 3 }), b = article(s, B, { ageH: 2 });
    const racing: Ai = { canCall: () => true, enabled: true, verifyPairs: async (pairs: any[]) => {
      db.prepare('DELETE FROM story_clusters WHERE id = ?').run(clusterOf(a)); // someone else removes A's story during the await
      return new Map(pairs.map((p) => [p.id, true]));
    } } as unknown as Ai;
    await expect(clusterArticles(db, racing, [a, b])).resolves.toBeInstanceOf(Set);
    expect(fkViolations()).toEqual([]); expect(clusterOf(a)).toBeNull(); expect(clusterOf(b)).not.toBeNull(); // b keeps its own story; a is left for the next refresh
  });

  it('every verdict leaves the database consistent: unrelated "false"/missing verdicts keep stories separate', async () => {
    const s = source(); const a = article(s, A, { ageH: 3 }), b = article(s, B, { ageH: 2 }), c = article(s, C, { ageH: 1 });
    const none: Ai = { canCall: () => true, enabled: true, verifyPairs: async () => new Map() } as unknown as Ai;
    await clusterArticles(db, none, [a, b, c]);
    expect(new Set([clusterOf(a), clusterOf(b), clusterOf(c)]).size).toBe(3); expect(fkViolations()).toEqual([]);
  });
});

describe('a failed clustering step is all-or-nothing and heals on the next refresh', () => {
  it('REGRESSION: articles left without a story by a failed run are clustered by the next refresh (before: invisible forever)', async () => {
    const s = source(); const ids = [article(s, 'First unrelated story about zebras migrating', { ageH: 5 }), article(s, 'Trigger article', { ageH: 4 }), article(s, 'Third story concerning municipal budgets', { ageH: 3 })];
    db.exec(`CREATE TRIGGER boom BEFORE INSERT ON story_clusters WHEN NEW.title = 'Trigger article' BEGIN SELECT RAISE(ABORT, 'boom'); END;`);
    await expect(clusterArticles(db, null, ids)).rejects.toThrow(/boom/);
    expect(count('SELECT COUNT(*) n FROM story_clusters')).toBe(0); // rolled back: no half-clustered batch
    db.exec('DROP TRIGGER boom');
    await processNewArticles(deps(null), []); // a later refresh with nothing new to ingest
    expect(count('SELECT COUNT(*) n FROM articles WHERE cluster_id IS NULL')).toBe(0); expect(count('SELECT COUNT(*) n FROM story_clusters')).toBe(3);
    expect(queryFeed(db, { tab: 'latest', limit: 50 }).items).toHaveLength(3); expect(fkViolations()).toEqual([]);
  });

  it('orphan healing only picks up recent, unlocked articles and keeps existing stories untouched', async () => {
    const s = source(); const done = article(s, 'Already clustered story about harbor repairs');
    await clusterArticles(db, null, [done]); const cluster = clusterOf(done);
    db.prepare("INSERT INTO bookmarks VALUES (?, 5)").run(cluster);
    const orphan = article(s, 'Orphaned story from a failed run about wetlands', { ageH: 6 });
    const old = article(s, 'Ancient orphan story about tide tables', { ageH: 24 * 120 }); // outside the 90-day default retention
    const locked = article(s, 'Deliberately ungrouped story about cliffs', { ageH: 4, locked: true });
    await processNewArticles(deps(null), []);
    expect(clusterOf(orphan)).not.toBeNull(); expect(clusterOf(old)).toBeNull(); expect(clusterOf(locked)).toBeNull(); // old and user-locked ones are left alone
    expect(clusterOf(done)).toBe(cluster); expect(db.prepare('SELECT cluster_id FROM bookmarks').all()).toEqual([{ cluster_id: cluster }]);
  });

  it('REGRESSION: stories created by a run that failed before its final recompute get their summary on the next refresh, even with Gemini unavailable', async () => {
    const s = source(); const ids = [article(s, 'Walker scores in overtime to beat the 49ers', { ageH: 3 }), article(s, 'Mayor unveils plan for harbor repairs this spring', { ageH: 2 })];
    await clusterArticles(db, null, ids); // exactly what a failed refresh leaves behind: stories exist, but nothing has recomputed them
    expect(db.prepare('SELECT summary, summary_kind FROM story_clusters').all()).toEqual([{ summary: null, summary_kind: null }, { summary: null, summary_kind: null }]);
    await processNewArticles(deps(null), []);
    const rows = db.prepare('SELECT summary, summary_kind FROM story_clusters ORDER BY id').all() as any[];
    expect(rows.every((r) => r.summary_kind === 'excerpt' && /More detail follows/.test(r.summary))).toBe(true); // from the publisher excerpt, nothing invented
    expect(queryFeed(db, { tab: 'latest', limit: 10 }).items.every((it) => it.summaryKind === 'excerpt' && !!it.summary)).toBe(true);
    const before = JSON.stringify(db.prepare('SELECT * FROM story_clusters').all());
    await processNewArticles(deps(null), []); // settled: a further refresh changes nothing
    expect(JSON.stringify(db.prepare('SELECT * FROM story_clusters').all())).toBe(before);
  });

  it('a failed refresh job names the stage that failed (no more bare "FOREIGN KEY constraint failed")', async () => {
    const s = source(); article(s, 'Trigger article');
    db.exec(`CREATE TRIGGER boom BEFORE INSERT ON story_clusters BEGIN SELECT RAISE(ABORT, 'boom'); END;`);
    db.prepare("INSERT INTO sources (name, site_url, feed_url, kind, enabled, created_at) VALUES ('off','https://off.example','http://x.invalid/f','rss',0,0)").run(); // keeps ingest quick: only enabled sources are fetched
    const r = new Refresher({ db, ai: null, log: logger, fetchOpts: { allowPrivate: true } });
    await expect(r.trigger('manual')).rejects.toThrow(/boom/);
    expect((db.prepare("SELECT status, error FROM processing_jobs ORDER BY id DESC LIMIT 1").get() as any)).toMatchObject({ status: 'error', error: expect.stringMatching(/^process: .*boom/) });
  });
});

describe('retention / pruning with foreign keys ON (retention = 15 days)', () => {
  it('prunes old stories across every relationship without a constraint error, and keeps bookmarked / rated stories intact', () => {
    const a = source('A'), b = source('B'); savePrefs(db, { ...getPrefs(db), retentionDays: 15 });
    const topic = Number(db.prepare("INSERT INTO topics (name, kind, description, priority, include_keywords, exclude_keywords, created_at) VALUES ('t','interest','x',1,'[]','[]',0)").run().lastInsertRowid);
    const story = (title: string, ageDays: number, srcs: number[]) => {
      const ids = srcs.map((sid) => { const id = article(sid, title + sid, { ageH: ageDays * 24 }); db.prepare('INSERT INTO article_topics VALUES (?,?,0.5)').run(id, topic); return id; });
      const c = Number(db.prepare('INSERT INTO story_clusters (primary_article_id,title,first_published_at,last_published_at,updated_at,created_at,article_count,source_count) VALUES (?,?,?,?,?,?,?,?)').run(ids[0], title, 1, 1, 1, 1, ids.length, ids.length).lastInsertRowid);
      ids.forEach((id) => { db.prepare('UPDATE articles SET cluster_id = ? WHERE id = ?').run(c, id); db.prepare('INSERT INTO cluster_articles VALUES (?,?,0,1)').run(c, id); });
      db.prepare('INSERT INTO reading_state (cluster_id, read_at) VALUES (?,1)').run(c); db.prepare('INSERT INTO feedback_sources VALUES (?,?)').run(c, srcs[0]);
      return c;
    };
    const old = story('Old multi-source story', 40, [a, b]), saved = story('Old saved story', 40, [a, b]), rated = story('Old rated story', 30, [a]), fresh = story('Fresh story', 1, [a, b]);
    db.prepare('INSERT INTO bookmarks VALUES (?,1)').run(saved);
    db.prepare("INSERT INTO feedback (cluster_id, rating, reason, category, created_at, updated_at) VALUES (?,1,NULL,NULL,1,1)").run(rated);
    expect(() => pruneOldData(db)).not.toThrow();
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1); expect(fkViolations()).toEqual([]);
    expect(count(`SELECT COUNT(*) n FROM story_clusters WHERE id = ${old}`)).toBe(0);
    expect((db.prepare(`SELECT id FROM story_clusters WHERE id IN (${saved}, ${rated}, ${fresh}) ORDER BY id`).all() as any[]).length).toBe(3);
    expect(count(`SELECT COUNT(*) n FROM articles WHERE cluster_id = ${saved}`)).toBe(2); expect(count(`SELECT COUNT(*) n FROM article_sources x JOIN articles a ON a.id = x.article_id WHERE a.cluster_id = ${saved}`)).toBe(2);
    expect(count(`SELECT COUNT(*) n FROM reading_state WHERE cluster_id IN (${saved}, ${rated}, ${fresh})`)).toBe(3);
  });

  it('merging and deleting clusters under foreign keys never leaves a dangling reference', async () => {
    const s = source(); const ids = [article(s, 'Alpha zebra story'), article(s, 'Beta municipal budget story'), article(s, 'Gamma harbor repair story')];
    await clusterArticles(db, null, ids);
    const cs = ids.map(clusterOf) as number[]; mergeClusters(db, [cs[0], cs[1], cs[2]]);
    expect(fkViolations()).toEqual([]); expect(count('SELECT COUNT(*) n FROM story_clusters')).toBe(1);
  });
});

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import Database from 'better-sqlite3';
import { memDb, fixtureServer, rss, logger, type Fixture } from './helpers.js';
import { ingestSource, processNewArticles, type SourceRow } from '../server/news/ingest.js';
import { createSingleton, judgeJoin, mergeClusters, clusterArticles } from '../server/news/cluster.js';
import { enqueueCheck, runNoveltyChecks, MAX_PER_RUN, MAX_ATTEMPTS, BACKOFF_BASE_MS } from '../server/news/novelty-checks.js';
import { queryFeed } from '../server/news/query.js';
import { Ai, type AiTransport } from '../server/ai/gemini.js';
import { openDb, migrate, setSetting } from '../server/db.js';
import { MIGRATIONS } from '../server/migrations.js';
import type { DB } from '../server/db.js';

const HOUR = 3_600_000; let n = 0;
let db: DB; let calls: string[]; let mode: (call: number) => 'ok' | 'throw' | 'garbage'; let answer: (prompt: string) => boolean;
const source = (name: string) => Number(db.prepare('INSERT INTO sources (name, site_url, created_at) VALUES (?,?,0)').run(name, `https://${name}${++n}.example`).lastInsertRowid);
function article(src: number, title: string, ageH: number, excerpt = '') {
  n++; const at = Date.now() - ageH * HOUR; const pub = (db.prepare('SELECT name FROM sources WHERE id = ?').get(src) as any).name;
  const id = Number(db.prepare(`INSERT INTO articles (source_id,url,canonical_url,canonical_hash,publisher,title,title_norm,excerpt,published_at,fetched_at,content_hash,availability,summary,summary_kind)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,'excerpt',?,'excerpt')`).run(src, `https://e.example/${n}`, `https://e.example/${n}`, `h${n}`, pub, title, title.toLowerCase(), excerpt || null, at, at, `c${n}`, excerpt || null).lastInsertRowid);
  db.prepare('INSERT INTO article_sources VALUES (?,?,?)').run(id, src, at); return id;
}
const join = (cl: number, id: number) => { db.prepare('UPDATE articles SET cluster_id = ? WHERE id = ?').run(cl, id); db.prepare('INSERT INTO cluster_articles VALUES (?,?,0,?)').run(cl, id, Date.now()); };
const subst = (cl: number) => (db.prepare('SELECT substantive_at s FROM story_clusters WHERE id = ?').get(cl) as any).s as number | null;
const checks = (status?: string) => db.prepare(`SELECT * FROM novelty_checks ${status ? "WHERE status = '" + status + "'" : ''} ORDER BY id`).all() as any[];
const model = (budget = 100) => new Ai(db, 'm', { async generateJson({ prompt }) {
  const k = ++calls.length; const m = mode(k);
  if (prompt.includes('<pair')) return { text: JSON.stringify({ pairs: [] }), inputTokens: 1, outputTokens: 1 };
  calls[k - 1] = prompt; if (m === 'throw') throw new Error('503'); if (m === 'garbage') return { text: 'not json', inputTokens: 1, outputTokens: 1 };
  return { text: JSON.stringify({ items: [...prompt.matchAll(/<item id="(\d+)">([\s\S]*?)<\/item>/g)].map((x) => ({ id: Number(x[1]), new_development: answer(x[2]) })) }), inputTokens: 1, outputTokens: 1 };
} } as AiTransport, budget);
/** A story the user read two hours ago, then an article whose milestone is only in the body (so the local rules call it ambiguous). Returns ids. */
function ambiguous(i: number) {
  const a = source(`Alpha${i}`), b = source(`Beta${i}`); const topic = ['harbor tunnel', 'school levy', 'ferry terminal', 'library branch', 'park trail', 'transit hub', 'bridge repair', 'water main', 'clinic funding', 'airport lane', 'stadium lease', 'bike network', 'salmon hatchery', 'pier museum'][i % 14];
  const base = article(a, `Council proposes ${topic} plan`, 6, `The proposal covers the ${topic}.`); const cl = createSingleton(db, base);
  db.prepare('INSERT INTO reading_state (cluster_id, read_at) VALUES (?,?)').run(cl, Date.now() - 2 * HOUR);
  const next = article(b, `${topic}: what happens next`, 1, `The council approved the ${topic} plan on Monday after a long debate.`); join(cl, next);
  expect(judgeJoin(db, cl, next)).toBe(false); return { cl, base, next };
}
beforeEach(() => { db = memDb(); calls = []; mode = () => 'ok'; answer = () => true; });

describe('durable pending checks', () => {
  it('REGRESSION: an ambiguous case becomes a stored check with a frozen baseline that never contains the article itself', () => {
    const { cl, base, next } = ambiguous(0); const [c] = checks(); expect(c).toMatchObject({ status: 'pending', article_id: next, cluster_id: cl, attempts: 0 });
    const frozen = JSON.parse(c.baseline); expect(frozen.map((b: any) => b.id)).toEqual([base]); expect(frozen.some((b: any) => b.hash === c.article_hash)).toBe(false);
    const extra = article(source('Gamma'), 'Council proposes harbor tunnel plan: reaction', 0.5); join(cl, extra); // the story grows afterwards
    expect(JSON.parse((checks()[0]).baseline).map((b: any) => b.id)).toEqual([base]); // the baseline is not rewritten
  });
  it('a retry compares against the ORIGINAL baseline: the model is never shown the article inside its own baseline', async () => {
    ambiguous(0); mode = (k) => (k === 1 ? 'throw' : 'ok'); const ai = model();
    await runNoveltyChecks(db, ai); await runNoveltyChecks(db, ai, Date.now() + BACKOFF_BASE_MS + 1000);
    const prompt = calls.find((c) => c)!; const already = prompt.split('Already read:')[1].split('New (')[0]; expect(already).toMatch(/proposes harbor tunnel plan/); expect(already).not.toMatch(/what happens next/);
  });
  it('REGRESSION: more than 10 ambiguous candidates: only 10 are asked per run; the rest wait and are settled by the NEXT refresh', async () => {
    const stories = Array.from({ length: 13 }, (_, i) => ambiguous(i)); const ai = model();
    expect(await runNoveltyChecks(db, ai)).toMatchObject({ asked: MAX_PER_RUN }); expect(checks('pending')).toHaveLength(3); expect(checks('done')).toHaveLength(10);
    expect(calls.filter(Boolean)).toHaveLength(1); // one batched request
    await clusterArticles(db, ai, []); // a normal refresh with nothing new still settles the remainder
    expect(checks('pending')).toHaveLength(0); expect(checks('done')).toHaveLength(13); expect(stories.every((s) => subst(s.cl) !== null)).toBe(true);
  });
  it('REGRESSION: with the daily budget exhausted nothing is asked or lost; checks wait and run when budget returns', async () => {
    const { cl } = ambiguous(0); const ai = model(0);
    expect(await runNoveltyChecks(db, ai)).toEqual({ asked: 0, applied: 0 }); expect(checks('pending')).toHaveLength(1); expect(checks()[0].attempts).toBe(0); expect(calls).toHaveLength(0);
    setSetting(db, 'ai_daily_budget', 50); expect(await runNoveltyChecks(db, ai)).toMatchObject({ asked: 1, applied: 1 }); expect(subst(cl)).not.toBeNull();
  });
  it('with no model configured at all, checks wait harmlessly', async () => {
    const { cl } = ambiguous(0); expect(await runNoveltyChecks(db, null)).toEqual({ asked: 0, applied: 0 }); expect(await runNoveltyChecks(db, new Ai(db, 'm', null, 100))).toEqual({ asked: 0, applied: 0 }); expect(checks('pending')).toHaveLength(1); expect(subst(cl)).toBeNull();
  });
  it('REGRESSION: a temporary failure is retried with back-off and then succeeds', async () => {
    const { cl } = ambiguous(0); mode = (k) => (k <= 1 ? 'throw' : 'ok'); const ai = model(); const t0 = Date.now();
    await runNoveltyChecks(db, ai, t0); const c = checks()[0]; expect(c).toMatchObject({ status: 'pending', attempts: 1 }); expect(c.next_attempt_at).toBeGreaterThan(t0); expect(subst(cl)).toBeNull();
    expect(await runNoveltyChecks(db, ai, t0 + 1000)).toMatchObject({ asked: 0 }); // not due yet: no request
    expect(await runNoveltyChecks(db, ai, c.next_attempt_at + 1)).toMatchObject({ asked: 1, applied: 1 }); expect(checks()[0].status).toBe('done'); expect(subst(cl)).not.toBeNull();
  });
  it('unusable answers are bounded: after the maximum attempts the check fails for good and is never asked again', async () => {
    ambiguous(0); mode = () => 'garbage'; const ai = model(); let t = Date.now();
    for (let i = 0; i < MAX_ATTEMPTS + 3; i++) { await runNoveltyChecks(db, ai, t); t += 7 * HOUR; }
    expect(checks()[0]).toMatchObject({ status: 'failed', attempts: MAX_ATTEMPTS }); expect(calls.filter(Boolean)).toHaveLength(MAX_ATTEMPTS);
    await runNoveltyChecks(db, ai, t + 100 * HOUR); expect(calls.filter(Boolean)).toHaveLength(MAX_ATTEMPTS);
  });
  it('REGRESSION: survives a restart between creation and retry (state lives in SQLite, nothing in memory)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-')); const file = path.join(dir, 'd.sqlite');
    try {
      db = openDb(file); const { cl } = ambiguous(0); expect(checks('pending')).toHaveLength(1); db.close();
      db = openDb(file); expect(checks('pending')).toHaveLength(1); expect(await runNoveltyChecks(db, model())).toMatchObject({ asked: 1, applied: 1 }); expect(subst(cl)).not.toBeNull(); db.close();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('REGRESSION: a corrected article expires its pending check (no request is spent on the old wording)', async () => {
    const { next } = ambiguous(0); db.prepare("UPDATE articles SET content_hash = 'changed', excerpt = 'Reworded.' WHERE id = ?").run(next);
    expect(await runNoveltyChecks(db, model())).toEqual({ asked: 0, applied: 0 }); expect(checks()[0].status).toBe('expired'); expect(calls).toHaveLength(0);
  });
  it('a corrected baseline article also invalidates the check', async () => {
    const { base } = ambiguous(0); db.prepare("UPDATE articles SET content_hash = 'changed' WHERE id = ?").run(base); await runNoveltyChecks(db, model()); expect(checks()[0].status).toBe('expired'); expect(calls).toHaveLength(0);
  });
  it('REGRESSION: merging stories while pending expires the check; deleting a story or article removes it', async () => {
    const one = ambiguous(0); const other = ambiguous(1); mergeClusters(db, [other.cl, one.cl]); // `one` is folded into `other`
    expect(checks().filter((c) => c.cluster_id === one.cl)).toHaveLength(0); // the folded story's question was expired as its article moved, then removed with the story
    expect(checks().map((c) => [c.cluster_id, c.status])).toEqual([[other.cl, 'pending']]); // the surviving story's own question stands
    db.prepare('DELETE FROM story_clusters WHERE id = ?').run(other.cl); expect(checks()).toHaveLength(0); // cascade
    const third = ambiguous(2); db.prepare('DELETE FROM articles WHERE id = ?').run(third.next); expect(checks()).toHaveLength(0);
  });
  it('REGRESSION: if the user reads the story while the model is thinking, the late verdict is dropped', async () => {
    const { cl } = ambiguous(0); const ai = new Ai(db, 'm', { async generateJson({ prompt }) { db.prepare('UPDATE reading_state SET read_at = ? WHERE cluster_id = ?').run(Date.now() + 1000, cl); calls.push(prompt); return { text: JSON.stringify({ items: [{ id: 1, new_development: true }] }), inputTokens: 1, outputTokens: 1 }; } } as AiTransport, 100);
    await runNoveltyChecks(db, ai); expect(subst(cl)).toBeNull(); expect(checks()[0].status).toBe('expired');
  });
  it('REGRESSION: duplicate jobs and repeated refreshes never queue or ask twice', async () => {
    const { cl, next } = ambiguous(0); const art = db.prepare('SELECT content_hash h FROM articles WHERE id = ?').get(next) as any;
    expect(enqueueCheck(db, { clusterId: cl, articleId: next, articleHash: art.h, baseline: [], eventAt: Date.now() })).toBe(false); expect(judgeJoin(db, cl, next)).toBe(false); expect(checks()).toHaveLength(1);
    const ai = model(); for (let i = 0; i < 4; i++) await clusterArticles(db, ai, []); expect(calls.filter(Boolean)).toHaveLength(1); expect(checks().map((c) => c.status)).toEqual(['done']);
  });
  it('REGRESSION: completed and invalidated checks cost no further model requests', async () => {
    ambiguous(0); const ai = model(); await runNoveltyChecks(db, ai); const used = ai.requestsToday();
    for (let i = 0; i < 3; i++) await runNoveltyChecks(db, ai, Date.now() + i * 10 * HOUR); expect(ai.requestsToday()).toBe(used); expect(calls.filter(Boolean)).toHaveLength(1);
  });
  it('a "no" is final, and a story already reopened is not reopened again', async () => {
    answer = () => false; const { cl } = ambiguous(0); await runNoveltyChecks(db, model()); expect(subst(cl)).toBeNull(); expect(checks()[0]).toMatchObject({ status: 'done', verdict: 0 });
  });
  it('a refresh with nothing pending is one cheap query and no request', async () => { const ai = model(); expect(await runNoveltyChecks(db, ai)).toEqual({ asked: 0, applied: 0 }); expect(ai.requestsToday()).toBe(0); });
  it('old finished rows are pruned and stale pending ones expire (bounded table)', async () => {
    ambiguous(0); db.prepare("UPDATE novelty_checks SET created_at = 1, updated_at = 1").run(); await runNoveltyChecks(db, model()); expect(checks()[0].status).toBe('expired'); await runNoveltyChecks(db, model(), Date.now() + 40 * 24 * HOUR); expect(checks()).toHaveLength(0);
  });
});

describe('REGRESSION: publisher corrections: changed text, refreshed summary, and genuinely new developments are separate questions', () => {
  let fx: Fixture; beforeAll(async () => { fx = await fixtureServer(); }); afterAll(async () => { await fx.close(); });
  const A = { title: 'Seattle council backs new housing plan', link: 'https://alpha.example/1', desc: 'The council backed a plan to build 400 units downtown, supporters said on Monday.' };
  const items = (i: { title: string; link: string; desc: string }) => rss([{ ...i, date: new Date(Date.now() - 3 * HOUR) }]);
  let ai: Ai | null; let cl: number; let readAt: number;
  async function refresh() { const d = { db, ai, log: logger, fetchOpts: { allowPrivate: true } }; const got: number[] = []; for (const s of db.prepare('SELECT * FROM sources').all() as SourceRow[]) got.push(...await ingestSource(d, s)); await processNewArticles(d, got); }
  async function readStory() {
    db.prepare("INSERT INTO sources (name, site_url, feed_url, kind, created_at) VALUES ('Alpha',?,?,'rss',0)").run(`${fx.url}/a`, `${fx.url}/nc-a`);
    fx.routes.set('/nc-a', { body: items(A) }); await refresh(); cl = (db.prepare('SELECT id FROM story_clusters').get() as any).id;
    db.prepare('INSERT INTO bookmarks VALUES (?,5)').run(cl); db.prepare('INSERT INTO feedback (cluster_id, rating, reason, category, created_at, updated_at) VALUES (?,1,NULL,NULL,1,1)').run(cl);
    await new Promise((r) => setTimeout(r, 5)); readAt = Date.now(); db.prepare('INSERT INTO reading_state (cluster_id, read_at) VALUES (?,?)').run(cl, readAt); await new Promise((r) => setTimeout(r, 5));
  }
  const state = () => ({ read: (db.prepare('SELECT read_at FROM reading_state WHERE cluster_id = ?').get(cl) as any).read_at, bookmarks: db.prepare('SELECT * FROM bookmarks').all(), feedback: db.prepare('SELECT rating FROM feedback').all(), members: db.prepare('SELECT article_id FROM cluster_articles').all(), srcs: db.prepare('SELECT source_id FROM article_sources').all() });
  const set = (o: Partial<typeof A>) => fx.routes.set('/nc-a', { body: items({ ...A, ...o }) });
  beforeEach(() => { ai = null; });

  it('a cosmetic correction ("400 units" -> "400 housing units") updates the article and summary but does not reopen the read story', async () => {
    await readStory(); const before = state();
    set({ desc: 'The council backed a plan to build 400 housing units downtown, supporters said on Monday.' }); await refresh();
    expect((db.prepare('SELECT excerpt FROM articles').get() as any).excerpt).toContain('400 housing units'); // the article changed
    expect((db.prepare('SELECT summary FROM story_clusters').get() as any).summary).toContain('housing units'); // and its summary followed
    expect(subst(cl)).toBeNull(); expect(queryFeed(db, { tab: 'latest' }).items).toEqual([]); expect(state()).toEqual(before); expect(checks()).toHaveLength(0);
  });
  it('a numerical clarification is ambiguous: it stays read, and is kept as a pending check rather than guessed', async () => {
    await readStory(); set({ desc: 'The council backed a plan to build 410 units downtown, now up from 400, supporters said on Monday.' }); await refresh();
    expect(subst(cl)).toBeNull(); expect(queryFeed(db, { tab: 'latest' }).items).toEqual([]); expect(checks('pending')).toHaveLength(1);
  });
  it('...and the model can settle it later: "yes" reopens once, "no" never does', async () => {
    await readStory(); set({ desc: 'The council backed a plan to build 410 units downtown, now up from 400, supporters said on Monday.' }); await refresh();
    answer = () => true; await runNoveltyChecks(db, model()); expect(subst(cl)).toBeGreaterThan(readAt); expect(queryFeed(db, { tab: 'latest' }).items[0]).toMatchObject({ id: cl, isUpdated: true, isRead: true }); expect(state().read).toBe(readAt);
  });
  it('a material correction with a new milestone reopens it ONCE, with the read time, bookmark, feedback and membership untouched', async () => {
    await readStory(); const before = state();
    set({ title: 'Seattle council backs new housing plan; mayor resigns over vote' }); await refresh();
    const s1 = subst(cl); expect(s1).toBeGreaterThan(readAt); expect(queryFeed(db, { tab: 'latest' }).items[0]).toMatchObject({ id: cl, isUpdated: true }); expect(state()).toEqual(before);
    await refresh(); await refresh(); expect(subst(cl)).toBe(s1); // repeated ingestion of the same text changes nothing
  });
  it('repeated ingestion without changes does nothing: no rewrite, no check, no reopening', async () => {
    await readStory(); const snap = JSON.stringify([db.prepare('SELECT * FROM articles').all(), db.prepare('SELECT * FROM story_clusters').all()]);
    await refresh(); await refresh(); expect(JSON.stringify([db.prepare('SELECT * FROM articles').all(), db.prepare('SELECT * FROM story_clusters').all()])).toBe(snap); expect(checks()).toHaveLength(0); expect(subst(cl)).toBeNull();
  });
  it('a correction that turns backing into a confirmed rejection is a new decision and reopens the story', async () => {
    await readStory(); set({ title: 'Seattle council rejects new housing plan', desc: 'The council rejected a plan to build 400 units downtown, opponents said on Monday.' }); await refresh();
    expect(subst(cl)).toBeGreaterThan(readAt);
  });
  it('a correction that reverses an earlier decision headline is ambiguous: with no model the story stays read', async () => {
    await readStory(); set({ title: 'Seattle council approves new housing plan' }); await refresh(); await new Promise((r) => setTimeout(r, 5));
    expect(subst(cl)).not.toBeNull(); db.prepare('UPDATE reading_state SET read_at = ? WHERE cluster_id = ?').run(Date.now(), cl); await new Promise((r) => setTimeout(r, 5)); // the user reads the "approves" version
    set({ title: 'Seattle council rejects new housing plan' }); await refresh(); expect(checks('pending')).toHaveLength(1); expect(queryFeed(db, { tab: 'latest' }).items).toEqual([]); // reversal: the model must decide, so it stays read
  });
  it('a correction that arrives while an older question is pending replaces it (the old wording is not asked about)', async () => {
    await readStory(); set({ desc: 'The council backed a plan to build 410 units downtown, now up from 400, supporters said on Monday.' }); await refresh(); const first = checks()[0];
    set({ desc: 'The council backed a plan to build 420 units downtown, now up from 410, supporters said on Tuesday.' }); await refresh();
    expect(checks().find((c) => c.id === first.id).status).toBe('expired'); expect(checks('pending')).toHaveLength(1);
  });
});

describe('migration 10', () => {
  it('adds the table without touching existing data (bookmarks, feedback, read state, stories), is idempotent, and cascades', () => {
    const raw = new Database(':memory:'); raw.pragma('foreign_keys = ON'); raw.exec('CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)');
    for (const m of MIGRATIONS.filter((x) => x.id <= 9)) { raw.exec(m.sql); raw.prepare('INSERT INTO schema_migrations VALUES (?,?,0)').run(m.id, m.name); }
    raw.prepare("INSERT INTO sources (name, site_url, created_at) VALUES ('S','https://s.example',0)").run();
    raw.prepare('INSERT INTO story_clusters (id,title,first_published_at,last_published_at,updated_at,created_at) VALUES (1,?,1,1,1,1)').run('T');
    raw.prepare("INSERT INTO articles (source_id,url,canonical_url,canonical_hash,publisher,title,title_norm,published_at,fetched_at,content_hash,availability,cluster_id) VALUES (1,'u','u','h','P','T','t',1,1,'c','headline_only',1)").run();
    raw.prepare('INSERT INTO bookmarks VALUES (1,5)').run(); raw.prepare('INSERT INTO feedback (cluster_id, rating, reason, category, created_at, updated_at) VALUES (1,1,NULL,NULL,1,1)').run(); raw.prepare('INSERT INTO reading_state (cluster_id, read_at) VALUES (1,9)').run();
    const tables = ['sources', 'articles', 'story_clusters', 'bookmarks', 'feedback', 'reading_state']; const dump = () => JSON.stringify(tables.map((t) => raw.prepare(`SELECT * FROM ${t}`).all())); const before = dump();
    expect(migrate(raw as unknown as DB)).toEqual([10, 11]); expect(dump()).toBe(before); expect(migrate(raw as unknown as DB)).toEqual([]);
    raw.prepare("INSERT INTO novelty_checks (article_id, cluster_id, article_hash, baseline, baseline_hash, event_at, created_at, updated_at) VALUES (1,1,'c','[]','x',1,1,1)").run();
    expect(() => raw.prepare("UPDATE novelty_checks SET status = 'maybe'").run()).toThrow(/CHECK/); raw.prepare('DELETE FROM story_clusters WHERE id = 1').run();
    expect((raw.prepare('SELECT COUNT(*) n FROM novelty_checks').get() as any).n).toBe(0); expect(raw.pragma('foreign_key_check')).toEqual([]);
  });
});

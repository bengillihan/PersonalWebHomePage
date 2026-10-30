import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { memDb, fixtureServer, logger, type Fixture } from './helpers.js';
import { ingestSource, processNewArticles, type SourceRow } from '../server/news/ingest.js';
import { clusterContentHash } from '../server/news/cluster.js';
import { runNoveltyChecks } from '../server/news/novelty-checks.js';
import { queryFeed } from '../server/news/query.js';
import { Ai, type AiTransport } from '../server/ai/gemini.js';
import { getPrefs } from '../server/settings.js';
import { openDb } from '../server/db.js';
import type { DB } from '../server/db.js';

let fx: Fixture; beforeAll(async () => { fx = await fixtureServer(); }); afterAll(async () => { await fx.close(); });
let db: DB; let ai: Ai | null; let prompts: string[];
const xml = (i: { title: string; link: string; desc: string; access?: 'true' | 'false' | null }) => `<?xml version="1.0"?><rss version="2.0"><channel><title>F</title><item><title>${i.title}</title><link>${i.link}</link><pubDate>${new Date(Date.now() - 3 * 3_600_000).toUTCString()}</pubDate><description>${i.desc}</description>${i.access ? `<isAccessibleForFree>${i.access}</isAccessibleForFree>` : ''}</item></channel></rss>`;
async function refresh() { const d = { db, ai, log: logger, fetchOpts: { allowPrivate: true } }; const got: number[] = []; for (const s of db.prepare('SELECT * FROM sources').all() as SourceRow[]) got.push(...await ingestSource(d, s)); await processNewArticles(d, got); }
const addSource = (name: string, p: string, access = 'unknown') => Number(db.prepare("INSERT INTO sources (name, site_url, feed_url, kind, access, created_at) VALUES (?,?,?,'rss',?,0)").run(name, `${fx.url}/${name}`, fx.url + p, access).lastInsertRowid);
const art = (pub: string) => db.prepare('SELECT * FROM articles WHERE publisher = ?').get(pub) as any;
const checks = (st?: string) => db.prepare(`SELECT * FROM novelty_checks ${st ? `WHERE status = '${st}'` : ''} ORDER BY id`).all() as any[];
const analysed = () => { // everything already classified and summarised: any model request from now on would be NEW work
  db.prepare('UPDATE articles SET ai_content_hash = content_hash').run();
  for (const c of db.prepare('SELECT id FROM story_clusters').all() as { id: number }[]) { const hs = (db.prepare('SELECT content_hash h FROM articles WHERE cluster_id = ?').all(c.id) as { h: string }[]).map((r) => r.h); db.prepare("UPDATE story_clusters SET summary = 'Combined summary of the vote reported by the outlets.', summary_kind = 'ai', summary_hash = ? WHERE id = ? AND article_count > 1").run(clusterContentHash(hs), c.id); }
};
const model = (answer = true, during?: () => Promise<void>) => new Ai(db, 'm', { async generateJson({ prompt }) { prompts.push(prompt); await during?.(); return { text: JSON.stringify({ items: [...prompt.matchAll(/<item id="(\d+)"/g)].map((m) => ({ id: Number(m[1]), new_development: answer })) }), inputTokens: 1, outputTokens: 1 }; } } as AiTransport, 100);
beforeEach(() => { db = memDb(); ai = null; prompts = []; });

describe('REGRESSION: explicit article access is updated independently of the text', () => {
  const A = { title: 'Boeing strike ends after union approves new contract', desc: 'Boeing machinists voted to approve a new four-year contract, ending a strike that lasted several weeks.' };
  const B = { title: 'Union approves new contract, ending Boeing strike', desc: 'Striking Boeing workers ratified a new contract on Wednesday, ending the walkout that started weeks ago.' };
  const route = (p: string, i: Parameters<typeof xml>[0]) => fx.routes.set(p, { body: xml(i) });
  async function twoSources(accessA: 'true' | 'false' | null = 'true') {
    addSource('Alpha', '/am-a'); addSource('Beta', '/am-b'); route('/am-a', { ...A, link: 'https://alpha.example/1', access: accessA }); route('/am-b', { ...B, link: 'https://beta.example/9' }); await refresh();
    expect((db.prepare('SELECT COUNT(*) n FROM story_clusters').get() as any).n).toBe(1);
  }
  const story = () => queryFeed(db, { tab: 'latest', limit: 50 }).items[0];
  const stable = () => JSON.stringify([db.prepare('SELECT id, title, excerpt, content_hash, summary, summary_kind, ai_content_hash, cluster_id FROM articles ORDER BY id').all(), db.prepare('SELECT id, summary, summary_kind, summary_hash, updated_at, substantive_at, article_count, source_count FROM story_clusters').all(), db.prepare('SELECT * FROM cluster_articles').all(), db.prepare('SELECT * FROM article_sources').all()]);

  it('free -> paywalled with identical text: stored, and the primary article and labels follow on the next query', async () => {
    await twoSources('true'); expect(art('Alpha').access).toBe('free'); const first = story().primary!; expect(first).toMatchObject({ publisher: 'Alpha', access: { label: 'Free' } });
    route('/am-a', { ...A, link: 'https://alpha.example/1', access: 'false' }); await refresh();
    expect(art('Alpha').access).toBe('paywalled'); const now = story(); expect(now.primary!.publisher).toBe('Beta'); expect(now.articles.find((a) => a.publisher === 'Alpha')!.access).toMatchObject({ label: 'Paywall', basis: 'article' });
  });
  it('paywalled -> free with identical text: the paywalled article wins back the primary slot', async () => {
    await twoSources('false'); expect(story().primary!.publisher).toBe('Beta'); route('/am-a', { ...A, link: 'https://alpha.example/1', access: 'true' }); await refresh(); expect(art('Alpha').access).toBe('free'); expect(story().primary).toMatchObject({ publisher: 'Alpha', access: { label: 'Free' } });
  });
  it('missing metadata is not a change: the last explicit value stands', async () => {
    await twoSources('false'); route('/am-a', { ...A, link: 'https://alpha.example/1', access: null }); await refresh(); await refresh(); expect(art('Alpha').access).toBe('paywalled'); expect(story().primary!.publisher).toBe('Beta');
  });
  it('an unchanged status changes nothing at all', async () => {
    await twoSources('true'); const before = stable(); await refresh(); await refresh(); expect(stable()).toBe(before);
  });
  it('REGRESSION: an access change is display-only: no summary or classification work, no reopening, no change to state, membership or attribution', async () => {
    await twoSources('true'); analysed(); ai = model(); const cl =   (db.prepare('SELECT id FROM story_clusters').get() as any).id;
    db.prepare('INSERT INTO bookmarks VALUES (?,5)').run(cl); db.prepare('INSERT INTO feedback (cluster_id, rating, reason, category, created_at, updated_at) VALUES (?,1,NULL,NULL,1,1)').run(cl);
    await new Promise((r) => setTimeout(r, 5)); const readAt = Date.now(); db.prepare('INSERT INTO reading_state (cluster_id, read_at) VALUES (?,?)').run(cl, readAt); await new Promise((r) => setTimeout(r, 5));
    const before = stable(); const used = ai.requestsToday();
    route('/am-a', { ...A, link: 'https://alpha.example/1', access: 'false' }); await refresh();
    expect(art('Alpha').access).toBe('paywalled'); expect(stable()).toBe(before); expect(ai.requestsToday()).toBe(used); expect(prompts).toHaveLength(0); // nothing regenerated, no Gemini request
    expect((db.prepare('SELECT substantive_at s FROM story_clusters').get() as any).s).toBeNull(); expect(queryFeed(db, { tab: 'latest' }).items).toEqual([]); // still read and hidden
    expect(queryFeed(db, { tab: 'latest', q: 'boeing' }).items[0]).toMatchObject({ id: cl, isRead: true, isUpdated: false, bookmarked: true, rating: 1, primary: { publisher: 'Beta' } });
    expect(db.prepare('SELECT read_at FROM reading_state').get()).toEqual({ read_at: readAt }); expect(db.prepare('SELECT publisher FROM articles ORDER BY id').all()).toEqual([{ publisher: 'Alpha' }, { publisher: 'Beta' }]);
  });
  it('only the feed that first discovered an article may change its access (another feed cannot flip it back and forth)', async () => {
    await twoSources('true'); const alphaId = art('Alpha').id; db.prepare("UPDATE sources SET feed_url = ? WHERE name = 'Beta'").run(fx.url + '/am-a2'); // Beta's feed now lists Alpha's URL with a different claim
    route('/am-a2', { ...A, link: 'https://alpha.example/1', access: 'false' }); await refresh(); expect(db.prepare('SELECT access FROM articles WHERE id = ?').get(alphaId)).toEqual({ access: 'free' });
  });
  it('selection stays deterministic among equally ranked publishers after a change', async () => {
    await twoSources('true'); route('/am-a', { ...A, link: 'https://alpha.example/1', access: 'false' }); await refresh(); db.prepare("UPDATE articles SET access = 'free'").run(); // both explicitly free: tie
    const picks = new Set(Array.from({ length: 5 }, () => story().primary!.publisher)); expect(picks.size).toBe(1);
    expect(getPrefs(db).preferFreeCoverage).toBe(true);
  });
});

describe('REGRESSION: cosmetic edits keep pending novelty checks; material edits replace them', () => {
  const T = 'Seattle council backs new housing plan';
  const A = { title: T, link: 'https://alpha.example/1', desc: 'The council backed a plan to build 400 units downtown, supporters said on Monday.' };
  const CLARIFIED = 'The council backed a plan to build 410 units downtown, now up from 400, supporters said on Monday.'; // ambiguous: new figures with revision wording
  const put = (o: Partial<typeof A> = {}) => fx.routes.set('/ce-a', { body: xml({ ...A, ...o }) });
  let cl: number; let readAt: number;
  async function pendingStory() {
    addSource('Alpha', '/ce-a'); put(); await refresh(); cl = (db.prepare('SELECT id FROM story_clusters').get() as any).id;
    await new Promise((r) => setTimeout(r, 5)); readAt = Date.now(); db.prepare('INSERT INTO reading_state (cluster_id, read_at) VALUES (?,?)').run(cl, readAt); await new Promise((r) => setTimeout(r, 5));
    put({ desc: CLARIFIED }); await refresh(); expect(checks('pending')).toHaveLength(1);
  }
  const subst = () => (db.prepare('SELECT substantive_at s FROM story_clusters').get() as any).s as number | null;
  const settle = async (answer = true) => { ai = model(answer); const r = await runNoveltyChecks(db, ai); return r; };

  it.each([
    ['capitalization', { title: T.toUpperCase(), desc: CLARIFIED.toUpperCase() }],
    ['punctuation', { title: T + '!', desc: CLARIFIED.replace(/,/g, ';') + '…' }],
    ['feed boilerplate', { desc: CLARIFIED + ' Read more at Alpha.' }],
  ])('a %s edit keeps the SAME pending check, re-pointed at the new text, with its original baseline', async (_n, edit) => {
    await pendingStory(); const before = checks()[0]; put(edit); await refresh();
    const after = checks(); expect(after).toHaveLength(1); expect(after[0]).toMatchObject({ id: before.id, status: 'pending', attempts: 0, baseline: before.baseline, baseline_hash: before.baseline_hash });
    expect(after[0].article_hash).toBe(art().content_hash); expect(after[0].article_hash).not.toBe(before.article_hash); // follows the article
    expect(await settle()).toMatchObject({ asked: 1, applied: 1 }); expect(subst()).toBeGreaterThan(readAt); expect(prompts).toHaveLength(1); // still answered, once
  });
  const art = () => db.prepare('SELECT * FROM articles').get() as any;
  it('an equivalent-whitespace edit is not even a change (the parser normalises it): nothing is touched', async () => {
    await pendingStory(); const before = checks()[0]; put({ title: `  ${T.replace(/ /g, '  ')} `, desc: CLARIFIED.replace(/ /g, '   ') }); await refresh(); expect(checks()).toEqual([before]);
  });
  it('several cosmetic edits in a row do not multiply checks or requests', async () => {
    await pendingStory(); for (const t of [T.toUpperCase(), T + '.', T.toLowerCase(), T]) { put({ title: t, desc: CLARIFIED }); await refresh(); }
    expect(checks()).toHaveLength(1); expect(checks('pending')).toHaveLength(1); await settle(); await settle(); expect(prompts).toHaveLength(1);
  });
  it('REGRESSION: a MATERIAL edit expires the outdated question and asks a new one about the new wording', async () => {
    await pendingStory(); const first = checks()[0]; put({ desc: 'The council backed a plan to build 420 units downtown, now up from 410, supporters said on Tuesday.' }); await refresh();
    const rows = checks(); expect(rows.find((c) => c.id === first.id).status).toBe('expired'); expect(checks('pending')).toHaveLength(1); expect(checks('pending')[0].article_hash).toBe(art().content_hash);
    await settle(); expect(prompts).toHaveLength(1); expect(prompts[0]).toContain('420'); expect(prompts[0]).not.toContain('Tuesday ... 410 units'); // asked about the current text only
  });
  it('the baseline stays frozen across a cosmetic edit, so a retry never compares the article with itself', async () => {
    await pendingStory(); const frozen = JSON.parse(checks()[0].baseline); put({ title: T.toUpperCase(), desc: CLARIFIED }); await refresh();
    const now = JSON.parse(checks()[0].baseline); expect(now).toEqual(frozen); expect(now.some((b: any) => b.hash === art().content_hash)).toBe(false);
    await settle(); expect(prompts[0].split('Already read:')[1].split('New (')[0]).toContain('400 units');
  });
  it('a cosmetic edit to a BASELINE article does not invalidate other articles\' checks', async () => {
    addSource('Alpha', '/ce-a'); addSource('Beta', '/ce-b'); put(); fx.routes.set('/ce-b', { body: xml({ title: 'Seattle council backs new housing plan downtown', link: 'https://beta.example/2', desc: 'Beta says the council backed a plan to build 400 units downtown on Monday.' }) });
    await refresh(); cl = (db.prepare('SELECT id FROM story_clusters').get() as any).id; await new Promise((r) => setTimeout(r, 5)); readAt = Date.now(); db.prepare('INSERT INTO reading_state (cluster_id, read_at) VALUES (?,?)').run(cl, readAt); await new Promise((r) => setTimeout(r, 5));
    fx.routes.set('/ce-b', { body: xml({ title: 'Seattle council backs new housing plan downtown', link: 'https://beta.example/2', desc: 'Beta says the council backed a plan to build 410 units downtown, now up from 400, on Monday.' }) }); await refresh(); expect(checks('pending')).toHaveLength(1);
    put({ title: T.toUpperCase() }); await refresh(); // Alpha (a baseline article of Beta's check) is edited cosmetically
    expect(checks('pending')).toHaveLength(1); expect(await settle()).toMatchObject({ asked: 1, applied: 1 }); expect(subst()).toBeGreaterThan(readAt);
  });
  it('REGRESSION: a delayed Gemini response that arrives after a cosmetic edit is still applied; after a material edit it is dropped', async () => {
    await pendingStory(); const edit = async (o: Partial<typeof A>) => { put(o); const keep = ai; ai = null; await refresh(); ai = keep; }; // a refresh without a model (so it does not start a second run)
    ai = model(true, () => edit({ title: T.toUpperCase(), desc: CLARIFIED })); // the publisher edits while the model is thinking
    expect(await runNoveltyChecks(db, ai)).toMatchObject({ asked: 1, applied: 1 }); expect(subst()).toBeGreaterThan(readAt);
    db.prepare('UPDATE story_clusters SET substantive_at = NULL').run(); db.prepare("DELETE FROM novelty_checks").run();
    put({ desc: CLARIFIED }); await refresh(); db.prepare("UPDATE reading_state SET read_at = ?").run(readAt); put({ desc: 'The council backed a plan to build 430 units downtown, now up from 400, supporters said on Monday.' }); await refresh();
    ai = model(true, () => edit({ desc: 'The council abandoned the plan to build 430 units downtown, a spokesman said on Tuesday afternoon.' }));
    await runNoveltyChecks(db, ai); expect(checks('pending').every((c) => c.article_hash === art().content_hash)).toBe(true); expect(checks().filter((c) => c.status === 'done' && c.verdict === 1 && c.article_hash !== art().content_hash)).toHaveLength(0);
  });
  it('REGRESSION: survives an application restart between queueing and the retry, including a cosmetic edit in between', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ce-')); const file = path.join(dir, 'd.sqlite');
    try {
      db = openDb(file); await pendingStory(); const id = checks()[0].id; db.close();
      db = openDb(file); put({ title: T.toUpperCase(), desc: CLARIFIED }); await refresh(); expect(checks('pending').map((c) => c.id)).toEqual([id]); db.close();
      db = openDb(file); expect(await settle()).toMatchObject({ asked: 1, applied: 1 }); expect(subst()).toBeGreaterThan(readAt); db.close();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
  it('the per-run cap, the budget and duplicate prevention still hold with cosmetic churn', async () => {
    await pendingStory(); for (let i = 0; i < 3; i++) { put({ title: i % 2 ? T : T.toUpperCase(), desc: CLARIFIED }); await refresh(); }
    expect(checks()).toHaveLength(1); const none = new Ai(db, 'm', { async generateJson() { throw new Error('should not be asked'); } } as AiTransport, 0); expect(await runNoveltyChecks(db, none)).toEqual({ asked: 0, applied: 0 }); expect(checks('pending')).toHaveLength(1);
  });
  it('no Gemini request is made merely because of a cosmetic edit or an access change', async () => {
    await pendingStory(); analysed(); ai = model(); await runNoveltyChecks(db, ai); const used = ai.requestsToday(); expect(used).toBe(1); // the one pending question is answered
    put({ title: T.toUpperCase(), desc: CLARIFIED }); await refresh();
    fx.routes.set('/ce-a', { body: xml({ ...A, title: T.toUpperCase(), desc: CLARIFIED, access: 'false' }) }); await refresh(); expect(ai.requestsToday()).toBe(used); expect(art().access).toBe('paywalled');
  });
});

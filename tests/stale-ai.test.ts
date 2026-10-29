import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { memDb, fixtureServer, rss, hoursAgo, logger, type Fixture } from './helpers.js';
import { ingestSource, processNewArticles, type SourceRow } from '../server/news/ingest.js';
import { clusterArticles } from '../server/news/cluster.js';
import { Ai, type AiTransport } from '../server/ai/gemini.js';
import type { DB } from '../server/db.js';

let fx: Fixture;
beforeAll(async () => { fx = await fixtureServer(); });
afterAll(async () => { await fx.close(); });

let db: DB;
const OLD = 'The council approved a four-year contract on Tuesday, ending a strike that lasted several weeks across the region.';
const NEW = 'Correction: the council rejected the contract on Tuesday by a narrow 4-3 vote after a long public hearing at city hall.';
const item = (title: string, link: string, desc: string) => ({ title, link, date: hoursAgo(3), desc });
const addSource = (name: string, path: string) => Number(db.prepare("INSERT INTO sources (name, site_url, feed_url, kind, created_at) VALUES (?,?,?,'rss',0)").run(name, `${fx.url}/${name}`, fx.url + path).lastInsertRowid);
const deps = (ai: Ai | null) => ({ db, ai, log: logger, fetchOpts: { allowPrivate: true } });
const ingest = async (name?: string) => { const ids: number[] = []; for (const s of db.prepare(`SELECT * FROM sources ${name ? "WHERE name = '" + name + "'" : ''} ORDER BY id`).all() as SourceRow[]) ids.push(...await ingestSource(deps(null), s)); return ids; };
const article = (id = 1) => db.prepare('SELECT * FROM articles WHERE id = ?').get(id) as any;
const cluster = (id = 1) => db.prepare('SELECT * FROM story_clusters WHERE id = ?').get(id) as any;

/** A model whose answers can be held back, and which labels each answer so the test can tell old from new. */
function gatedModel(gateWhen: (prompt: string) => boolean) {
  let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
  const st = { article: 0, cluster: 0, pair: 0 };
  const transport: AiTransport = { async generateJson({ prompt }) {
    if (prompt.includes('cover the same event')) { st.cluster++; if (gateWhen(prompt) && st.cluster === 1) await gate; return { text: JSON.stringify({ summary: `AI consolidated summary #${st.cluster}`, differences: null }), inputTokens: 1, outputTokens: 1 }; }
    const ids = [...prompt.matchAll(/<article id="(\d+)"/g)].map((m) => Number(m[1])); st.article++; const n = st.article;
    if (gateWhen(prompt) && n === 1) await gate;
    return { text: JSON.stringify({ items: ids.map((id) => ({ id, category: 'Business', importance: 0.9, summary: n === 1 ? 'AI summary of the OLD text.' : 'AI summary of the NEW text.' })) }), inputTokens: 1, outputTokens: 1 };
  } };
  return { ai: new Ai(db, 'm', transport, 100), st, release };
}

describe('a late Gemini answer never overwrites a newer version of the article', () => {
  it('REGRESSION: an answer about the OLD text is discarded when the publisher corrected the article meanwhile', async () => {
    db = memDb(); addSource('Alpha', '/sa-1'); fx.routes.set('/sa-1', { body: rss([item('Council approves strike contract', 'https://a.example/1', OLD)]) });
    await processNewArticles(deps(null), await ingest()); // ingested with local fallback summaries only
    const { ai, st, release } = gatedModel(() => true);
    const running = processNewArticles(deps(ai), []); // Gemini starts analysing the OLD version...
    await new Promise((r) => setTimeout(r, 30));
    fx.routes.set('/sa-1', { body: rss([item('Council REJECTS strike contract', 'https://a.example/1', NEW)]) });
    const changed = await ingest(); expect(changed).toEqual([1]); // ...the publisher corrects it (applied by the normal ingest step)
    const oldCategory = article().ai_category, oldImportance = article().importance;
    release(); await running; // the stale answer arrives

    const a = article();
    expect(a.title).toBe('Council REJECTS strike contract'); expect(a.excerpt).toBe(NEW);
    expect(a.summary).not.toMatch(/OLD text/); expect(a.summary).toContain('rejected the contract'); expect(a.summary_kind).toBe('excerpt'); // newer content and its local summary kept
    expect(a.ai_category).toBe(oldCategory); expect(a.importance).toBe(oldImportance); // the stale classification was not applied
    expect(a.ai_content_hash).not.toBe(a.content_hash); // the new version is NOT marked as analysed (before the fix it was)
    expect(cluster()).toMatchObject({ title: 'Council REJECTS strike contract' }); expect(cluster().summary).toContain('rejected the contract'); expect(cluster().summary_kind).toBe('excerpt');
    expect(st.article).toBe(1);

    await processNewArticles(deps(ai), []); // a later refresh analyses the NEW version, once
    expect(st.article).toBe(2); expect(article()).toMatchObject({ summary: 'AI summary of the NEW text.', summary_kind: 'ai' }); expect(article().ai_content_hash).toBe(article().content_hash);
    await processNewArticles(deps(ai), []); await processNewArticles(deps(ai), []);
    expect(st.article).toBe(2); // and then never again: no retry loop
  });

  it('control: an answer for unchanged content is applied normally', async () => {
    db = memDb(); addSource('Alpha', '/sa-2'); fx.routes.set('/sa-2', { body: rss([item('Council approves strike contract', 'https://a.example/1', OLD)]) });
    await processNewArticles(deps(null), await ingest());
    const { ai, st, release } = gatedModel(() => true); const running = processNewArticles(deps(ai), []); await new Promise((r) => setTimeout(r, 20)); release(); await running;
    expect(article()).toMatchObject({ summary: 'AI summary of the OLD text.', summary_kind: 'ai', ai_category: 'Business' }); expect(article().ai_content_hash).toBe(article().content_hash); expect(st.article).toBe(1);
  });

  it('even a cosmetic edit during the wait only re-queues the article for one follow-up analysis, never a retry loop', async () => {
    db = memDb(); addSource('Alpha', '/sa-3'); fx.routes.set('/sa-3', { body: rss([item('Council approves strike contract', 'https://a.example/1', OLD)]) });
    await processNewArticles(deps(null), await ingest());
    const { ai, st, release } = gatedModel(() => true); const running = processNewArticles(deps(ai), []); await new Promise((r) => setTimeout(r, 20));
    fx.routes.set('/sa-3', { body: rss([item('COUNCIL APPROVES STRIKE CONTRACT!', 'https://a.example/1', OLD.toUpperCase())]) }); await ingest();
    release(); await running;
    expect(article().title).toBe('COUNCIL APPROVES STRIKE CONTRACT!'); // the latest publisher text always wins
    expect(article().ai_content_hash).not.toBe(article().content_hash); // the answer was for a different hash, so it is not stamped on this one
    await processNewArticles(deps(ai), []); expect(st.article).toBeLessThanOrEqual(2); // at most one follow-up request, then settled
    await processNewArticles(deps(ai), []); expect(st.article).toBeLessThanOrEqual(2);
  });

  it('REGRESSION: a consolidated multi-source summary written from old text is discarded; it is regenerated once from the new text', async () => {
    db = memDb(); addSource('Alpha', '/sa-4a'); addSource('Beta', '/sa-4b');
    fx.routes.set('/sa-4a', { body: rss([item('Boeing strike ends after union approves new contract', 'https://a.example/1', OLD)]) });
    fx.routes.set('/sa-4b', { body: rss([item('Union approves new contract, ending Boeing strike', 'https://b.example/9', 'Striking Boeing workers ratified a new contract on Wednesday, ending the walkout that started weeks ago.')]) });
    await processNewArticles(deps(null), await ingest()); expect(cluster().article_count).toBe(2);
    const { ai, st, release } = gatedModel((p) => p.includes('cover the same event'));
    const running = processNewArticles(deps(ai), []); // article analysis runs freely, then the cluster summary request is held
    for (let i = 0; i < 100 && st.cluster === 0; i++) await new Promise((r) => setTimeout(r, 10));
    expect(st.cluster).toBe(1);
    fx.routes.set('/sa-4a', { body: rss([item('Boeing strike ends after union approves new contract', 'https://a.example/1', 'Correction: the union approved the contract by a narrow 51 percent margin on Thursday, not Wednesday as first reported.')]) });
    await ingest('Alpha'); release(); await running;
    expect(cluster().summary).not.toBe('AI consolidated summary #1'); // the old-content summary was discarded
    expect(cluster().summary_hash).toBeNull(); expect(cluster().differences).toBeNull(); // no consolidated summary is recorded for the old content
    await processNewArticles(deps(ai), []);
    expect(st.cluster).toBe(2); expect(cluster()).toMatchObject({ summary: 'AI consolidated summary #2', summary_kind: 'ai' }); // regenerated from the new content, once
    await processNewArticles(deps(ai), []); await processNewArticles(deps(ai), []); expect(st.cluster).toBe(2);
  });

  it('REGRESSION: a grouping decision about old headlines is not applied after one of the articles changed', async () => {
    db = memDb(); const s = addSource('ESPN', '/sa-5'); const A = 'Seahawks beat 49ers in overtime thriller at Lumen Field', B = 'Seahawks win overtime thriller over 49ers on Sunday';
    const mk = (title: string, ageH: number) => { const at = Date.now() - ageH * 3_600_000; const id = Number(db.prepare(`INSERT INTO articles (source_id,url,canonical_url,canonical_hash,publisher,title,title_norm,excerpt,published_at,fetched_at,content_hash,availability,summary,summary_kind) VALUES (?,?,?,?,?,?,?,?,?,?,?,'excerpt',?,?)`).run(s, 'u' + title.length, 'u' + title.length, 'h' + title.length, 'ESPN', title, title.toLowerCase(), 'Some excerpt text for the story.', at, at, 'c' + title.length, 'Some excerpt text for the story.', 'excerpt').lastInsertRowid); db.prepare('INSERT INTO article_sources VALUES (?,?,?)').run(id, s, at); return id; };
    const a = mk(A, 3), b = mk(B, 2); const co = (id: number) => (db.prepare('SELECT cluster_id c FROM articles WHERE id = ?').get(id) as any).c;
    const model = (change: boolean) => ({ canCall: () => true, enabled: true, verifyPairs: async (pairs: any[]) => { if (change) db.prepare("UPDATE articles SET title = 'Harbor repairs finish early', content_hash = 'changed' WHERE id = ?").run(b); return new Map(pairs.map((p: any) => [p.id, true])); } }) as unknown as Ai;
    await clusterArticles(db, model(true), [a, b]);
    expect(co(b)).not.toBe(co(a)); // B was corrected while the model decided, so the old "same event" verdict is dropped
    expect(db.pragma('foreign_key_check')).toEqual([]);
    // control: with unchanged articles the same verdict does merge them
    db.prepare('DELETE FROM story_clusters').run(); db.prepare("UPDATE articles SET title = ?, content_hash = 'c2' WHERE id = ?").run(B, b);
    await clusterArticles(db, model(false), [a, b]); expect(co(b)).toBe(co(a));
  });
});

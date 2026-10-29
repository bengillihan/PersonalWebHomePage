import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { memDb, fixtureServer, rss, hoursAgo, logger, type Fixture } from './helpers.js';
import { ingestSource, processNewArticles, materialKey, type SourceRow } from '../server/news/ingest.js';
import { queryFeed } from '../server/news/query.js';
import { Ai, type AiTransport } from '../server/ai/gemini.js';
import type { DB } from '../server/db.js';

let fx: Fixture;
beforeAll(async () => { fx = await fixtureServer(); });
afterAll(async () => { await fx.close(); });

const LONG_A = 'The mayor announced on Tuesday that she would step down at the end of the month, citing the ongoing scandal at city hall.';
const LONG_B = 'Correction: the mayor will step down in March, and the state attorney general has opened an investigation into city hall spending.';

/** Mock Gemini: counts calls per task and can be switched to failing. */
function mockAi(db: DB) {
  const st = { fail: false, article: 0, cluster: 0, articleIds: [] as number[][] };
  const transport: AiTransport = {
    async generateJson({ prompt }) {
      if (st.fail) throw new Error('503 service unavailable');
      if (prompt.includes('cover the same event')) { st.cluster++; return { text: JSON.stringify({ summary: 'AI consolidated summary', differences: null }), inputTokens: 1, outputTokens: 1 }; }
      const ids = [...prompt.matchAll(/<article id="(\d+)"/g)].map((m) => Number(m[1]));
      st.article++; st.articleIds.push(ids);
      return { text: JSON.stringify({ items: ids.map((id) => ({ id, category: 'Business', importance: 0.5, summary: `AI summary for article ${id}.` })) }), inputTokens: 1, outputTokens: 1 };
    },
  };
  return { ai: new Ai(db, 'm', transport, 1000), st };
}

async function refresh(db: DB, ai: Ai | null) {
  const deps = { db, ai, log: logger, fetchOpts: { allowPrivate: true } };
  const ids: number[] = [];
  for (const s of db.prepare('SELECT * FROM sources WHERE enabled = 1').all() as SourceRow[]) ids.push(...await ingestSource(deps, s));
  await processNewArticles(deps, ids);
}
function addSource(db: DB, name: string, path: string) {
  return Number(db.prepare("INSERT INTO sources (name, site_url, feed_url, kind, created_at) VALUES (?,?,?,'rss',?)").run(name, `${fx.url}/site-${name}`, fx.url + path, Date.now()).lastInsertRowid);
}
const set = (path: string, items: Parameters<typeof rss>[0]) => fx.routes.set(path, { body: rss(items) });
const cluster = (db: DB, id = 1) => db.prepare('SELECT * FROM story_clusters WHERE id = ?').get(id) as any;
const article = (db: DB, id = 1) => db.prepare('SELECT * FROM articles WHERE id = ?').get(id) as any;
const link = 'https://news.example/mayor';

describe('publisher corrections reach the dashboard', () => {
  it('REGRESSION (Gemini disabled): corrected headline and excerpt replace the stale cluster title/summary, keeping all user state', async () => {
    const db = memDb(); const src = addSource(db, 'one', '/c1');
    set('/c1', [{ title: 'Mayor Smith resigns after scandal', link, date: hoursAgo(3), desc: LONG_A }]);
    await refresh(db, null);
    expect(cluster(db)).toMatchObject({ title: 'Mayor Smith resigns after scandal', summary_kind: 'excerpt' });
    expect(cluster(db).summary).toContain('step down at the end of the month');

    db.prepare('INSERT INTO bookmarks VALUES (1, 111)').run();
    db.prepare("INSERT INTO feedback (cluster_id, rating, reason, category, created_at, updated_at) VALUES (1, 1, NULL, 'Business', 5, 6)").run();
    db.prepare('INSERT INTO feedback_sources VALUES (1, ?)').run(src);
    db.prepare('INSERT INTO reading_state (cluster_id, read_at) VALUES (1, ?)').run(Date.now());
    const before = cluster(db);
    await new Promise((r) => setTimeout(r, 5));

    set('/c1', [{ title: 'Mayor Smith to resign in March; state opens investigation', link, date: hoursAgo(3), desc: LONG_B }]);
    await refresh(db, null);

    const feed = queryFeed(db, { tab: 'latest' }).items;
    expect(feed).toHaveLength(1);
    expect(feed[0].title).toBe('Mayor Smith to resign in March; state opens investigation'); // what the dashboard shows
    expect(feed[0].summary).toContain('will step down in March'); expect(feed[0].summary).not.toContain('end of the month');
    expect(feed[0].summaryKind).toBe('excerpt'); expect(feed[0].articles[0].title).toBe(feed[0].title);
    expect(feed[0].isUpdated).toBe(true); expect(cluster(db).updated_at).toBeGreaterThan(before.updated_at);
    // user state and relationships untouched
    expect(feed[0]).toMatchObject({ id: 1, bookmarked: true, rating: 1, isRead: true });
    expect(db.prepare('SELECT cluster_id, article_id FROM cluster_articles').all()).toEqual([{ cluster_id: 1, article_id: 1 }]);
    expect(article(db)).toMatchObject({ id: 1, source_id: src, cluster_id: 1, url: link });
    expect(db.prepare('SELECT source_id FROM feedback_sources').all()).toEqual([{ source_id: src }]);
    expect((db.prepare('SELECT COUNT(*) n FROM story_clusters').get() as any).n).toBe(1);
  });

  it('a correction that removes the excerpt falls back to headline-only (no stale summary kept)', async () => {
    const db = memDb(); addSource(db, 'one', '/c2');
    set('/c2', [{ title: 'Mayor Smith resigns after scandal', link, date: hoursAgo(3), desc: LONG_A }]);
    await refresh(db, null);
    set('/c2', [{ title: 'Mayor Smith resigns after scandal', link, date: hoursAgo(3) }]);
    await refresh(db, null);
    expect(cluster(db)).toMatchObject({ summary: null, summary_kind: 'headline' });
    expect(article(db).availability).toBe('headline_only');
  });

  it('Gemini failing: the stale AI summary is replaced by the corrected excerpt, then AI is retried once it recovers', async () => {
    const db = memDb(); addSource(db, 'one', '/c3'); const { ai, st } = mockAi(db);
    set('/c3', [{ title: 'Mayor Smith resigns after scandal', link, date: hoursAgo(3), desc: LONG_A }]);
    await refresh(db, ai);
    expect(cluster(db)).toMatchObject({ summary: 'AI summary for article 1.', summary_kind: 'ai' });
    expect(st.article).toBe(1);

    st.fail = true;
    set('/c3', [{ title: 'Mayor Smith to resign in March', link, date: hoursAgo(3), desc: LONG_B }]);
    await expect(refresh(db, ai)).resolves.toBeUndefined(); // AI failure never breaks the refresh
    expect(cluster(db).title).toBe('Mayor Smith to resign in March');
    expect(cluster(db).summary).toContain('will step down in March'); // not the old AI text about the old story
    expect(cluster(db).summary_kind).toBe('excerpt');

    st.fail = false;
    await refresh(db, ai); // feed unchanged, but the article is still pending AI at its new content
    expect(st.article).toBe(2); // exactly one retry call after recovery (the failed attempt made no successful call)
    expect(cluster(db)).toMatchObject({ summary: 'AI summary for article 1.', summary_kind: 'ai', title: 'Mayor Smith to resign in March' });
    const calls = st.article;
    await refresh(db, ai); await refresh(db, ai);
    expect(st.article).toBe(calls); // settled: no further Gemini calls
  });

  it('cosmetic edits (case, punctuation, whitespace) update the text but keep the AI summary and make no Gemini call', async () => {
    const db = memDb(); addSource(db, 'one', '/c4'); const { ai, st } = mockAi(db);
    set('/c4', [{ title: 'Mayor Smith resigns after scandal', link, date: hoursAgo(3), desc: LONG_A }]);
    await refresh(db, ai);
    expect(st.article).toBe(1);

    set('/c4', [{ title: 'MAYOR SMITH RESIGNS AFTER SCANDAL!', link, date: hoursAgo(3), desc: LONG_A.toUpperCase() + '  ' }]);
    await refresh(db, ai);
    expect(st.article).toBe(1); // no new AI call
    expect(article(db).title).toBe('MAYOR SMITH RESIGNS AFTER SCANDAL!'); // publisher's current text is stored
    expect(article(db).summary_kind).toBe('ai'); expect(article(db).summary).toBe('AI summary for article 1.');
    expect(article(db).ai_content_hash).toBe(article(db).content_hash); // not pending AI
    expect(cluster(db).title).toBe('MAYOR SMITH RESIGNS AFTER SCANDAL!');

    // and an unchanged refetch writes nothing to articles/clusters
    const snap = () => JSON.stringify([db.prepare('SELECT * FROM articles').all(), db.prepare('SELECT * FROM story_clusters').all()]);
    const before = snap();
    await refresh(db, ai);
    expect(snap()).toBe(before); expect(st.article).toBe(1);
  });

  it('only the corrected article is sent to Gemini', async () => {
    const db = memDb(); addSource(db, 'one', '/c5'); const { ai, st } = mockAi(db);
    const base = [{ title: 'Alpha company reports record profit', link: 'https://n.example/a', date: hoursAgo(2), desc: LONG_A }, { title: 'Zebra population grows in the savanna', link: 'https://n.example/z', date: hoursAgo(2), desc: LONG_B }];
    set('/c5', base); await refresh(db, ai);
    expect(st.articleIds).toEqual([[1, 2]]);
    set('/c5', [{ ...base[0], title: 'Alpha company reports record loss' }, base[1]]);
    await refresh(db, ai);
    expect(st.articleIds).toEqual([[1, 2], [1]]);
  });

  it('multi-source cluster: a corrected article drops the stale consolidated summary, and it is regenerated once when AI is back', async () => {
    const db = memDb(); addSource(db, 'a', '/m-a'); addSource(db, 'b', '/m-b'); const { ai, st } = mockAi(db);
    const a = { title: 'Boeing strike ends after union approves new contract', link: 'https://a.example/1', date: hoursAgo(5), desc: 'Boeing machinists voted to approve a new four-year contract, ending a strike that lasted several weeks.' };
    const b = { title: 'Union approves new contract, ending Boeing strike', link: 'https://b.example/9', date: hoursAgo(4), desc: 'Striking Boeing workers ratified a new contract on Wednesday, ending the walkout that started weeks ago.' };
    set('/m-a', [a]); set('/m-b', [b]);
    await refresh(db, ai);
    expect(cluster(db)).toMatchObject({ article_count: 2, source_count: 2, summary: 'AI consolidated summary', summary_kind: 'ai' });
    expect(st.cluster).toBe(1);

    st.fail = true;
    set('/m-b', [{ ...b, desc: 'Correction: workers ratified the contract by a 51 percent margin on Thursday, a narrower vote than first reported.' }]);
    await refresh(db, ai);
    expect(cluster(db).summary).not.toBe('AI consolidated summary'); // built from the old text
    expect(cluster(db).summary_hash).toBeNull(); expect(cluster(db).differences).toBeNull();
    expect(cluster(db).article_count).toBe(2); // membership kept

    st.fail = false;
    await refresh(db, ai);
    expect(cluster(db).summary).toBe('AI consolidated summary'); expect(st.cluster).toBe(2);
    await refresh(db, ai); expect(st.cluster).toBe(2); // not regenerated again
  });

  it('is atomic: if updating the cluster fails, the article edit is rolled back too, and applies on the next refresh', async () => {
    const db = memDb(); addSource(db, 'one', '/c6');
    set('/c6', [{ title: 'Mayor Smith resigns after scandal', link, date: hoursAgo(3), desc: LONG_A }]);
    await refresh(db, null);
    db.exec(`CREATE TRIGGER boom BEFORE UPDATE ON story_clusters BEGIN SELECT RAISE(ABORT, 'boom'); END;`);
    set('/c6', [{ title: 'Mayor Smith to resign in March', link, date: hoursAgo(3), desc: LONG_B }]);
    const hashBefore = article(db).content_hash;
    await refresh(db, null);
    expect(article(db).title).toBe('Mayor Smith resigns after scandal'); // not half-applied
    expect(article(db).content_hash).toBe(hashBefore);
    expect(article(db).excerpt).toBe(LONG_A); // excerpt and hash also unchanged
    expect((db.prepare('SELECT health FROM sources').get() as any).health).toBe('error');
    db.exec('DROP TRIGGER boom');
    await refresh(db, null);
    expect(article(db).title).toBe('Mayor Smith to resign in March'); expect(cluster(db).title).toBe('Mayor Smith to resign in March');
  });
});

describe('materialKey', () => {
  it('ignores case, punctuation, whitespace, accents and feed boilerplate, but not changed words or figures', () => {
    const k = (t: string, e: string | null = null) => materialKey(t, e);
    expect(k('Café Opens!')).toBe(k('cafe  opens'));
    expect(k('Hi', 'Body text. The post Hi appeared first on Site.')).toBe(k('Hi', 'body text'));
    expect(k('Recall of 20,000 cars')).not.toBe(k('Recall of 2,000 cars'));
    expect(k('Mayor Smith')).not.toBe(k('Mayor Smyth'));
  });
});

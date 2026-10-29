import { describe, it, expect } from 'vitest';
import { memDb, testConfig } from './helpers.js';
import { queryFeed } from '../server/news/query.js';
import { recomputeCluster } from '../server/news/cluster.js';
import { buildApp } from '../server/app.js';
import type { OidcClient } from '../server/auth.js';
import type { DB } from '../server/db.js';

let db: DB; let n = 0;

const src = (name: string) => Number(db.prepare('INSERT INTO sources (name, site_url, created_at) VALUES (?,?,0)').run(name, `https://${name.replace(/\W/g, '')}${++n}.example`).lastInsertRowid);
/** One cluster per call (or an extra article in `cluster`). Importance orders the For You ranking. */
function story(source: number, title: string, o: { importance?: number; cluster?: number; summary?: string; ageMin?: number } = {}) {
  n++;
  const at = Date.now() - (o.ageMin ?? 60) * 60_000;
  const pub = (db.prepare('SELECT name FROM sources WHERE id = ?').get(source) as any).name;
  const a = Number(db.prepare(`INSERT INTO articles (source_id,url,canonical_url,canonical_hash,publisher,title,title_norm,excerpt,published_at,fetched_at,content_hash,availability,summary,summary_kind,importance)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,'excerpt',?,?,?)`).run(source, `https://x.example/${n}`, `https://x.example/${n}`, `h${n}`, pub, title, title.toLowerCase(), title, at, at, `c${n}`, o.summary ?? `Summary of ${title}`, 'excerpt', o.importance ?? 0.3).lastInsertRowid);
  const c = o.cluster ?? Number(db.prepare('INSERT INTO story_clusters (primary_article_id,title,first_published_at,last_published_at,updated_at,created_at) VALUES (?,?,?,?,?,?)').run(a, title, at, at, at, at).lastInsertRowid);
  db.prepare('UPDATE articles SET cluster_id = ? WHERE id = ?').run(c, a);
  db.prepare('INSERT INTO cluster_articles VALUES (?,?,0,?)').run(c, a, at);
  db.prepare('INSERT INTO article_sources VALUES (?,?,?)').run(a, source, at);
  recomputeCluster(db, c);
  return { cluster: c, article: a };
}
const markRead = (c: number) => db.prepare('INSERT INTO reading_state (cluster_id, read_at) VALUES (?,?) ON CONFLICT(cluster_id) DO UPDATE SET read_at = excluded.read_at').run(c, Date.now());

describe('#1 For You / Explore pagination uses a stable snapshot', () => {
  /** Six stories ranked s0..s5 (highest importance first). */
  const ranked = (k = 6) => { db = memDb(); const g = src('General'); return Array.from({ length: k }, (_, i) => story(g, `Ranked story ${i}`, { importance: 0.99 - i * 0.03 }).cluster); };
  const page = (tab: string, cursor?: string, limit = 2) => queryFeed(db, { tab, limit, cursor });
  const idsOf = (p: ReturnType<typeof page>) => p.items.map((i) => i.id);

  it('REGRESSION: reading a story between pages no longer makes the next page skip an unseen story', () => {
    const s = ranked();
    const p1 = page('foryou'); expect(idsOf(p1)).toEqual([s[0], s[1]]);
    markRead(s[0]); // the user reads the first story; the visible list shrinks
    const p2 = page('foryou', p1.nextCursor!); expect(idsOf(p2)).toEqual([s[2], s[3]]); // before the fix: [s3, s4], skipping s2
    markRead(s[2]);
    const p3 = page('foryou', p2.nextCursor!); expect(idsOf(p3)).toEqual([s[4], s[5]]);
    expect(p3.nextCursor).toBeNull();
    expect([...idsOf(p1), ...idsOf(p2), ...idsOf(p3)]).toEqual(s); // every story served exactly once, in ranked order
  });

  it('a story that stops qualifying before its turn (read/hidden elsewhere) is dropped without shifting the rest', () => {
    const s = ranked();
    const p1 = page('foryou');
    markRead(s[2]); db.prepare('INSERT INTO reading_state (cluster_id, hidden_at) VALUES (?,?)').run(s[3], Date.now());
    const p2 = page('foryou', p1.nextCursor!); expect(idsOf(p2)).toEqual([s[4], s[5]]); // s2 and s3 never shown, nothing else skipped
  });

  it('a new top story arriving mid-scroll neither duplicates nor reshuffles the remaining pages; totals stay constant', () => {
    const s = ranked();
    const p1 = page('foryou'); expect(p1.total).toBe(6);
    const g = (db.prepare('SELECT id FROM sources LIMIT 1').get() as any).id;
    const fresh = story(g, 'Breaking: brand new top story', { importance: 1 }).cluster;
    const p2 = page('foryou', p1.nextCursor!); expect(idsOf(p2)).toEqual([s[2], s[3]]); expect(p2.total).toBe(6);
    expect(idsOf(page('foryou'))).toContain(fresh); // a fresh first page does include it
  });

  it('Explore paginates from a snapshot too', () => {
    const s = ranked(5);
    const p1 = page('explore'); const seen = [...idsOf(p1)]; markRead(seen[0]);
    let cursor = p1.nextCursor; while (cursor) { const p = page('explore', cursor); seen.push(...idsOf(p)); cursor = p.nextCursor; }
    expect(seen.sort((a, b) => a - b)).toEqual([...s].sort((a, b) => a - b)); // all five exactly once
  });

  it('bad cursors are harmless: junk and old offset-style cursors restart from the first page; bad ids are ignored', () => {
    const s = ranked();
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    expect(idsOf(page('foryou', 'not-a-cursor'))).toEqual([s[0], s[1]]);
    expect(idsOf(page('foryou', enc({ o: 4 })))).toEqual([s[0], s[1]]); // legacy {o} cursor
    expect(idsOf(page('foryou', enc({ r: [s[3], 'x', -1, 1.5, null, s[4]], t: 9 })))).toEqual([s[3], s[4]]);
    expect(idsOf(page('foryou', enc({ r: Array.from({ length: 5000 }, (_, i) => i + 100_000) })))).toEqual([]); // capped, unknown ids dropped
  });

  describe('via the API', () => {
    const oidc: OidcClient & { nonce?: string } = { authUrl: ({ state, nonce }) => `https://x/?state=${state}&nonce=${nonce}`, async exchange() { return { sub: 's', email: 'me@example.com', emailVerified: true, name: 'Me', nonce: oidc.nonce ?? null }; } };
    it('a ranked cursor for a long list is accepted (it used to exceed the 200-character limit), and absurd ones are rejected', async () => {
      db = memDb(); const g = src('General'); for (let i = 0; i < 60; i++) story(g, `Story ${i}`, { importance: 0.99 - i * 0.004 });
      const { app } = await buildApp(testConfig(), db, { oidc, logger: false, transport: null });
      const r1 = await app.inject({ url: '/auth/login' }); const loc = new URL(r1.headers.location as string); oidc.nonce = loc.searchParams.get('nonce')!;
      const r2 = await app.inject({ url: `/auth/callback?code=c&state=${loc.searchParams.get('state')}`, cookies: { oauth_tx: r1.cookies[0].value } });
      const cookie = r2.cookies.find((c) => c.name === 'sid')!.value;
      const get = (u: string) => app.inject({ url: u, cookies: { sid: cookie } });
      const first = (await get('/api/feed?tab=foryou&limit=5')).json();
      expect(first.nextCursor.length).toBeGreaterThan(200); expect(first.total).toBe(60);
      const second = await get(`/api/feed?tab=foryou&limit=5&cursor=${first.nextCursor}`);
      expect(second.statusCode).toBe(200); expect(second.json().items.map((i: any) => i.id)).not.toEqual(first.items.map((i: any) => i.id));
      expect((await get(`/api/feed?tab=foryou&cursor=${'a'.repeat(12_001)}`)).statusCode).toBe(400);
      await app.close();
    });
  });
});


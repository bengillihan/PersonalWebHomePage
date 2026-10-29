import { describe, it, expect } from 'vitest';
import { memDb, testConfig } from './helpers.js';
import { queryFeed } from '../server/news/query.js';
import { recomputeCluster, clusterContentHash } from '../server/news/cluster.js';
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
const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;

describe('#3 deleting a source recomputes the stories that lose an article', () => {
  const oidc: OidcClient & { nonce?: string } = { authUrl: ({ state, nonce }) => `https://x/?state=${state}&nonce=${nonce}`, async exchange() { return { sub: 's', email: 'me@example.com', emailVerified: true, name: 'Me', nonce: oidc.nonce ?? null }; } };
  async function appWithSession() {
    const { app } = await buildApp(testConfig(), db, { oidc, logger: false, transport: null });
    const r1 = await app.inject({ url: '/auth/login' }); const loc = new URL(r1.headers.location as string); oidc.nonce = loc.searchParams.get('nonce')!;
    const r2 = await app.inject({ url: `/auth/callback?code=c&state=${loc.searchParams.get('state')}`, cookies: { oauth_tx: r1.cookies[0].value } });
    const cookie = r2.cookies.find((c) => c.name === 'sid')!.value; const csrf = (await app.inject({ url: '/api/me', cookies: { sid: cookie } })).json().csrfToken;
    return { app, del: (id: number) => app.inject({ method: 'DELETE', url: `/api/sources/${id}`, cookies: { sid: cookie }, headers: { 'x-csrf-token': csrf } }) };
  }
  const cluster = (id: number) => db.prepare('SELECT * FROM story_clusters WHERE id = ?').get(id) as any;

  it('REGRESSION: a two-source story whose first source is deleted no longer claims two sources, or keeps the deleted source\'s title and AI summary', async () => {
    db = memDb(); const a = src('Alpha'), b = src('Beta');
    const first = story(a, 'Alpha headline about the contract', { summary: 'Alpha excerpt summary text.', ageMin: 120 }); // earliest, so it is the primary
    const second = story(b, 'Beta headline on the contract deal', { cluster: first.cluster, summary: 'Beta excerpt summary text.', ageMin: 30 });
    const hash = clusterContentHash((db.prepare('SELECT content_hash h FROM articles WHERE cluster_id = ?').all(first.cluster) as any[]).map((r) => r.h));
    db.prepare("UPDATE story_clusters SET summary = 'AI consolidated summary mentioning Alpha', summary_kind = 'ai', differences = 'Alpha adds detail', summary_hash = ? WHERE id = ?").run(hash, first.cluster);
    db.prepare('INSERT INTO bookmarks VALUES (?,5)').run(first.cluster);
    db.prepare("INSERT INTO feedback (cluster_id, rating, reason, category, created_at, updated_at) VALUES (?,1,NULL,NULL,1,1)").run(first.cluster);
    db.prepare('INSERT INTO reading_state (cluster_id, read_at) VALUES (?,9)').run(first.cluster);
    expect(cluster(first.cluster)).toMatchObject({ article_count: 2, source_count: 2, primary_article_id: first.article });

    const { app, del } = await appWithSession();
    expect((await del(a)).statusCode).toBe(200); await app.close();

    expect(cluster(first.cluster)).toMatchObject({ article_count: 1, source_count: 1, primary_article_id: second.article, title: 'Beta headline on the contract deal', summary: 'Beta excerpt summary text.', summary_kind: 'excerpt', differences: null });
    expect(cluster(first.cluster).summary).not.toMatch(/Alpha/); // nothing left from the deleted source
    expect(db.prepare('SELECT cluster_id FROM bookmarks').all()).toEqual([{ cluster_id: first.cluster }]); // user state kept
    expect(db.prepare('SELECT rating FROM feedback').all()).toEqual([{ rating: 1 }]); expect(db.prepare('SELECT read_at FROM reading_state').all()).toEqual([{ read_at: 9 }]);
    const [item] = queryFeed(db, { tab: 'saved' }).items; expect(item).toMatchObject({ sourceCount: 1, title: 'Beta headline on the contract deal' }); expect(item.articles.map((x) => x.publisher)).toEqual(['Beta']);
  });

  it('stories only that source supplied disappear; unrelated and shared stories stay consistent', async () => {
    db = memDb(); const a = src('Alpha'), b = src('Beta'), c = src('Gamma');
    const onlyA = story(a, 'Only Alpha story'), onlyC = story(c, 'Only Gamma story');
    const shared = story(a, 'Shared story carried by two feeds'); db.prepare('INSERT INTO article_sources VALUES (?,?,0)').run(shared.article, b); // Beta also carries Alpha's article
    const three = story(a, 'Three way story', { ageMin: 90 }); story(b, 'Three way story second', { cluster: three.cluster, ageMin: 60 }); story(c, 'Three way story third', { cluster: three.cluster, ageMin: 30 });
    expect(cluster(three.cluster).source_count).toBe(3);
    const { app, del } = await appWithSession(); expect((await del(a)).statusCode).toBe(200); await app.close();
    expect(db.prepare('SELECT id FROM story_clusters WHERE id = ?').get(onlyA.cluster)).toBeUndefined();
    expect(cluster(onlyC.cluster)).toMatchObject({ article_count: 1, source_count: 1 });
    expect(cluster(shared.cluster)).toMatchObject({ article_count: 1, source_count: 1 }); // re-homed to Beta, still one story
    expect(cluster(three.cluster)).toMatchObject({ article_count: 2, source_count: 2 });
    expect(count('SELECT COUNT(*) n FROM story_clusters WHERE article_count != (SELECT COUNT(*) FROM articles WHERE cluster_id = story_clusters.id)')).toBe(0); // no cluster miscounts left behind
  });
});


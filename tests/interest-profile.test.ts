import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { memDb, testConfig } from './helpers.js';
import { recomputeCluster } from '../server/news/cluster.js';
import { queryFeed } from '../server/news/query.js';
import { indexArticleTopics, loadTopics, weightFactor } from '../server/news/topics.js';
import { indexArticleBlocks } from '../server/news/blocking.js';
import { SEED_INTERESTS, seedDefaults } from '../server/seed.js';
import { getPrefs, savePrefs } from '../server/settings.js';
import { setSetting } from '../server/db.js';
import { buildApp } from '../server/app.js';
import type { OidcClient } from '../server/auth.js';
import type { DB } from '../server/db.js';

let db: DB; let n = 0; let gemini = 0;
const src = (name: string) => Number(db.prepare('INSERT INTO sources (name, site_url, coverage, created_at) VALUES (?,?,?,0)').run(name, `https://${name.replace(/\W/g, '')}${++n}.example`, 'comprehensive').lastInsertRowid);
function story(source: number, title: string, o: { importance?: number; ageMin?: number } = {}) {
  n++; const at = Date.now() - (o.ageMin ?? 60) * 60_000; const pub = (db.prepare('SELECT name FROM sources WHERE id = ?').get(source) as any).name;
  const a = Number(db.prepare(`INSERT INTO articles (source_id,url,canonical_url,canonical_hash,publisher,title,title_norm,excerpt,published_at,fetched_at,content_hash,availability,summary,summary_kind,importance)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,'excerpt',?,'excerpt',?)`).run(source, `https://x.example/${n}`, `https://x.example/${n}`, `h${n}`, pub, title, title.toLowerCase(), `${title}. Detail.`, at, at, `c${n}`, `${title}. Detail.`, o.importance ?? 0.3).lastInsertRowid);
  const c = Number(db.prepare('INSERT INTO story_clusters (primary_article_id,title,first_published_at,last_published_at,updated_at,created_at) VALUES (?,?,?,?,?,?)').run(a, title, at, at, at, at).lastInsertRowid);
  db.prepare('UPDATE articles SET cluster_id = ? WHERE id = ?').run(c, a); db.prepare('INSERT INTO cluster_articles VALUES (?,?,0,?)').run(c, a, at); db.prepare('INSERT INTO article_sources VALUES (?,?,?)').run(a, source, at);
  indexArticleTopics(db, [a]); indexArticleBlocks(db, [a]); recomputeCluster(db, c); return c; // indexed the way ingestion does
}
const topicByName = (name: string) => loadTopics(db).find((t) => t.name === name)!;
const order = (tab = 'foryou') => queryFeed(db, { tab, limit: 50 }).items.map((i) => i.id);
const why = (id: number) => queryFeed(db, { tab: 'foryou', limit: 50 }).items.find((i) => i.id === id)?.why?.reasons.join(' | ') ?? '';
beforeEach(() => { db = memDb(); gemini = 0; });

describe('seeding the interest profile', () => {
  it('seeds every interest once, idempotently, with the requested weights, and never touches the hard block', () => {
    seedDefaults(db); seedDefaults(db); seedDefaults(db);
    const topics = loadTopics(db); expect(topics).toHaveLength(SEED_INTERESTS.length);
    const w = (name: string) => topicByName(name).weight;
    expect([w('AI and technology'), w('Investing and economics'), w('Local and Washington state')]).toEqual([5, 5, 5]);
    expect([w('Business, energy and industry'), w('Major national and international news'), w('Automobiles')]).toEqual([4, 4, 4]);
    expect([w('Travel and hiking'), w('Health and fitness'), w('Technology careers and education')]).toEqual([3, 3, 3]);
    expect(w('Biblical studies and church leadership')).toBe(2);
    expect(topics.filter((t) => t.stance === 'less').map((t) => t.name).sort()).toEqual(SEED_INTERESTS.filter((t) => t.stance === 'less').map((t) => t.name).sort());
    expect(db.prepare("SELECT name, enabled FROM blocked_topics").all()).toEqual([{ name: 'Hockey / NHL', enabled: 1 }]); // Hockey stays hard-blocked, nothing else is
  });

  it('REGRESSION: does not overwrite an interest the user already has, keeps their own topics and blocks, and does not resurrect deleted ones', () => {
    db.prepare("INSERT INTO topics (name, kind, description, priority, weight, include_keywords, exclude_keywords, created_at) VALUES ('Automobiles','interest','my cars',0,1,'[\"miata\"]','[]',0)").run();
    db.prepare("INSERT INTO topics (name, kind, description, priority, include_keywords, exclude_keywords, created_at) VALUES ('Knitting','interest','',1,'[\"yarn\"]','[]',0)").run();
    db.prepare("INSERT INTO blocked_topics (name, description, keywords, categories, enabled, created_at) VALUES ('Cricket','','[\"cricket\"]','[]',1,0)").run();
    seedDefaults(db);
    expect(topicByName('Automobiles')).toMatchObject({ weight: 1, description: 'my cars', include: ['miata'] }); expect(topicByName('Knitting').include).toEqual(['yarn']);
    expect(db.prepare('SELECT name FROM blocked_topics ORDER BY name').all()).toEqual([{ name: 'Cricket' }, { name: 'Hockey / NHL' }]);
    db.prepare("DELETE FROM topics WHERE name = 'Travel and hiking'").run(); seedDefaults(db);
    expect(loadTopics(db).some((t) => t.name === 'Travel and hiking')).toBe(false);
  });

  it('applies to articles already stored, locally (no AI call) and without clobbering edited weights on later startups', () => {
    const s = src('Wire'); const c = story(s, 'NVIDIA unveils new AI hardware for local inference'); seedDefaults(db);
    expect(db.prepare('SELECT COUNT(*) n FROM article_topics').get()).toMatchObject({ n: expect.any(Number) });
    expect(queryFeed(db, { tab: 'foryou' }).items.find((i) => i.id === c)?.why?.reasons.join(' ')).toMatch(/Matches your interest “AI and technology” \(weight 5 of 5\)/);
    db.prepare("UPDATE topics SET weight = 2, priority = 0 WHERE name = 'AI and technology'").run(); seedDefaults(db);
    expect(topicByName('AI and technology').weight).toBe(2);
  });
});

describe('weights drive ranking', () => {
  it('maps 1-5 onto increasing multipliers, and legacy priorities keep their exact old multipliers', () => {
    expect([1, 2, 3, 4, 5].map(weightFactor)).toEqual([0.4, 0.6, 1, 1.2, 1.4]);
    db.prepare("INSERT INTO topics (name, kind, description, priority, include_keywords, exclude_keywords, created_at) VALUES ('Old low','interest','',0,'[]','[]',0), ('Old normal','interest','',1,'[]','[]',0), ('Old high','interest','',2,'[]','[]',0)").run();
    expect(['Old low', 'Old normal', 'Old high'].map((x) => weightFactor(topicByName(x).weight))).toEqual([0.6, 1, 1.4]); // unchanged for existing data
  });

  it('a weight-5 interest outranks a weight-2 interest on otherwise identical stories, and editing the weight re-ranks instantly', () => {
    seedDefaults(db); const s = src('Wire');
    const low = story(s, 'Pastor reflects on church leadership and theology'), high = story(s, 'Washington state lawmakers debate a new Seattle budget');
    expect(order()[0]).toBe(high); expect(why(high)).toMatch(/weight 5 of 5/); expect(why(low)).toMatch(/weight 2 of 5/);
    db.prepare("UPDATE topics SET weight = 5, priority = 2 WHERE name = 'Biblical studies and church leadership'").run(); db.prepare("UPDATE topics SET weight = 1, priority = 0 WHERE name = 'Local and Washington state'").run();
    expect(order()[0]).toBe(low); // no re-ingestion, no AI
  });
});

describe('low-priority topics, hard blocks and mutes', () => {
  it('REGRESSION: a low-priority match is shown less often but still shown, with the reason; major news is never pushed down', () => {
    seedDefaults(db); const s = src('Wire');
    const plain = story(s, 'City opens a new library branch'), gossip = story(s, 'Celebrity gossip roundup from the red carpet'), majorGossip = story(s, 'Celebrity gossip as ceasefire talks collapse', { importance: 0.95 });
    const o = order('latest'); expect(o).toContain(gossip); // not hidden
    const items = queryFeed(db, { tab: 'foryou', limit: 50 }).items; const idx = (id: number) => items.findIndex((i) => i.id === id);
    expect(idx(plain)).toBeLessThan(idx(gossip)); expect(why(gossip)).toMatch(/Shown less: matches your low-priority topic “Low priority: celebrity gossip”/);
    expect(why(majorGossip)).not.toMatch(/Shown less/); expect(idx(majorGossip)).toBeGreaterThanOrEqual(0);
    expect(db.prepare('SELECT COUNT(*) n FROM blocked_topics WHERE enabled = 1').get()).toEqual({ n: 1 }); // low priority never became a hard block
  });

  it('REGRESSION: hard blocks and publisher mutes apply before personalized ranking, even for a story that matches a top interest', () => {
    seedDefaults(db); const s = src('Wire'); const loud = src('Loud Blog');
    const hockey = story(s, 'Seattle Kraken win again as Seattle celebrates NHL playoff run'), muted = story(loud, 'Washington state NVIDIA data center plan for Seattle'), ok = story(s, 'Washington state NVIDIA data center plan');
    savePrefs(db, { ...getPrefs(db), mutedPublishers: ['Loud Blog'] });
    for (const tab of ['foryou', 'latest']) { const ids = order(tab); expect(ids, tab).toContain(ok); expect(ids, tab).not.toContain(hockey); expect(ids, tab).not.toContain(muted); }
    expect(queryFeed(db, { tab: 'latest', q: 'kraken' }).items.map((i) => i.id)).toEqual([hockey]); // still reachable by explicit search
  });

  it('thumbs-up and thumbs-down still move rankings on top of interest weights', () => {
    seedDefaults(db); const s = src('Wire'); const a = story(s, 'Seattle council debates a transit plan'), b = story(s, 'Tacoma council debates a transit plan');
    const first = order()[0]; const other = first === a ? b : a;
    db.prepare('INSERT INTO feedback (cluster_id, rating, created_at, updated_at) VALUES (?,1,0,0)').run(other);
    expect(order()[0]).toBe(other); expect(why(other)).toMatch(/thumbs-up/);
    db.prepare('UPDATE feedback SET rating = -1 WHERE cluster_id = ?').run(other); expect(order()[0]).toBe(first);
  });
});

describe('editing through the API', () => {
  const oidc: OidcClient & { nonce?: string } = { authUrl: ({ state, nonce }) => `https://x/?state=${state}&nonce=${nonce}`, async exchange() { return { sub: 's', email: 'me@example.com', emailVerified: true, name: 'Me', nonce: oidc.nonce ?? null }; } };
  let app: FastifyInstance; let cookie = ''; let csrf = '';
  beforeEach(async () => {
    setSetting(db, 'last_news_refresh_at', Date.now());
    ({ app } = await buildApp(testConfig(), db, { oidc, logger: false, transport: { async generateJson() { gemini++; throw new Error('Gemini must not be called'); } } }));
    const r1 = await app.inject({ url: '/auth/login' }); const loc = new URL(r1.headers.location as string); oidc.nonce = loc.searchParams.get('nonce')!;
    const r2 = await app.inject({ url: `/auth/callback?code=c&state=${loc.searchParams.get('state')}`, cookies: { oauth_tx: r1.cookies[0].value } });
    cookie = r2.cookies.find((c) => c.name === 'sid')!.value; csrf = (await app.inject({ url: '/api/me', cookies: { sid: cookie } })).json().csrfToken;
  });
  afterEach(async () => { await app.close(); });
  const call = (method: any, url: string, payload?: unknown) => app.inject({ method, url, cookies: { sid: cookie }, headers: { 'x-csrf-token': csrf }, payload: payload as any });

  it('weight and stance are editable, persist, and re-rank locally; older clients sending only a priority still work', async () => {
    seedDefaults(db); const s = src('Wire'); const hiking = story(s, 'New hiking trailhead opens near Mount Rainier'), ai = story(s, 'NVIDIA ships new AI hardware');
    const list = (await call('GET', '/api/topics')).json() as any[]; const t = (name: string) => list.find((x) => x.name === name);
    expect(t('Travel and hiking')).toMatchObject({ weight: 3, stance: 'prefer' });
    expect(order()[0]).toBe(ai);
    const h = t('Travel and hiking'); const aiT = t('AI and technology');
    expect((await call('PUT', `/api/topics/${h.id}`, { ...h, weight: 5 })).statusCode).toBe(200);
    expect((await call('PUT', `/api/topics/${aiT.id}`, { ...aiT, weight: 1 })).statusCode).toBe(200);
    expect(order()[0]).toBe(hiking); expect(topicByName('Travel and hiking')).toMatchObject({ weight: 5, priority: 2 });
    const celeb = t('Low priority: celebrity gossip'); expect((await call('PUT', `/api/topics/${celeb.id}`, { ...celeb, stance: 'prefer' })).statusCode).toBe(200); expect(topicByName('Low priority: celebrity gossip').stance).toBe('prefer');
    const legacy = await call('PUT', `/api/topics/${h.id}`, { name: h.name, kind: 'interest', description: '', priority: 'low', include: h.include, exclude: [] }); expect(legacy.statusCode).toBe(200);
    expect(topicByName('Travel and hiking').weight).toBe(2);
    const created = (await call('POST', '/api/topics', { name: 'Sailing', kind: 'interest', description: 'sailing', weight: 4, include: ['sailing'], exclude: [] })).json();
    expect(loadTopics(db).find((x) => x.id === created.id)).toMatchObject({ weight: 4, stance: 'prefer' }); expect(gemini).toBe(0);
    expect((await call('POST', '/api/topics', { name: 'Bad', weight: 9 })).statusCode).toBeGreaterThanOrEqual(400);
  });
});

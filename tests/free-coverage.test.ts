import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { memDb, testConfig } from './helpers.js';
import { recomputeCluster } from '../server/news/cluster.js';
import { queryFeed, queryFrontPage } from '../server/news/query.js';
import { accessInfo, accessTier } from '../server/news/access.js';
import { parseFeed } from '../server/news/feed.js';
import { getPrefs, savePrefs } from '../server/settings.js';
import { setSetting } from '../server/db.js';
import { buildApp } from '../server/app.js';
import type { OidcClient } from '../server/auth.js';
import type { DB } from '../server/db.js';

let db: DB; let n = 0; const T = 'Seattle council approves housing plan downtown';
const src = (name: string, access = 'unknown', priority = 1) => Number(db.prepare('INSERT INTO sources (name, site_url, access, priority, created_at) VALUES (?,?,?,?,0)').run(name, `https://${name.replace(/\W/g, '')}${++n}.example`, access, priority).lastInsertRowid);
interface A { source: number; title?: string; excerpt?: string | null; image?: string | null; access?: string | null; ageMin?: number }
/** One story made of several articles. `primary` is the index the stored story points at (its usual choice). */
function story(arts: A[], o: { primary?: number; kind?: 'ai' | 'excerpt'; summary?: string } = {}) {
  const ids: number[] = []; let cl = 0;
  arts.forEach((a, i) => {
    n++; const at = Date.now() - (a.ageMin ?? 60 - i) * 60_000; const pub = (db.prepare('SELECT name FROM sources WHERE id = ?').get(a.source) as any).name; const ex = a.excerpt === undefined ? `${pub} reports the council vote in detail on Monday evening.` : a.excerpt;
    const id = Number(db.prepare(`INSERT INTO articles (source_id,url,canonical_url,canonical_hash,publisher,title,title_norm,excerpt,image_url,access,published_at,fetched_at,content_hash,availability,summary,summary_kind,importance)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0.5)`).run(a.source, `https://${pub.replace(/\W/g, '')}.example/${n}`, `https://${pub.replace(/\W/g, '')}.example/${n}`, `h${n}`, pub, a.title ?? `${T} (${pub})`, (a.title ?? T).toLowerCase(), ex, a.image === undefined ? `https://img.example/${pub.replace(/\W/g, '')}.jpg` : a.image, a.access ?? null, at, at, `c${n}`, ex ? 'excerpt' : 'headline_only', ex, ex ? 'excerpt' : 'headline').lastInsertRowid);
    if (!cl) cl = Number(db.prepare('INSERT INTO story_clusters (primary_article_id,title,first_published_at,last_published_at,updated_at,created_at) VALUES (?,?,?,?,?,?)').run(id, T, at, at, at, at).lastInsertRowid);
    db.prepare('UPDATE articles SET cluster_id = ? WHERE id = ?').run(cl, id); db.prepare('INSERT INTO cluster_articles VALUES (?,?,0,?)').run(cl, id, at); db.prepare('INSERT INTO article_sources VALUES (?,?,?)').run(id, a.source, at); ids.push(id);
  });
  recomputeCluster(db, cl);
  db.prepare('UPDATE story_clusters SET primary_article_id = ?, title = (SELECT title FROM articles WHERE id = ?) WHERE id = ?').run(ids[o.primary ?? 0], ids[o.primary ?? 0], cl);
  if (o.kind) db.prepare('UPDATE story_clusters SET summary = ?, summary_kind = ? WHERE id = ?').run(o.summary ?? 'Combined summary written from the sources above, naming each publisher.', o.kind, cl);
  return { cl, ids };
}
const prefer = (on: boolean) => savePrefs(db, { ...getPrefs(db), preferFreeCoverage: on });
const feed = (extra: Record<string, string> = {}) => queryFeed(db, { tab: 'latest', limit: 50, ...extra }).items;
const mute = (...names: string[]) => savePrefs(db, { ...getPrefs(db), mutedPublishers: names });
beforeEach(() => { db = memDb(); });

describe('access tiers', () => {
  it('ranks known-free articles, usually-free publishers, unknown, metered, then likely-paywalled; explicit article metadata beats the publisher default', () => {
    expect([accessTier('free', 'paywalled'), accessTier(null, 'free'), accessTier(null, 'unknown'), accessTier(null, 'metered'), accessTier(null, 'paywalled')]).toEqual([0, 1, 2, 3, 4]);
    expect(accessTier('paywalled', 'free')).toBe(4); expect(accessTier('metered', 'free')).toBe(3); expect(accessTier('free', 'unknown')).toBe(0);
  });
  it('REGRESSION: missing metadata is never read as free or paywalled', () => {
    expect(accessTier(null, 'unknown')).toBe(2); expect(accessTier(undefined, undefined)).toBe(2); expect(accessTier('bogus', 'bogus')).toBe(2); expect(accessInfo(null, 'unknown')).toEqual({ level: 'unknown', basis: 'none', label: null });
  });
  it('labels: estimates from the publisher say "Likely paywall" / "Usually free"; explicit article metadata is stated plainly', () => {
    expect(accessInfo(null, 'paywalled').label).toBe('Likely paywall'); expect(accessInfo(null, 'free').label).toBe('Usually free'); expect(accessInfo(null, 'metered').label).toBe('Metered');
    expect(accessInfo('paywalled', 'free')).toMatchObject({ label: 'Paywall', basis: 'article' }); expect(accessInfo('free', 'paywalled')).toMatchObject({ label: 'Free', basis: 'article' });
  });
});

describe('choosing the primary article', () => {
  const mixed = () => { const paywalled = src('Wall Street Wire', 'paywalled'), metered = src('Metered Daily', 'metered'), unknown = src('Plain Press'), free = src('Open News', 'free'); return { paywalled, metered, unknown, free }; };
  it('REGRESSION: a free publisher beats the stored paywalled primary, and link, publisher, headline, image and excerpt all come from that one article', () => {
    const s = mixed(); const { cl } = story([{ source: s.paywalled, title: 'Paywalled headline' }, { source: s.free, title: 'Free headline', excerpt: 'Open News excerpt about the vote.' }, { source: s.metered }], { primary: 0 });
    const it = feed().find((x) => x.id === cl)!;
    expect(it.primary).toMatchObject({ publisher: 'Open News', url: expect.stringContaining('OpenNews') }); expect(it.title).toBe('Free headline'); expect(it.imageUrl).toBe('https://img.example/OpenNews.jpg');
    expect(it.summary).toBe('Open News excerpt about the vote.'); expect(it.summaryKind).toBe('excerpt');
    prefer(false); expect(feed().find((x) => x.id === cl)).toMatchObject({ title: 'Paywalled headline', primary: { publisher: 'Wall Street Wire' } }); // off: the usual choice
  });
  it('orders the whole ladder: usually free, then unknown, then metered, then likely paywall', () => {
    const s = mixed(); const arts = [{ source: s.paywalled }, { source: s.metered }, { source: s.unknown }, { source: s.free }];
    const pick = (omit: string[]) => { db = memDb(); n = 0; const q = mixed(); const keep = Object.entries(q).filter(([k]) => !omit.includes(k)).map(([, v]) => ({ source: v })); const { cl } = story(keep, { primary: 0 }); return feed().find((x) => x.id === cl)!.primary!.publisher; };
    expect(pick([])).toBe('Open News'); expect(pick(['free'])).toBe('Plain Press'); expect(pick(['free', 'unknown'])).toBe('Metered Daily'); expect(pick(['free', 'unknown', 'metered'])).toBe('Wall Street Wire'); void arts;
  });
  it('explicit article metadata overrides the publisher default, both ways', () => {
    const wall = src('Wall Street Wire', 'paywalled'), open = src('Open News', 'free'), plain = src('Plain Press');
    let r = story([{ source: open, access: 'paywalled' }, { source: wall, access: 'free' }, { source: plain }], { primary: 0 }); // the "free" publisher's article says paywall; the "paywalled" publisher's article says free
    expect(feed().find((x) => x.id === r.cl)!.primary).toMatchObject({ publisher: 'Wall Street Wire', access: { label: 'Free', basis: 'article' } });
    db = memDb(); n = 0; const o2 = src('Open News', 'free'), p2 = src('Plain Press'); r = story([{ source: o2, access: 'paywalled' }, { source: p2 }], { primary: 0 });
    expect(feed().find((x) => x.id === r.cl)!.primary!.publisher).toBe('Plain Press'); // the publisher default no longer applies to that article
  });
  it('nothing to choose between (all unknown) behaves exactly as with the preference off', () => {
    const a = src('Alpha'), b = src('Beta'), c = src('Gamma'); story([{ source: a }, { source: b }, { source: c }], { primary: 1 }); story([{ source: c }, { source: a }], { primary: 0 });
    const on = JSON.stringify(feed()); prefer(false); expect(JSON.stringify(feed())).toBe(on);
  });
  it('REGRESSION: selection is deterministic: the stored primary wins inside its tier, otherwise the story\'s usual ranking, and repeated reads agree', () => {
    const a = src('Alpha', 'free'), b = src('Beta', 'free'), c = src('Gamma', 'paywalled');
    const keep = story([{ source: a }, { source: b }, { source: c }], { primary: 1 }); expect(feed().find((x) => x.id === keep.cl)!.primary!.publisher).toBe('Beta'); // stored primary is in the best tier
    const moved = story([{ source: c }, { source: a, ageMin: 50 }, { source: b, ageMin: 40 }], { primary: 0 }); // stored primary is paywalled: Alpha and Beta tie, usual ranking (earliest) decides
    const first = feed().find((x) => x.id === moved.cl)!.primary!.publisher; for (let i = 0; i < 5; i++) expect(feed().find((x) => x.id === moved.cl)!.primary!.publisher).toBe(first); expect(first).toBe('Alpha');
  });
  it('respects muted publishers: a muted free source is skipped, and nothing muted is ever the headline while others remain', () => {
    const s = mixed(); const { cl } = story([{ source: s.paywalled }, { source: s.free }, { source: s.unknown }], { primary: 0 }); mute('Open News');
    expect(feed().find((x) => x.id === cl)).toMatchObject({ primary: { publisher: 'Plain Press' }, mutedSources: 1 });
    mute('Open News', 'Plain Press'); expect(feed().find((x) => x.id === cl)!.primary!.publisher).toBe('Wall Street Wire');
  });
  it('is the same everywhere: compact feed, search, saved and the newspaper Front Page', () => {
    const s = mixed(); const { cl } = story([{ source: s.paywalled }, { source: s.free }], { primary: 0 }); db.prepare('INSERT INTO bookmarks VALUES (?,1)').run(cl);
    const front = queryFrontPage(db); const onFront = [front.lead, ...front.secondary, ...front.sections.flatMap((b) => b.items)].find((x) => x?.id === cl)!;
    for (const it of [feed().find((x) => x.id === cl)!, feed({ q: 'council' }).find((x) => x.id === cl)!, queryFeed(db, { tab: 'saved' }).items[0], onFront]) expect([it.primary!.publisher, it.title, it.imageUrl]).toEqual(['Open News', `${T} (Open News)`, 'https://img.example/OpenNews.jpg']);
  });
  it('keeps a combined AI summary (labelled AI) but replaces a single-publisher excerpt with the chosen article\'s own', () => {
    const s = mixed(); const ai = story([{ source: s.paywalled }, { source: s.free }], { primary: 0, kind: 'ai', summary: 'Both outlets report the council approved the plan; Open News adds the vote count.' });
    expect(feed().find((x) => x.id === ai.cl)).toMatchObject({ primary: { publisher: 'Open News' }, summary: 'Both outlets report the council approved the plan; Open News adds the vote count.', summaryKind: 'ai' });
    const s2 = { w: src('Wall Street Wire', 'paywalled'), f: src('Open News', 'free') }; const ex = story([{ source: s2.w, excerpt: 'Paywalled outlet excerpt.' }, { source: s2.f, excerpt: null }], { primary: 0 });
    expect(feed().find((x) => x.id === ex.cl)).toMatchObject({ primary: { publisher: 'Open News' }, summary: null, summaryKind: 'headline' }); // the free article gave no text: headline only, never the other outlet's excerpt
  });
  it('shows access beside every source in Coverage, and nothing for unknown', () => {
    const s = mixed(); const { cl } = story([{ source: s.paywalled }, { source: s.free }, { source: s.unknown }, { source: s.metered, access: 'paywalled' }], { primary: 0 });
    const labels = Object.fromEntries(feed().find((x) => x.id === cl)!.articles.map((a) => [a.publisher, a.access.label]));
    expect(labels).toEqual({ 'Wall Street Wire': 'Likely paywall', 'Open News': 'Usually free', 'Plain Press': null, 'Metered Daily': 'Paywall' });
  });
});

describe('REGRESSION: changing the primary article for access reasons is not news', () => {
  const snapshot = () => JSON.stringify(['story_clusters', 'cluster_articles', 'article_sources', 'bookmarks', 'feedback', 'feedback_sources', 'reading_state', 'articles'].map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all()));
  function readStory() {
    const w = src('Wall Street Wire', 'paywalled'), f = src('Open News', 'free'); const { cl } = story([{ source: w }, { source: f }], { primary: 0, kind: 'ai', summary: 'Combined summary: both outlets report the approval.' });
    db.prepare('INSERT INTO reading_state (cluster_id, read_at) VALUES (?,?)').run(cl, Date.now()); db.prepare('INSERT INTO bookmarks VALUES (?,5)').run(cl); db.prepare('INSERT INTO feedback (cluster_id, rating, reason, category, created_at, updated_at) VALUES (?,1,NULL,NULL,1,1)').run(cl);
    return { cl, w, f };
  }
  it('turning the preference on or off changes only what is shown: no write, no reopening, the read story stays hidden', () => {
    const { cl } = readStory(); const before = snapshot();
    for (const on of [true, false, true, false]) { prefer(on); expect(feed()).toEqual([]); expect(feed({ q: 'council' })[0]).toMatchObject({ id: cl, isRead: true, isUpdated: false }); }
    expect(snapshot()).toBe(before);
    expect((db.prepare('SELECT substantive_at s FROM story_clusters WHERE id = ?').get(cl) as any).s).toBeNull();
  });
  it('changing a source\'s access setting (which changes the chosen article) leaves the story, its summary, state and links untouched', async () => {
    const { w, f } = readStory(); const before = snapshot();
    const apps = await withApi(); try {
      expect((await apps.call('PATCH', `/api/sources/${f}`, { access: 'paywalled' })).statusCode).toBe(200); expect((await apps.call('PATCH', `/api/sources/${w}`, { access: 'free' })).statusCode).toBe(200);
      expect(queryFeed(db, { tab: 'latest', q: 'council' }).items[0]).toMatchObject({ primary: { publisher: 'Wall Street Wire' }, isRead: true, isUpdated: false, summaryKind: 'ai', bookmarked: true, rating: 1 }); // the primary changed
      expect(queryFeed(db, { tab: 'latest' }).items).toEqual([]); // ...and the read story did not come back
    } finally { await apps.close(); }
    const strip = (s: string) => s; void strip; const sourcesChanged = db.prepare('SELECT COUNT(*) n FROM sources WHERE access != ?').get('unknown') as any; expect(sourcesChanged.n).toBe(2);
    const after = JSON.parse(snapshot()); const was = JSON.parse(before); expect(after.slice(0, 7)).toEqual(was.slice(0, 7)); // clusters (incl. substantive_at, updated_at, summary), membership, bookmarks, feedback, reading state: identical
    expect(db.prepare('SELECT COUNT(*) n FROM ai_usage').get()).toEqual({ n: 0 }); // no model involved
  });
  it('a combined AI summary stays valid (same hash and text) whichever publisher is primary', () => {
    const { cl } = readStory(); const row = () => db.prepare('SELECT summary, summary_kind, summary_hash, differences FROM story_clusters WHERE id = ?').get(cl);
    const a = row(); prefer(false); feed({ q: 'council' }); prefer(true); feed({ q: 'council' }); expect(row()).toEqual(a);
  });
});

async function withApi() {
  const oidc: OidcClient & { nonce?: string } = { authUrl: ({ state, nonce }) => `https://x/?state=${state}&nonce=${nonce}`, async exchange() { return { sub: 's', email: 'me@example.com', emailVerified: true, name: 'Me', nonce: oidc.nonce ?? null }; } };
  setSetting(db, 'last_news_refresh_at', Date.now());
  const { app } = await buildApp(testConfig(), db, { oidc, logger: false, transport: null }) as { app: FastifyInstance };
  const r1 = await app.inject({ url: '/auth/login' }); const loc = new URL(r1.headers.location as string); oidc.nonce = loc.searchParams.get('nonce')!;
  const r2 = await app.inject({ url: `/auth/callback?code=c&state=${loc.searchParams.get('state')}`, cookies: { oauth_tx: r1.cookies[0].value } });
  const cookie = r2.cookies.find((c) => c.name === 'sid')!.value; const csrf = (await app.inject({ url: '/api/me', cookies: { sid: cookie } })).json().csrfToken;
  return { call: (method: any, url: string, payload?: unknown) => app.inject({ method, url, cookies: { sid: cookie }, headers: { 'x-csrf-token': csrf }, payload: payload as any }), close: () => app.close() };
}

describe('settings, API and feed metadata', () => {
  let api: Awaited<ReturnType<typeof withApi>>;
  beforeEach(async () => { api = await withApi(); }); afterEach(async () => { await api.close(); });
  it('existing sources default to Unknown; the access setting is editable and validated; the preference is on by default and persists', async () => {
    const s = src('Alpha'); const list = (await api.call('GET', '/api/sources')).json() as any[]; expect(list.find((x) => x.id === s).access).toBe('unknown');
    expect((await api.call('PATCH', `/api/sources/${s}`, { access: 'metered' })).statusCode).toBe(200); expect(((await api.call('GET', '/api/sources')).json() as any[]).find((x) => x.id === s).access).toBe('metered');
    expect((await api.call('PATCH', `/api/sources/${s}`, { access: 'sometimes' })).statusCode).toBe(400);
    const prefs = (await api.call('GET', '/api/prefs')).json().prefs; expect(prefs.preferFreeCoverage).toBe(true);
    expect((await api.call('PUT', '/api/prefs', { ...prefs, preferFreeCoverage: false })).statusCode).toBe(200); expect((await api.call('GET', '/api/prefs')).json().prefs.preferFreeCoverage).toBe(false);
    const { preferFreeCoverage: _p, ...older } = prefs; expect((await api.call('PUT', '/api/prefs', older)).statusCode).toBe(200); expect((await api.call('GET', '/api/prefs')).json().prefs.preferFreeCoverage).toBe(false); // an older client does not reset it
  });
  it('the database refuses an unknown access value', () => {
    expect(() => db.prepare("INSERT INTO sources (name, site_url, access, created_at) VALUES ('x','https://x.example','maybe',0)").run()).toThrow(/CHECK/);
  });
  it('reads explicit access from the feed item only; absence stays null', () => {
    const xml = `<?xml version="1.0"?><rss version="2.0" xmlns:schema="http://schema.org/"><channel><title>T</title>
      <item><title>Free one</title><link>https://a.example/1</link><pubDate>${new Date().toUTCString()}</pubDate><schema:isAccessibleForFree>true</schema:isAccessibleForFree></item>
      <item><title>Wall one</title><link>https://a.example/2</link><pubDate>${new Date().toUTCString()}</pubDate><isAccessibleForFree>false</isAccessibleForFree></item>
      <item><title>Silent one</title><link>https://a.example/3</link><pubDate>${new Date().toUTCString()}</pubDate></item></channel></rss>`;
    expect(parseFeed(xml).items.map((i) => i.access)).toEqual(['free', 'paywalled', null]);
  });
});

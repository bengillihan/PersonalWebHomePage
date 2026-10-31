import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { memDb, fixtureServer, logger, type Fixture } from './helpers.js';
import { ingestSource, processNewArticles, Refresher, type SourceRow } from '../server/news/ingest.js';
import { readPage, combine, dueDomains, runDomainChecks, hostOf, domainLevels, MAX_DOMAINS_PER_RUN } from '../server/news/domain-access.js';
import { accessInfo, accessTier } from '../server/news/access.js';
import { queryFeed } from '../server/news/query.js';
import type { DB } from '../server/db.js';

let fx: Fixture; beforeAll(async () => { fx = await fixtureServer(); }); afterAll(async () => { await fx.close(); });
let db: DB; beforeEach(() => { db = memDb(); fx.hits.length = 0; });
const DAY = 86_400_000;
const PARA = 'The council voted on Tuesday to fund dredging of the harbor channel this spring, after months of debate over the cost and the effect on local fishing crews and shippers.';
const ARTICLE = `<article><p>${PARA}</p><p>${PARA}</p><p>${PARA}</p><p>${PARA}</p></article>`;
const page = (head = '', body = ARTICLE) => `<!doctype html><html><head>${head}</head><body>${body}</body></html>`;
const ld = (o: unknown) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`;

describe('what one page declares', () => {
  it('isAccessibleForFree = false (boolean, "False", nested, @graph, microdata) means paywalled; true or absent does not', () => {
    for (const html of [page(ld({ '@type': 'NewsArticle', isAccessibleForFree: false })), page(ld({ '@type': 'NewsArticle', isAccessibleForFree: 'False' })), page(ld([{ '@type': 'WebSite' }, { '@type': 'NewsArticle', hasPart: { '@type': 'WebPageElement', isAccessibleForFree: 'false' } }])),
      page(ld({ '@graph': [{ '@type': 'Article', isAccessibleForFree: false }] })), page('', '<div itemprop="isAccessibleForFree" content="false"></div><p>x</p>')])
      expect(readPage(200, html)).toMatchObject({ level: 'paywalled' });
    expect(readPage(200, page(ld({ '@type': 'NewsArticle', isAccessibleForFree: true })))).toMatchObject({ level: 'free' });
    expect(readPage(200, page('<script type="application/ld+json">{not json</script>'))).toMatchObject({ level: 'free' });
  });
  it('paywall markup means metered, a vendor script alone does not; HTTP 402 means paywalled', () => {
    expect(readPage(200, page('<script src="https://cdn.tinypass.com/api/tinypass.min.js"></script><script src="https://x.zephr.com/zephr.js"></script>'))).toMatchObject({ level: 'free' });
    expect(readPage(200, page('', '<div class="article paywall gate"></div><p>x</p>'))).toMatchObject({ level: 'metered' });
    expect(readPage(402, '')).toMatchObject({ level: 'paywalled' });
  });
  it('blocked, failed or non-HTML responses are NO evidence, never "free"', () => {
    for (const st of [401, 403, 404, 429, 500]) expect(readPage(st, page())).toBeNull();
    expect(readPage(200, '{"json":true}')).toBeNull();
    expect(readPage(200, page())).toMatchObject({ level: 'free' });
  });
  it('REGRESSION: login and bot-check pages (HTTP 200) are NO evidence, not "free"', () => {
    for (const body of ['<main><h1>Sign in to continue</h1><p>Please sign in to continue reading. Create a free account or log in with your email address to see this page.</p></main>',
      '<body><h1>Verify you are human</h1><p>Checking your browser before accessing the site. This process is automatic and your browser will redirect you shortly to the page you asked for.</p></body>',
      '<div id="cf">Just a moment...</div><p>Enable JavaScript and cookies to continue to the website, then try again in a few seconds when the check completes automatically.</p>', `<h1>Access denied</h1>${ARTICLE.slice(0, 40)}`])
      expect(readPage(200, page('', body)), body).toBeNull();
    expect(readPage(200, page('', `<p class="x">Please sign in</p>${ARTICLE}${ARTICLE}${ARTICLE}${ARTICLE}${ARTICLE}${ARTICLE}${ARTICLE}${ARTICLE}${ARTICLE}`))).toMatchObject({ level: 'free' }); // a sign-in link on a real, long article is not a gate
    expect(combine([readPage(200, page('', '<h1>Verify you are human</h1>')), readPage(403, '')])).toMatchObject({ level: 'unknown', pages: 0 });
  });
  it('REGRESSION: "free" needs readable article text; a thin or empty page is unknown', () => {
    expect(readPage(200, page('', '<p>Story text.</p>'))).toBeNull(); expect(readPage(200, '<html><body><div id="app"></div><script>boot()</script></body></html>')).toBeNull();
    expect(readPage(200, page())).toMatchObject({ level: 'free', evidence: expect.stringMatching(/readable/) });
  });
  it('REGRESSION: paywall markup is read by its VALUE: data-paywall="false" and inactive classes are not a paywall', () => {
    for (const body of ['<article data-paywall="false">', "<article data-paywall='0'>", '<article data-paywall=off>', '<article data-paywall="disabled">', '<div class="no-paywall paywall-banner is-hidden">', '<div id="paywall-promo">', '<script>var cfg = {"paywall": false};</script><div>'])
      expect(readPage(200, page('', body + ARTICLE.replace('<article>', ''))), body).toMatchObject({ level: 'free' });
    for (const body of ['<article data-paywall="true">', '<article data-paywall>', '<article data-paywall="metered">', '<div class="story paywalled">', '<div class="is-paywall">', '<div id="paywall">', '<script>var cfg = {"paywall": true};</script><div>'])
      expect(readPage(200, page('', body + ARTICLE.replace('<article>', ''))), body).toMatchObject({ level: 'metered' });
  });
  it('a domain takes the strongest declared evidence of its pages, and unknown when nothing could be read', () => {
    const f = { level: 'free', evidence: 'f' } as const, p = { level: 'paywalled', evidence: 'p' } as const, m = { level: 'metered', evidence: 'm' } as const;
    expect(combine([f, p]).level).toBe('paywalled'); expect(combine([f, m]).level).toBe('metered'); expect(combine([null, f])).toMatchObject({ level: 'free', pages: 1 });
    expect(combine([null, null])).toMatchObject({ level: 'unknown', pages: 0 }); expect(combine([]).level).toBe('unknown');
  });
});

describe('priority: article metadata, then the source setting, then the domain check', () => {
  it('labels and tiers', () => {
    expect(accessInfo(null, 'unknown', 'paywalled')).toEqual({ level: 'paywalled', basis: 'domain', label: 'Likely paywall' });
    expect(accessInfo(null, 'unknown', 'free').label).toBe('Likely free'); expect(accessInfo(null, null, 'metered').label).toBe('Likely metered');
    expect(accessInfo(null, 'free', 'paywalled')).toMatchObject({ basis: 'publisher', label: 'Usually free' });   // the user's setting wins
    expect(accessInfo('paywalled', 'free', 'free')).toMatchObject({ basis: 'article', label: 'Paywall' });         // the article's own metadata wins
    expect(accessInfo(null, 'unknown', 'unknown')).toEqual({ level: 'unknown', basis: 'none', label: null }); expect(accessInfo(null, 'unknown', null).label).toBeNull();
    expect(accessTier('free', 'paywalled', 'paywalled')).toBe(0); expect(accessTier(null, 'free', 'paywalled')).toBe(1);
    expect(accessTier(null, 'unknown', 'free')).toBe(1.5); expect(accessTier(null, 'unknown', null)).toBe(2); expect(accessTier(null, 'unknown', 'paywalled')).toBe(4);
  });
});

function addArticle(sourceId: number, url: string, ageDays = 1) {
  const at = Date.now() - ageDays * DAY;
  return Number(db.prepare(`INSERT INTO articles (source_id,url,canonical_url,canonical_hash,publisher,title,title_norm,excerpt,published_at,fetched_at,content_hash,availability) VALUES (?,?,?,?,?,?,?,?,?,?,?,'excerpt')`)
    .run(sourceId, url, url, 'h' + url, 'P', 't ' + url, 't ' + url, 'x', at, at, 'c' + url).lastInsertRowid);
}
const addSource = (name: string, access = 'unknown', kind = 'rss') => Number(db.prepare("INSERT INTO sources (name, site_url, feed_url, kind, access, created_at) VALUES (?,?,?,?,?,0)").run(name, `https://${name}.example/`, `https://${name}.example/feed`, kind, access).lastInsertRowid);
const rowOf = (d: string) => db.prepare('SELECT * FROM domain_access WHERE domain = ?').get(d) as any;

describe('which domains get checked', () => {
  it('only recent rss articles with an unset source access; never aggregator links; www is the same domain; at most the per-run limit', () => {
    const open = addSource('open'), fixed = addSource('fixed', 'free'), agg = addSource('agg', 'unknown', 'aggregator');
    addArticle(open, 'https://www.a.example/1'); addArticle(open, 'https://a.example/2'); addArticle(open, 'https://b.example/1'); addArticle(open, 'https://old.example/1', 40);
    addArticle(fixed, 'https://set.example/1'); addArticle(agg, 'https://news.google.com/rss/articles/xyz'); addArticle(agg, 'https://agg-only.example/1');
    const due = dueDomains(db, Date.now(), 10); expect(due.map((d) => d.domain).sort()).toEqual(['a.example', 'b.example']);
    expect(due.find((d) => d.domain === 'a.example')!.urls).toHaveLength(2); expect(hostOf('https://WWW.Example.com/x')).toBe('example.com');
    for (let i = 0; i < 10; i++) addArticle(open, `https://many${i}.example/1`);
    expect(dueDomains(db, Date.now()).length).toBe(MAX_DOMAINS_PER_RUN);
  });
});

describe('checking a domain (fixture server)', () => {
  const U = () => fx.url; // every fixture URL is the same domain: 127.0.0.1
  it('stores a paywalled answer with its evidence, and the story shows "Likely paywall"', async () => {
    fx.routes.set('/dp/1', { type: 'text/html', body: page(ld({ isAccessibleForFree: false })) }); fx.routes.set('/dp/2', { type: 'text/html', body: page() });
    const s = addSource('pw'); addArticle(s, `${U()}/dp/1`); addArticle(s, `${U()}/dp/2`);
    expect(await runDomainChecks(db, { allowPrivate: true })).toBe(1);
    expect(rowOf('127.0.0.1')).toMatchObject({ level: 'paywalled', pages_checked: 2, attempts: 0 }); expect(rowOf('127.0.0.1').evidence).toMatch(/isAccessibleForFree/);
    expect(domainLevels(db, [`${U()}/x`]).get('127.0.0.1')).toBe('paywalled');
  });
  it('a settled answer is not asked again for a month, then it is', async () => {
    fx.routes.set('/dq/1', { type: 'text/html', body: page() });
    const s = addSource('q'); addArticle(s, `${U()}/dq/1`, -40); const now = Date.now();
    await runDomainChecks(db, { allowPrivate: true }, now); expect(rowOf('127.0.0.1').level).toBe('free'); const n = fx.hits.length;
    await runDomainChecks(db, { allowPrivate: true }, now + 29 * DAY); expect(fx.hits.length).toBe(n);
    await runDomainChecks(db, { allowPrivate: true }, now + 31 * DAY); expect(fx.hits.length).toBeGreaterThan(n);
  });
  it('a blocked site is "unknown" (never free), shows no label, and is retried after 3, then 7, then 14 days', async () => {
    fx.routes.set('/db/1', { type: 'text/html', status: 403, body: 'blocked' });
    const s = addSource('b'); addArticle(s, `${U()}/db/1`, -40); const t = Date.now(); const when: number[] = [t];
    await runDomainChecks(db, { allowPrivate: true }, t); expect(rowOf('127.0.0.1')).toMatchObject({ level: 'unknown', attempts: 1, next_check_at: t + 3 * DAY });
    await runDomainChecks(db, { allowPrivate: true }, t + 1 * DAY); expect(rowOf('127.0.0.1').attempts).toBe(1); // not due yet
    await runDomainChecks(db, { allowPrivate: true }, t + 4 * DAY); expect(rowOf('127.0.0.1')).toMatchObject({ attempts: 2, next_check_at: t + 4 * DAY + 7 * DAY });
    await runDomainChecks(db, { allowPrivate: true }, t + 12 * DAY); expect(rowOf('127.0.0.1')).toMatchObject({ attempts: 3, next_check_at: t + 12 * DAY + 14 * DAY });
    await runDomainChecks(db, { allowPrivate: true }, t + 30 * DAY); expect(rowOf('127.0.0.1').next_check_at).toBe(t + 30 * DAY + 14 * DAY); // capped at 14 days
    expect(domainLevels(db, [`${U()}/x`]).size).toBe(0); void when;
  });
  it('an unreachable domain never fails the run and leaves no wrong answer', async () => {
    const s = addSource('dead'); addArticle(s, 'http://127.0.0.1:1/never'); // nothing listens there
    await expect(runDomainChecks(db, { allowPrivate: true })).resolves.toBe(1); expect(rowOf('127.0.0.1').level).toBe('unknown');
  });
  it('the access a user set on a source is never checked and never overridden', async () => {
    fx.routes.set('/dr/1', { type: 'text/html', body: page(ld({ isAccessibleForFree: false })) });
    const s = addSource('set', 'free'); addArticle(s, `${U()}/dr/1`);
    expect(await runDomainChecks(db, { allowPrivate: true })).toBe(0); expect(fx.hits).not.toContain('/dr/1');
  });
});

describe('the domain answer decides the displayed article, and nothing else', () => {
  const xml = (title: string, link: string, desc: string) => `<?xml version="1.0"?><rss version="2.0"><channel><title>F</title><item><title>${title}</title><link>${link}</link><pubDate>${new Date(Date.now() - 3_600_000).toUTCString()}</pubDate><description>${desc}</description></item></channel></rss>`;
  it('prefers the free-domain article as the primary, labels both, and touches no read state, summary or cluster', async () => {
    const A = ['Boeing strike ends after union approves new contract', 'Boeing machinists voted to approve a new four-year contract, ending a strike that lasted several weeks.'];
    const B = ['Union approves new contract, ending Boeing strike', 'Striking Boeing workers ratified a new contract on Wednesday, ending the walkout that started weeks ago.'];
    fx.routes.set('/dd-a', { body: xml(A[0], 'https://wall.example/1', A[1]) }); fx.routes.set('/dd-b', { body: xml(B[0], 'https://open.example/9', B[1]) });
    for (const [n, p] of [['Wall', '/dd-a'], ['Open', '/dd-b']]) db.prepare("INSERT INTO sources (name, site_url, feed_url, kind, created_at) VALUES (?,?,?,'rss',0)").run(n, `${fx.url}/${n}`, fx.url + p);
    const d = { db, ai: null, log: logger, fetchOpts: { allowPrivate: true } }; const got: number[] = [];
    for (const s of db.prepare('SELECT * FROM sources').all() as SourceRow[]) got.push(...await ingestSource(d, s)); await processNewArticles(d, got);
    const story = () => queryFeed(db, { tab: 'latest', limit: 5 }).items[0];
    const before = JSON.stringify(db.prepare('SELECT * FROM story_clusters').all()); const first = story(); expect(first.articles.every((a) => a.access.label === null)).toBe(true);
    const now = Date.now(); const put = db.prepare("INSERT INTO domain_access (domain, level, evidence, pages_checked, checked_at, next_check_at) VALUES (?,?,'e',1,?,?)");
    put.run('wall.example', 'paywalled', now, now + DAY); put.run('open.example', 'free', now, now + DAY);
    const after = story(); expect(after.primary).toMatchObject({ publisher: 'PubOpen'.replace('PubOpen', after.primary!.publisher), access: { label: 'Likely free', basis: 'domain' } });
    expect(after.articles.map((a) => a.access.label).sort()).toEqual(['Likely free', 'Likely paywall']); expect(after.primary!.url).toBe('https://open.example/9');
    expect(JSON.stringify(db.prepare('SELECT * FROM story_clusters').all())).toBe(before); // display only
  });
});

describe('during a refresh', () => {
  it('checks domains after the refresh only when asked to, and a failing check never fails the refresh', async () => {
    const feed = `<?xml version="1.0"?><rss version="2.0"><channel><title>F</title><item><title>Council approves harbor dredging budget</title><link>${fx.url}/rf/1</link><pubDate>${new Date(Date.now() - 3_600_000).toUTCString()}</pubDate><description>The council voted to fund dredging of the harbor channel this spring.</description></item></channel></rss>`;
    fx.routes.set('/rf-feed', { body: feed }); fx.routes.set('/rf/1', { type: 'text/html', body: page(ld({ isAccessibleForFree: false })) });
    db.prepare("INSERT INTO sources (name, site_url, feed_url, kind, created_at) VALUES ('R', ?, ?, 'rss', 0)").run(fx.url + '/R', fx.url + '/rf-feed');
    await new Refresher({ db, ai: null, log: logger, fetchOpts: { allowPrivate: true } }).trigger('manual');
    expect(rowOf('127.0.0.1')).toBeUndefined(); // off by default
    await new Refresher({ db, ai: null, log: logger, fetchOpts: { allowPrivate: true }, domainAccess: true }).trigger('manual');
    expect(rowOf('127.0.0.1')).toMatchObject({ level: 'paywalled' });
    const story = queryFeed(db, { tab: 'latest', limit: 5 }).items[0]; expect(story.primary!.access).toMatchObject({ label: 'Likely paywall', basis: 'domain' });
  });
});

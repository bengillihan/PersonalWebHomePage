import { fetchWithRetry, validateUrl } from '../net/safeFetch.js';
import { assessFreshness, parseFeed, type Freshness } from './feed.js';

export interface FeedCandidate { feedUrl: string; title: string; format: 'rss' | 'atom'; freshness: Freshness; itemCount: number }
export interface Discovery { siteUrl: string; siteTitle: string | null; candidates: FeedCandidate[]; rejected: { feedUrl: string; reason: string }[] }

const COMMON_PATHS = ['/feed/', '/feed', '/rss', '/rss.xml', '/atom.xml', '/feed.xml', '/index.xml', '/rss/index.xml'];

export function extractFeedLinks(html: string, base: string): string[] {
  const out: string[] = [];
  for (const tag of html.match(/<link\b[^>]*>/gi) ?? []) {
    if (!/rel=["']?alternate/i.test(tag)) continue;
    if (!/type=["']?application\/(rss|atom)\+xml/i.test(tag)) continue;
    const href = /href=["']([^"']+)["']/i.exec(tag)?.[1];
    if (!href) continue;
    try { out.push(new URL(href.replace(/&amp;/g, '&'), base).toString()); } catch { /* skip */ }
  }
  return [...new Set(out)];
}

export async function probeFeed(feedUrl: string, fetchOpts: { allowPrivate?: boolean } = {}): Promise<FeedCandidate> {
  const res = await fetchWithRetry(feedUrl, { timeoutMs: 8000, maxBytes: 3_000_000, retries: 1, ...fetchOpts });
  if (res.status >= 400) throw new Error(`HTTP ${res.status}`);
  const feed = parseFeed(res.text());
  return { feedUrl: res.url, title: feed.title, format: feed.format, freshness: assessFreshness(feed), itemCount: feed.items.length };
}

/** Looks for publisher-provided feeds: <link rel=alternate> first, then common paths. Never scrapes article content. */
export async function discoverFeeds(siteInput: string, fetchOpts: { allowPrivate?: boolean } = {}): Promise<Discovery> {
  const site = validateUrl(siteInput, fetchOpts);
  const rejected: Discovery['rejected'] = [];
  const urls: string[] = [];
  let siteTitle: string | null = null;
  try {
    const res = await fetchWithRetry(site.toString(), { timeoutMs: 8000, maxBytes: 1_500_000, retries: 1, ...fetchOpts });
    const body = res.text();
    if (res.status < 400) {
      siteTitle = /<title[^>]*>([^<]{1,200})<\/title>/i.exec(body)?.[1]?.trim() ?? null;
      if (/<(rss|feed|rdf:RDF)\b/i.test(body.slice(0, 500))) urls.push(res.url); // the URL itself is a feed
      urls.push(...extractFeedLinks(body, res.url));
    } else rejected.push({ feedUrl: site.toString(), reason: `Site returned HTTP ${res.status}` });
  } catch (e) { rejected.push({ feedUrl: site.toString(), reason: (e as Error).message }); }
  for (const p of COMMON_PATHS) urls.push(new URL(p, site.origin).toString());
  const candidates: FeedCandidate[] = [];
  const seen = new Set<string>();
  for (const u of urls) {
    if (seen.has(u) || candidates.length >= 4) continue;
    seen.add(u);
    try { candidates.push(await probeFeed(u, fetchOpts)); }
    catch (e) { rejected.push({ feedUrl: u, reason: (e as Error).message }); }
  }
  candidates.sort((a, b) => Number(b.freshness.status === 'ok') - Number(a.freshness.status === 'ok'));
  return { siteUrl: site.toString(), siteTitle, candidates, rejected: rejected.slice(0, 10) };
}

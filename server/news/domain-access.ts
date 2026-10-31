import type { DB } from '../db.js';
import { fetchWithRetry } from '../net/safeFetch.js';
import type { Access } from './access.js';

/**
 * Automatic paywall detection, once per publisher DOMAIN (never per article, never with Gemini). A few recent article pages of a domain are fetched
 * (the same safe fetcher the feeds use) and read for what the publisher itself declares:
 *  - schema.org `isAccessibleForFree: false` in the page's structured data (what Google asks paywalled publishers to mark) -> paywalled;
 *  - paywall markup in the page itself (a paywall class/id/attribute, Leaky Paywall) -> metered. A vendor's script alone is NOT evidence (BBC loads Zephr and is free);
 *  - HTTP 402 -> paywalled; blocked or failed requests (401/403/429, errors) -> no evidence, never "free";
 *  - a page that loads with none of those -> free.
 * It is an ESTIMATE (a paywall counted in the browser by JavaScript cannot be seen from a plain fetch), so it ranks below the article's own feed metadata and
 * below the access the user set on a source, and it is labelled "Likely ...". Results are stored in domain_access and rechecked rarely.
 */
export const MAX_DOMAINS_PER_RUN = 4;
export const PAGES_PER_DOMAIN = 2;
const RECHECK_MS = 30 * 86_400_000;           // a settled answer is good for a month
const RETRY_MS = [3, 7, 14].map((d) => d * 86_400_000); // an inconclusive one is tried again after 3, 7, then 14 days
const SKIP_HOSTS = new Set(['news.google.com', 'google.com', 'feedproxy.google.com']);

export interface PageVerdict { level: Access; evidence: string }
export interface FetchOpts { allowPrivate?: boolean }

export const hostOf = (url: string): string | null => { try { return new URL(url).hostname.toLowerCase().replace(/^www\./, '') || null; } catch { return null; } };

const falsy = (v: unknown) => v === false || (typeof v === 'string' && v.trim().toLowerCase() === 'false');
function walk(node: unknown, hit: (o: Record<string, unknown>) => boolean, depth = 0): boolean {
  if (!node || typeof node !== 'object' || depth > 8) return false;
  if (Array.isArray(node)) return node.some((n) => walk(n, hit, depth + 1));
  const o = node as Record<string, unknown>;
  return hit(o) || Object.values(o).some((v) => walk(v, hit, depth + 1));
}
// Only markup that is itself a paywall. A vendor's script alone proves nothing (BBC loads Zephr and is free; Piano/Tinypass also run newsletter prompts), so vendors are not evidence.
const VENDOR = /(leaky[_-]?paywall|\bdata-paywall\b|class=["'][^"']*\bpaywall(?:ed)?\b|id=["']paywall|["']paywall["']\s*:\s*(?:true|\{))/i;

/** What one article page declares. `null` = the page said nothing usable (blocked, error, not HTML): no evidence either way. */
export function readPage(status: number, html: string): PageVerdict | null {
  if (status === 402) return { level: 'paywalled', evidence: 'HTTP 402 Payment Required' };
  if (status >= 400) return null;
  for (const m of html.matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let json: unknown; try { json = JSON.parse(m[1].trim()); } catch { continue; }
    if (walk(json, (o) => falsy(o.isAccessibleForFree))) return { level: 'paywalled', evidence: 'Page marks itself isAccessibleForFree = false' };
  }
  if (/itemprop=["']isAccessibleForFree["'][^>]*content=["']false["']|content=["']false["'][^>]*itemprop=["']isAccessibleForFree["']/i.test(html)) return { level: 'paywalled', evidence: 'Page marks itself isAccessibleForFree = false' };
  const v = VENDOR.exec(html); if (v) return { level: 'metered', evidence: `Paywall markup found (${v[1].slice(0, 30)})` };
  if (!/<(html|body|article|p)\b/i.test(html)) return null; // not an HTML page
  return { level: 'free', evidence: 'Page loads with no paywall markers' };
}

/** Combines the pages of one domain: any declared paywall wins, then metering, then free; no readable page at all = unknown. */
export function combine(pages: (PageVerdict | null)[]): PageVerdict & { pages: number } {
  const got = pages.filter((p): p is PageVerdict => p !== null);
  if (!got.length) return { level: 'unknown', evidence: 'No page could be read (blocked or unreachable)', pages: 0 };
  const pick = (['paywalled', 'metered', 'free'] as const).map((l) => got.find((p) => p.level === l)).find(Boolean)!;
  return { ...pick, pages: got.length };
}

export async function probeDomain(urls: string[], fetchOpts: FetchOpts = {}): Promise<PageVerdict & { pages: number }> {
  const pages: (PageVerdict | null)[] = [];
  for (const u of urls.slice(0, PAGES_PER_DOMAIN)) {
    try { const r = await fetchWithRetry(u, { timeoutMs: 8000, maxBytes: 1_200_000, retries: 0, ...fetchOpts }); pages.push(readPage(r.status, r.text())); }
    catch { pages.push(null); }
  }
  return combine(pages);
}

/**
 * Domains with recent articles that have no answer yet (or a due one), newest first. Skipped: aggregator links (Google News redirects, the publisher is
 * unknown), and a domain whose every recent article comes from a source with an access the user set, since that setting wins anyway.
 */
export function dueDomains(db: DB, now: number, limit = MAX_DOMAINS_PER_RUN): { domain: string; urls: string[] }[] {
  const rows = db.prepare(`SELECT a.url, s.access FROM articles a JOIN sources s ON s.id = a.source_id
    WHERE s.kind = 'rss' AND a.published_at >= ? ORDER BY a.published_at DESC LIMIT 600`).all(now - 14 * 86_400_000) as { url: string; access: string }[];
  const by = new Map<string, { urls: string[]; needed: boolean }>();
  for (const r of rows) {
    const d = hostOf(r.url); if (!d || SKIP_HOSTS.has(d)) continue;
    const e = by.get(d) ?? { urls: [], needed: false }; if (e.urls.length < PAGES_PER_DOMAIN) e.urls.push(r.url);
    if ((r.access ?? 'unknown') === 'unknown') e.needed = true; by.set(d, e);
  }
  const state = db.prepare('SELECT next_check_at FROM domain_access WHERE domain = ?');
  const out: { domain: string; urls: string[] }[] = [];
  for (const [domain, e] of by) {
    if (!e.needed) continue;
    const st = state.get(domain) as { next_check_at: number } | undefined;
    if (st && st.next_check_at > now) continue;
    out.push({ domain, urls: e.urls }); if (out.length >= limit) break;
  }
  return out;
}

/** Checks up to `limit` due domains and stores each answer. Never throws: a failure just leaves the domain due for a later refresh. */
export async function runDomainChecks(db: DB, fetchOpts: FetchOpts = {}, now = Date.now(), limit = MAX_DOMAINS_PER_RUN): Promise<number> {
  let done = 0;
  for (const d of dueDomains(db, now, limit)) {
    try {
      const prev = db.prepare('SELECT attempts FROM domain_access WHERE domain = ?').get(d.domain) as { attempts: number } | undefined;
      const r = await probeDomain(d.urls, fetchOpts);
      const attempts = r.level === 'unknown' ? (prev?.attempts ?? 0) + 1 : 0;
      const next = now + (r.level === 'unknown' ? RETRY_MS[Math.min(attempts - 1, RETRY_MS.length - 1)] : RECHECK_MS);
      db.prepare(`INSERT INTO domain_access (domain, level, evidence, pages_checked, attempts, checked_at, next_check_at) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(domain) DO UPDATE SET level = excluded.level, evidence = excluded.evidence, pages_checked = excluded.pages_checked, attempts = excluded.attempts, checked_at = excluded.checked_at, next_check_at = excluded.next_check_at`)
        .run(d.domain, r.level, r.evidence, r.pages, attempts, now, next);
      done++;
    } catch { /* stays due */ }
  }
  return done;
}

/** domain -> stored level, for the domains of these URLs (one query). Only answers that actually say something. */
export function domainLevels(db: DB, urls: string[]): Map<string, Access> {
  const hosts = [...new Set(urls.map(hostOf).filter((h): h is string => Boolean(h)))];
  const out = new Map<string, Access>(); if (!hosts.length) return out;
  const rows = db.prepare(`SELECT domain, level FROM domain_access WHERE level != 'unknown' AND domain IN (${hosts.map(() => '?').join(',')})`).all(...hosts) as { domain: string; level: Access }[];
  for (const r of rows) out.set(r.domain, r.level);
  return out;
}

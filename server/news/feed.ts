import { XMLParser } from 'fast-xml-parser';
import { stripHtml } from './normalize.js';

export interface FeedItem {
  guid: string | null;
  title: string;
  url: string;
  publishedAt: number | null;
  excerpt: string | null;
  imageUrl: string | null;
  publisher: string | null;
  publisherUrl: string | null;
  /** Explicit access stated by the feed item itself (schema.org isAccessibleForFree); null = not stated. Never inferred. */
  access: 'free' | 'paywalled' | null;
}
export interface ParsedFeed { format: 'rss' | 'atom'; title: string; items: FeedItem[]; undated: number }

export class FeedParseError extends Error {}

const parser = new XMLParser({
  ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text',
  processEntities: true, htmlEntities: false, trimValues: true, parseTagValue: false,
  isArray: (name) => ['item', 'entry', 'link', 'category'].includes(name),
});

const MAX_ITEMS = 100;
export const EXCERPT_MAX = 600;

export function parseFeed(xml: string, now = Date.now()): ParsedFeed {
  const head = xml.slice(0, 2000).trimStart();
  if (/^<!doctype\s+html|^<html/i.test(head)) throw new FeedParseError('Response is HTML, not a feed');
  if (/<!ENTITY/i.test(xml)) throw new FeedParseError('Feeds declaring XML entities are rejected');
  let doc: any;
  try { doc = parser.parse(xml); } catch (e) { throw new FeedParseError(`Invalid XML: ${(e as Error).message}`); }
  if (doc?.rss?.channel || doc?.['rdf:RDF']) return fromRss(doc.rss?.channel ?? doc['rdf:RDF'], doc['rdf:RDF']?.item, now);
  if (doc?.feed) return fromAtom(doc.feed, now);
  throw new FeedParseError('Not an RSS or Atom feed');
}

const txt = (v: any): string => (v == null ? '' : typeof v === 'object' ? String(v['#text'] ?? '') : String(v)).trim();

function parseDate(v: any, now: number): number | null {
  const s = txt(v);
  if (!s) return null;
  const t = Date.parse(s.replace(/\b(EDT|EST|CDT|CST|MDT|MST|PDT|PST)\b/, (z) => ({ EDT: '-0400', EST: '-0500', CDT: '-0500', CST: '-0600', MDT: '-0600', MST: '-0700', PDT: '-0700', PST: '-0800' } as any)[z]));
  if (!Number.isFinite(t) || t < Date.UTC(1995, 0, 1)) return null;
  if (t > now + 36 * 3600_000) return null; // future-dated: invalid, never treat as fresh
  return t;
}

function accessOf(it: any): 'free' | 'paywalled' | null {
  const raw = it?.isAccessibleForFree ?? it?.['schema:isAccessibleForFree'] ?? it?.['s:isAccessibleForFree'];
  const v = String(typeof raw === 'object' && raw !== null ? raw['#text'] ?? '' : raw ?? '').trim().toLowerCase();
  return v === 'true' ? 'free' : v === 'false' ? 'paywalled' : null;
}

function image(it: any): string | null {
  const cands: any[] = [it['media:thumbnail'], it['media:content'], it['media:group']?.['media:content'], it.enclosure].flat().filter(Boolean);
  for (const c of cands) {
    const u = c?.['@_url']; const type = c?.['@_type'] ?? 'image';
    if (u && /^https:\/\//i.test(u) && String(type).startsWith('image')) return String(u);
  }
  return null;
}

function fromRss(channel: any, rdfItems: any[] | undefined, now: number): ParsedFeed {
  const raw: any[] = (channel.item ?? rdfItems ?? []).slice(0, MAX_ITEMS);
  const items: FeedItem[] = []; let undated = 0;
  for (const it of raw) {
    const title = stripHtml(txt(it.title));
    const linkField = Array.isArray(it.link) ? it.link[0] : it.link;
    const url = txt(linkField) || (txt(it.guid).startsWith('http') ? txt(it.guid) : '');
    if (!title || !/^https?:\/\//i.test(url)) continue;
    const publishedAt = parseDate(it.pubDate ?? it['dc:date'] ?? it.published, now);
    if (publishedAt == null) { undated++; continue; }
    const body = stripHtml(txt(it.description) || txt(it['content:encoded']));
    const src = it.source;
    items.push({ guid: txt(it.guid) || null, title, url, publishedAt, excerpt: body ? body.slice(0, EXCERPT_MAX) : null, imageUrl: image(it), publisher: src ? stripHtml(txt(src)) || null : null, publisherUrl: src?.['@_url'] ?? null, access: accessOf(it) });
  }
  return { format: 'rss', title: stripHtml(txt(channel.title)), items, undated };
}

function fromAtom(feed: any, now: number): ParsedFeed {
  const items: FeedItem[] = []; let undated = 0;
  for (const e of (feed.entry ?? []).slice(0, MAX_ITEMS)) {
    const links: any[] = e.link ?? [];
    const alt = links.find((l) => !l['@_rel'] || l['@_rel'] === 'alternate') ?? links[0];
    const url = alt?.['@_href'] ?? '';
    const title = stripHtml(txt(e.title));
    if (!title || !/^https?:\/\//i.test(url)) continue;
    const publishedAt = parseDate(e.published ?? e.updated, now);
    if (publishedAt == null) { undated++; continue; }
    const body = stripHtml(txt(e.summary) || txt(e.content));
    items.push({ guid: txt(e.id) || null, title, url, publishedAt, excerpt: body ? body.slice(0, EXCERPT_MAX) : null, imageUrl: image(e), publisher: null, publisherUrl: null, access: accessOf(e) });
  }
  return { format: 'atom', title: stripHtml(txt(feed.title)), items, undated };
}

export const STALE_AFTER_DAYS = 21;

export interface Freshness { status: 'ok' | 'stale' | 'error'; newest: number | null; reason?: string }

/** A feed that parses but has no recent items is NOT operational. */
export function assessFreshness(feed: ParsedFeed, now = Date.now(), staleDays = STALE_AFTER_DAYS): Freshness {
  const dates = feed.items.map((i) => i.publishedAt!).filter(Boolean);
  if (!dates.length) return { status: 'error', newest: null, reason: 'Feed has no valid dated items' };
  const newest = Math.max(...dates);
  const ageDays = (now - newest) / 86_400_000;
  if (ageDays > staleDays) return { status: 'stale', newest, reason: `Newest item is ${Math.round(ageDays)} days old` };
  return { status: 'ok', newest };
}

export function googleNewsFeedUrl(query: string): string {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(`${query} when:7d`)}&hl=en-US&gl=US&ceid=US:en`;
}

/** Google News titles look like "Headline - Publisher"; strip the suffix, keep the publisher. */
export function cleanAggregatorItem(item: FeedItem): FeedItem {
  let { title, publisher } = item;
  const m = title.match(/^(.*\S)\s+-\s+([^-]{2,60})$/);
  if (m) { title = m[1]; publisher = publisher ?? m[2]; }
  return { ...item, title, publisher, excerpt: null, imageUrl: null };
}

/** Source-restricted aggregation: accept only items whose publisher URL is on the configured domain. */
export function itemOnDomain(item: FeedItem, domain: string): boolean {
  if (!item.publisherUrl) return false;
  try { const h = new URL(item.publisherUrl).hostname.replace(/^www\./, ''); return h === domain || h.endsWith('.' + domain); } catch { return false; }
}

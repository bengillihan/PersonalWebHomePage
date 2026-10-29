import { describe, it, expect } from 'vitest';
import { parseFeed, assessFreshness, FeedParseError, cleanAggregatorItem, itemOnDomain } from '../server/news/feed.js';
import { canonicalizeUrl, normalizeTitle } from '../server/news/normalize.js';
import { extractFeedLinks } from '../server/news/discover.js';
import { sentencesFallback } from '../server/news/summary.js';
import { rss, hoursAgo } from './helpers.js';

describe('feed parsing', () => {
  it('parses RSS with dates, excerpts (HTML stripped) and https thumbnails only', () => {
    const xml = `<rss xmlns:media="http://search.yahoo.com/mrss/" version="2.0"><channel><title>T</title>
      <item><title>Hello &amp; welcome</title><link>https://ex.com/a</link><pubDate>${hoursAgo(2).toUTCString()}</pubDate><description><![CDATA[<p>Body <b>text</b> here.</p>]]></description><media:thumbnail url="https://ex.com/i.jpg"/></item>
      <item><title>Insecure img</title><link>https://ex.com/b</link><pubDate>${hoursAgo(3).toUTCString()}</pubDate><media:thumbnail url="http://ex.com/i.jpg"/></item></channel></rss>`;
    const f = parseFeed(xml);
    expect(f.format).toBe('rss'); expect(f.items).toHaveLength(2);
    expect(f.items[0]).toMatchObject({ title: 'Hello & welcome', excerpt: 'Body text here.', imageUrl: 'https://ex.com/i.jpg' });
    expect(f.items[1].imageUrl).toBeNull();
  });
  it('parses Atom', () => {
    const f = parseFeed(`<feed xmlns="http://www.w3.org/2005/Atom"><title>A</title><entry><title>Entry</title><link rel="alternate" href="https://ex.com/e"/><id>1</id><updated>${hoursAgo(1).toISOString()}</updated><summary>Sum</summary></entry></feed>`);
    expect(f.format).toBe('atom'); expect(f.items[0].url).toBe('https://ex.com/e');
  });
  it('rejects HTML, garbage, non-feed XML and entity declarations', () => {
    expect(() => parseFeed('<!DOCTYPE html><html></html>')).toThrow(FeedParseError);
    expect(() => parseFeed('hello')).toThrow(FeedParseError);
    expect(() => parseFeed('<root><a/></root>')).toThrow(FeedParseError);
    expect(() => parseFeed('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;">]><rss><channel><title>&b;</title></channel></rss>')).toThrow(/entit/i);
  });
  it('skips undated and future-dated items instead of treating them as fresh', () => {
    const future = new Date(Date.now() + 10 * 86_400_000);
    const xml = `<rss><channel><title>T</title><item><title>No date</title><link>https://ex.com/1</link></item>
      <item><title>Future</title><link>https://ex.com/2</link><pubDate>${future.toUTCString()}</pubDate></item>
      <item><title>OK</title><link>https://ex.com/3</link><pubDate>${hoursAgo(1).toUTCString()}</pubDate></item></channel></rss>`;
    const f = parseFeed(xml);
    expect(f.items.map((i) => i.title)).toEqual(['OK']); expect(f.undated).toBe(2);
  });
  it('flags a frozen feed as stale (the real CNN legacy feed is dated 2018)', () => {
    const f = parseFeed(`<rss><channel><title>CNNMoney</title><item><title>Old</title><link>http://money.cnn.com/x</link><pubDate>Thu, 01 Nov 2018 16:50:27 EDT</pubDate></item></channel></rss>`);
    expect(f.items).toHaveLength(1);
    expect(assessFreshness(f).status).toBe('stale');
  });
  it('flags empty feeds as error and recent feeds as ok', () => {
    expect(assessFreshness(parseFeed('<rss><channel><title>x</title></channel></rss>')).status).toBe('error');
    expect(assessFreshness(parseFeed(rss([{ title: 'a', link: 'https://ex.com/a', date: hoursAgo(5) }]))).status).toBe('ok');
  });
  it('finds <link rel=alternate> feed URLs', () => {
    const html = `<head><link rel="alternate" type="application/rss+xml" title="x" href="/feed/"><link rel="alternate" type="application/atom+xml" href="https://ex.com/atom"><link rel="stylesheet" href="/a.css"></head>`;
    expect(extractFeedLinks(html, 'https://ex.com/')).toEqual(['https://ex.com/feed/', 'https://ex.com/atom']);
  });
  it('aggregator items: strips publisher suffix and enforces the source domain', () => {
    const f = parseFeed(`<rss><channel><title>GN</title><item><title>Big thing happens - MyNorthwest</title><link>https://news.google.com/rss/articles/abc</link><pubDate>${hoursAgo(1).toUTCString()}</pubDate><source url="https://mynorthwest.com">MyNorthwest</source></item>
      <item><title>Other - Elsewhere</title><link>https://news.google.com/rss/articles/def</link><pubDate>${hoursAgo(1).toUTCString()}</pubDate><source url="https://elsewhere.com">Elsewhere</source></item></channel></rss>`);
    expect(f.items.filter((i) => itemOnDomain(i, 'mynorthwest.com'))).toHaveLength(1);
    const c = cleanAggregatorItem(f.items[0]);
    expect(c.title).toBe('Big thing happens'); expect(c.excerpt).toBeNull();
  });
});

describe('normalization', () => {
  it('canonicalizes tracking params, host prefixes, fragments, trailing slashes', () => {
    const a = canonicalizeUrl('http://www.Example.com/story/?utm_source=x&id=2&fbclid=z#frag');
    expect(a).toBe('https://example.com/story?id=2');
    expect(canonicalizeUrl('https://example.com/story?id=2')).toBe(a);
    expect(canonicalizeUrl('https://m.example.com/story/amp?id=2')).toBe(a);
  });
  it('normalizes titles', () => { expect(normalizeTitle('Café “Fire” — Update!')).toBe('cafe fire update'); });
  it('never fabricates summaries: headline-only items get no summary text', () => {
    expect(sentencesFallback(null, 'Headline')).toEqual({ text: null, kind: 'headline' });
    expect(sentencesFallback('short', 'Headline').kind).toBe('headline');
    const r = sentencesFallback('First sentence is here and long enough. Second sentence follows it. Third one. Fourth one. Fifth one.', 'h');
    expect(r.kind).toBe('excerpt'); expect(r.text!.split('. ').length).toBeLessThanOrEqual(4);
  });
});

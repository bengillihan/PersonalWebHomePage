import type { DB } from './db.js';

interface SeedSource { key: string; name: string; site: string; feed: string | null; kind: 'rss' | 'aggregator'; query?: string; priority: 0 | 1 | 2; local?: boolean; categories: string[] }

/**
 * Seeds are applied once per seed_key (the UNIQUE seed_key column makes this idempotent, and a
 * deleted seed is NOT resurrected because a settings marker remembers it was applied).
 * Feed health is unknown until the first real refresh validates freshness.
 */
export const SEED_SOURCES: SeedSource[] = [
  { key: 'waterlandblog', name: 'Waterland Blog', site: 'https://waterlandblog.com/', feed: 'https://waterlandblog.com/feed/', kind: 'rss', priority: 2, local: true, categories: ['Local'] },
  // mynorthwest.com/feed/ answers 403 to non-browser clients; we do not spoof a browser. Use the labeled aggregator.
  { key: 'mynorthwest', name: 'MyNorthwest', site: 'https://mynorthwest.com/', feed: null, kind: 'aggregator', query: 'site:mynorthwest.com', priority: 1, local: true, categories: ['Local', 'Regional'] },
  // CNN's legacy RSS feeds are frozen (2018). Google News ignores path restrictions (site:cnn.com/business returned 2021 items),
  // so this is the cnn.com domain filtered by the keyword "business" - labeled as such in the UI, not the real /business section.
  { key: 'cnn-business', name: 'CNN Business', site: 'https://www.cnn.com/business', feed: null, kind: 'aggregator', query: 'site:cnn.com business', priority: 1, categories: ['Business'] },
  { key: 'bbc-news', name: 'BBC News', site: 'https://www.bbc.com/news', feed: 'https://feeds.bbci.co.uk/news/rss.xml', kind: 'rss', priority: 1, categories: ['World'] },
];

export const SEED_WATCHLIST = [
  { key: 'vtwax', symbol: 'VTWAX', name: 'Vanguard Total World Stock Index Admiral', type: 'mutual_fund' },
  { key: 'vtsax', symbol: 'VTSAX', name: 'Vanguard Total Stock Market Index Admiral', type: 'mutual_fund' },
  { key: 'vwiux', symbol: 'VWIUX', name: 'Vanguard Intermediate-Term Tax-Exempt Admiral', type: 'mutual_fund' },
  { key: 'vmfxx', symbol: 'VMFXX', name: 'Vanguard Federal Money Market Investor', type: 'mutual_fund' },
  { key: 'spx', symbol: 'SPX', name: 'S&P 500', type: 'index' },
  { key: 'ixic', symbol: 'IXIC', name: 'NASDAQ Composite', type: 'index' },
] as const;

/**
 * Hard exclusions seeded once (like the other seeds, a deleted one is not resurrected). Keywords are whole words/phrases. Nicknames that are also
 * ordinary words or other teams (Kraken the crypto exchange, Jets, Rangers, Flames, Panthers, Kings, Ducks, Capitals...) and teams named like weather or wildlife (Colorado Avalanche, Florida Panthers, Carolina Hurricanes) are NOT listed are NOT listed
 * alone; those teams are matched by full name, so unrelated stories are not swept up.
 */
export const SEED_BLOCKED = [
  { key: 'hockey', name: 'Hockey / NHL', description: 'Hockey and NHL news: games, scores, trades, players, teams and hockey commentary',
    keywords: ['hockey', 'nhl', 'ahl', 'stanley cup', 'nhl draft', 'penalty kill', 'goaltender', 'puck', 'seattle kraken', 'vancouver canucks', 'canucks', 'boston bruins',
      'toronto maple leafs', 'maple leafs', 'montreal canadiens', 'canadiens', 'chicago blackhawks', 'blackhawks', 'detroit red wings', 'red wings', 'vegas golden knights',
      'edmonton oilers', 'oilers', 'calgary flames', 'nashville predators', 'buffalo sabres', 'columbus blue jackets', 'philadelphia flyers', 'new york islanders',
      'winnipeg jets', 'washington capitals', 'tampa bay lightning', 'ottawa senators', 'new jersey devils', 'san jose sharks', 'minnesota wild',
      'dallas stars', 'st. louis blues', 'anaheim ducks', 'los angeles kings', 'new york rangers', 'pittsburgh penguins',
      'utah hockey club', 'utah mammoth'] },
] as const;

export function seedDefaults(db: DB): void {
  const marker = db.prepare('SELECT 1 FROM application_settings WHERE key = ?');
  const mark = db.prepare('INSERT OR IGNORE INTO application_settings (key, value) VALUES (?, ?)');
  const now = Date.now();
  db.transaction(() => {
    for (const s of SEED_SOURCES) {
      const mk = `seeded:source:${s.key}`;
      if (marker.get(mk)) continue;
      db.prepare(`INSERT OR IGNORE INTO sources (name, site_url, feed_url, kind, aggregator_query, priority, is_local, categories, seed_key, created_at)
                  VALUES (?,?,?,?,?,?,?,?,?,?)`).run(s.name, s.site, s.feed, s.kind, s.query ?? null, s.priority, s.local ? 1 : 0, JSON.stringify(s.categories), s.key, now);
      mark.run(mk, '1');
    }
    let pos = 0;
    for (const w of SEED_WATCHLIST) {
      pos++;
      const mk = `seeded:watch:${w.key}`;
      if (marker.get(mk)) continue;
      db.prepare('INSERT OR IGNORE INTO watchlist (symbol, name, instrument_type, position, seed_key) VALUES (?,?,?,?,?)').run(w.symbol, w.name, w.type, pos, w.key);
      mark.run(mk, '1');
    }
    for (const b of SEED_BLOCKED) {
      const mk = `seeded:blocked:${b.key}`;
      if (marker.get(mk)) continue;
      db.prepare('INSERT OR IGNORE INTO blocked_topics (name, description, keywords, categories, enabled, seed_key, created_at) VALUES (?,?,?,?,1,?,?)').run(b.name, b.description, JSON.stringify(b.keywords), '[]', b.key, now);
      mark.run(mk, '1');
    }
  })();
}

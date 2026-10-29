import type { DB } from './db.js';
import { priorityForWeight, reindexTopics } from './news/topics.js';

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

interface SeedInterest { key: string; name: string; weight: 1 | 2 | 3 | 4 | 5; stance?: 'prefer' | 'less'; include: string[] }
/**
 * Starting interest profile (editable in Settings; applied once per key, never over an existing interest of the same name, and a deleted one is not
 * resurrected). Matching is by whole words/phrases only, so descriptions are left empty on purpose: loose description-word overlap would match generic words.
 * Ambiguous names are qualified ("des moines wa", "kent wa") so they do not sweep in Iowa or Kent State. 'less' topics are shown less often and never hide anything.
 */
export const SEED_INTERESTS: SeedInterest[] = [
  { key: 'ai-tech', name: 'AI and technology', weight: 5, include: ['ai', 'llm', 'llms', 'large language model', 'local inference', 'on device ai', 'ai hardware', 'nvidia', 'apple silicon', 'ai coding', 'coding agent', 'openai', 'anthropic', 'claude', 'gemini', 'gpu', 'cybersecurity', 'ransomware', 'zero day', 'data breach', 'semiconductor', 'open source', 'kubernetes', 'software development', 'benchmark'] },
  { key: 'investing', name: 'Investing and economics', weight: 5, include: ['federal reserve', 'interest rates', 'rate cut', 'inflation', 'monetary policy', 'index fund', 'index investing', 'emerging markets', 'treasury yields', 'retirement', '401k', 'roth ira', 'social security', 'tax policy', 'tax law', 'cpi', 'gdp', 'jobs report', 'recession', 'etf', 'vanguard', 'tariffs'] },
  { key: 'local-wa', name: 'Local and Washington state', weight: 5, include: ['washington state', 'king county', 'south king county', 'des moines wa', 'des moines washington', 'kent wa', 'kent washington', 'city of kent', 'seatac', 'sea tac', 'burien', 'federal way', 'renton', 'seattle', 'tacoma', 'puget sound', 'sound transit', 'wsdot', 'olympia'] },
  { key: 'business-energy', name: 'Business, energy and industry', weight: 4, include: ['manufacturing', 'industrial distribution', 'battery', 'batteries', 'energy storage', 'backup power', 'grid reliability', 'power grid', 'electrical infrastructure', 'data center', 'data centers', 'supply chain', 'microgrid', 'transformer shortage'] },
  { key: 'major-news', name: 'Major national and international news', weight: 4, include: ['election', 'ceasefire', 'summit', 'sanctions', 'supreme court', 'congress', 'white house', 'nato', 'united nations', 'invasion', 'prime minister'] },
  { key: 'automobiles', name: 'Automobiles', weight: 4, include: ['bmw', 'e91', '3 series', 'vw gti', 'volkswagen gti', 'golf gti', 'toyota 4runner', '4runner', 'electric vehicle', 'electric vehicles', 'ev conversion', 'used car', 'used cars', 'car reliability'] },
  { key: 'travel-hiking', name: 'Travel and hiking', weight: 3, include: ['hiking', 'backpacking', 'mount rainier', 'pacific crest trail', 'pct', 'john muir trail', 'south korea', 'iceland', 'ireland', 'national park', 'trailhead', 'thru hike'] },
  { key: 'health-fitness', name: 'Health and fitness', weight: 3, include: ['exercise science', 'swimming', 'running', 'marathon', 'resistance training', 'strength training', 'preventive health', 'nutrition', 'healthy aging', 'longevity'] },
  { key: 'tech-careers', name: 'Technology careers and education', weight: 3, include: ['computer science', 'data analytics', 'internship', 'internships', 'tech jobs', 'tech hiring', 'tech layoffs', 'software engineer', 'university of washington'] },
  { key: 'bible-church', name: 'Biblical studies and church leadership', weight: 2, include: ['theology', 'biblical', 'bible', 'church leadership', 'pastor', 'evangelical', 'christianity', 'seminary'] },
  // Low-priority: shown less often, never hidden (unlike hard exclusions under "Not interested").
  { key: 'less-celebrity', name: 'Low priority: celebrity gossip', weight: 1, stance: 'less', include: ['celebrity', 'celebrities', 'kardashian', 'red carpet', 'gossip'] },
  { key: 'less-sports-scores', name: 'Low priority: minor sports scores', weight: 1, stance: 'less', include: ['final score', 'box score', 'game recap'] },
  { key: 'less-promo-ai', name: 'Low priority: promotional announcements', weight: 1, stance: 'less', include: ['sponsored', 'press release', 'prnewswire', 'businesswire', 'announces partnership'] },
  { key: 'less-clickbait', name: 'Low priority: clickbait and speculation', weight: 1, stance: 'less', include: ['you won t believe', 'this one trick', 'meme stock', 'stock picks', 'best stocks to buy', 'price prediction', 'op ed'] },
  { key: 'less-lifestyle', name: 'Low priority: repetitive lifestyle content', weight: 1, stance: 'less', include: ['lifestyle', 'wellness trends', 'morning routine'] },
];

export function seedDefaults(db: DB): void {
  const marker = db.prepare('SELECT 1 FROM application_settings WHERE key = ?');
  const mark = db.prepare('INSERT OR IGNORE INTO application_settings (key, value) VALUES (?, ?)');
  const now = Date.now();
  let addedInterests = 0;
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
    for (const t of SEED_INTERESTS) {
      const mk = `seeded:interest:${t.key}`;
      if (marker.get(mk)) continue;
      // OR IGNORE on the unique name: an interest the user already has under this name is theirs and is left exactly as it is.
      const r = db.prepare("INSERT OR IGNORE INTO topics (name, kind, description, priority, weight, stance, include_keywords, exclude_keywords, created_at) VALUES (?, 'interest', '', ?, ?, ?, ?, '[]', ?)")
        .run(t.name, priorityForWeight(t.weight), t.weight, t.stance ?? 'prefer', JSON.stringify(t.include), now);
      if (r.changes) addedInterests++;
      mark.run(mk, '1');
    }
  })();
  if (addedInterests) reindexTopics(db); // local string matching only; no AI calls
}

/** Ordered, append-only migrations. Never edit an applied migration; add a new one. */
export const MIGRATIONS: { id: number; name: string; sql: string }[] = [
  {
    id: 1,
    name: 'init',
    sql: `
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  google_sub TEXT NOT NULL UNIQUE,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  created_at INTEGER NOT NULL,
  last_login_at INTEGER NOT NULL
);
CREATE TABLE sessions (
  id_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE TABLE sources (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  site_url TEXT NOT NULL UNIQUE,
  feed_url TEXT,
  kind TEXT NOT NULL DEFAULT 'rss' CHECK (kind IN ('rss','aggregator')),
  aggregator_query TEXT,
  priority INTEGER NOT NULL DEFAULT 1 CHECK (priority IN (0,1,2)),
  enabled INTEGER NOT NULL DEFAULT 1,
  coverage TEXT NOT NULL DEFAULT 'comprehensive' CHECK (coverage IN ('comprehensive','interest')),
  categories TEXT NOT NULL DEFAULT '[]',
  is_local INTEGER NOT NULL DEFAULT 0,
  health TEXT NOT NULL DEFAULT 'unknown' CHECK (health IN ('unknown','ok','stale','error')),
  last_checked_at INTEGER,
  last_success_at INTEGER,
  last_item_at INTEGER,
  last_error TEXT,
  etag TEXT,
  last_modified TEXT,
  seed_key TEXT UNIQUE,
  created_at INTEGER NOT NULL
);

CREATE TABLE story_clusters (
  id INTEGER PRIMARY KEY,
  primary_article_id INTEGER,
  title TEXT NOT NULL,
  summary TEXT,
  summary_kind TEXT,
  differences TEXT,
  summary_hash TEXT,
  category TEXT,
  importance REAL NOT NULL DEFAULT 0.3,
  article_count INTEGER NOT NULL DEFAULT 1,
  source_count INTEGER NOT NULL DEFAULT 1,
  first_published_at INTEGER NOT NULL,
  last_published_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_clusters_last_pub ON story_clusters(last_published_at DESC, id DESC);

CREATE TABLE articles (
  id INTEGER PRIMARY KEY,
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  guid TEXT,
  url TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  canonical_hash TEXT NOT NULL UNIQUE,
  publisher TEXT NOT NULL,
  title TEXT NOT NULL,
  title_norm TEXT NOT NULL,
  excerpt TEXT,
  image_url TEXT,
  published_at INTEGER NOT NULL,
  fetched_at INTEGER NOT NULL,
  content_hash TEXT NOT NULL,
  availability TEXT NOT NULL CHECK (availability IN ('excerpt','headline_only')),
  summary TEXT,
  summary_kind TEXT CHECK (summary_kind IN ('ai','excerpt','headline')),
  ai_category TEXT,
  importance REAL,
  ai_content_hash TEXT,
  cluster_id INTEGER REFERENCES story_clusters(id) ON DELETE SET NULL,
  cluster_locked INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_articles_cluster ON articles(cluster_id);
CREATE INDEX idx_articles_source_pub ON articles(source_id, published_at DESC);
CREATE INDEX idx_articles_pub ON articles(published_at DESC);
CREATE INDEX idx_articles_needs_ai ON articles(ai_content_hash) WHERE summary_kind IS NOT 'ai';

CREATE TABLE cluster_articles (
  cluster_id INTEGER NOT NULL REFERENCES story_clusters(id) ON DELETE CASCADE,
  article_id INTEGER NOT NULL UNIQUE REFERENCES articles(id) ON DELETE CASCADE,
  manual INTEGER NOT NULL DEFAULT 0,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (cluster_id, article_id)
);

CREATE TABLE topics (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL DEFAULT 'interest' CHECK (kind IN ('category','interest')),
  description TEXT NOT NULL DEFAULT '',
  priority INTEGER NOT NULL DEFAULT 1 CHECK (priority IN (0,1,2)),
  include_keywords TEXT NOT NULL DEFAULT '[]',
  exclude_keywords TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);
CREATE TABLE article_topics (
  article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  topic_id INTEGER NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  score REAL NOT NULL,
  PRIMARY KEY (article_id, topic_id)
);

CREATE TABLE feedback (
  cluster_id INTEGER PRIMARY KEY REFERENCES story_clusters(id) ON DELETE CASCADE,
  rating INTEGER NOT NULL CHECK (rating IN (-1,1)),
  reason TEXT CHECK (reason IN ('topic','already_knew','low_importance','source','duplicate')),
  category TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE feedback_sources (
  cluster_id INTEGER NOT NULL REFERENCES story_clusters(id) ON DELETE CASCADE,
  source_id INTEGER NOT NULL,
  PRIMARY KEY (cluster_id, source_id)
);
CREATE TABLE reading_state (
  cluster_id INTEGER PRIMARY KEY REFERENCES story_clusters(id) ON DELETE CASCADE,
  read_at INTEGER,
  hidden_at INTEGER
);
CREATE TABLE bookmarks (
  cluster_id INTEGER PRIMARY KEY REFERENCES story_clusters(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

CREATE TABLE watchlist (
  id INTEGER PRIMARY KEY,
  symbol TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  instrument_type TEXT NOT NULL CHECK (instrument_type IN ('equity','etf','mutual_fund','index')),
  provider_symbol TEXT,
  position INTEGER NOT NULL DEFAULT 0,
  seed_key TEXT UNIQUE
);
CREATE TABLE market_prices (
  symbol TEXT NOT NULL,
  range TEXT NOT NULL,
  fetched_at INTEGER NOT NULL,
  last_value REAL,
  change_abs REAL,
  change_pct REAL,
  as_of TEXT,
  is_daily_nav INTEGER NOT NULL DEFAULT 0,
  series TEXT,
  error TEXT,
  PRIMARY KEY (symbol, range)
);

CREATE TABLE processing_jobs (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running','ok','error')),
  trigger TEXT,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  stats TEXT,
  error TEXT
);
CREATE INDEX idx_jobs_started ON processing_jobs(started_at DESC);

CREATE TABLE application_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE ai_cache (
  cache_key TEXT PRIMARY KEY,
  task TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  response TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE ai_usage (
  day TEXT PRIMARY KEY,
  requests INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  errors INTEGER NOT NULL DEFAULT 0
);
`,
  },
  {
    id: 2,
    name: 'article_sources',
    // Which feeds carried each article. articles.source_id stays the feed that first discovered it (with articles.publisher as the
    // originating publisher); this table additionally records every other feed that supplied the same canonical URL.
    sql: `
CREATE TABLE article_sources (
  article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  source_id INTEGER NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  first_seen_at INTEGER NOT NULL,
  PRIMARY KEY (article_id, source_id)
) WITHOUT ROWID;
CREATE INDEX idx_article_sources_source ON article_sources(source_id);
INSERT INTO article_sources (article_id, source_id, first_seen_at) SELECT id, source_id, fetched_at FROM articles;
`,
  },
  {
    id: 3,
    name: 'article_blocked',
    // 1 when the article's text hits one of the user's exclude keywords. Maintained locally (no AI) whenever interests change or an
    // article is ingested; interest-only sources never surface blocked articles.
    sql: 'ALTER TABLE articles ADD COLUMN blocked INTEGER NOT NULL DEFAULT 0;',
  },
  {
    id: 4,
    name: 'source_freshness_hours',
    // Per-source override of how long a feed may go without a new article before it is 'stale' (NULL = default: 24h major, 72h local).
    sql: 'ALTER TABLE sources ADD COLUMN freshness_hours INTEGER CHECK (freshness_hours IS NULL OR freshness_hours BETWEEN 1 AND 336);',
  },
  {
    id: 5,
    name: 'blocked_topics',
    // Hard exclusions ("Not interested"), kept separate from soft thumbs-down feedback. article_blocks holds, per article, which topics match it
    // (computed locally from keywords/classifications). Whether a topic applies is read from blocked_topics.enabled at query time, so toggling a
    // topic takes effect instantly; articles are never deleted.
    sql: `
CREATE TABLE blocked_topics (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  keywords TEXT NOT NULL DEFAULT '[]',
  categories TEXT NOT NULL DEFAULT '[]',
  enabled INTEGER NOT NULL DEFAULT 1,
  seed_key TEXT UNIQUE,
  created_at INTEGER NOT NULL
);
CREATE TABLE article_blocks (
  article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  topic_id INTEGER NOT NULL REFERENCES blocked_topics(id) ON DELETE CASCADE,
  PRIMARY KEY (article_id, topic_id)
) WITHOUT ROWID;
CREATE INDEX idx_article_blocks_topic ON article_blocks(topic_id);
`,
  },
  {
    id: 6,
    name: 'ai_usage_completed',
    // Gemini budget accounting: requests = reserved BEFORE sending (the limit counts attempts), completed = the provider answered with usable output,
    // errors = failed or unusable. requests - completed - errors = still in flight, or lost to a restart (never refunded).
    sql: `
ALTER TABLE ai_usage ADD COLUMN completed INTEGER NOT NULL DEFAULT 0;
UPDATE ai_usage SET completed = MAX(requests - errors, 0);
`,
  },
  {
    id: 7,
    name: 'topic_weight_and_stance',
    // Interests get a 1-5 weight (NULL = derive from the legacy 3-level priority, so existing rows rank exactly as before) and a stance:
    // 'less' marks a low-priority topic that is shown less often. It never hides anything (hard exclusions are blocked_topics).
    sql: `
ALTER TABLE topics ADD COLUMN weight INTEGER CHECK (weight IS NULL OR weight BETWEEN 1 AND 5);
ALTER TABLE topics ADD COLUMN stance TEXT NOT NULL DEFAULT 'prefer' CHECK (stance IN ('prefer','less'));
`,
  },
  {
    id: 8,
    name: 'story_substantive_version',
    // Read state is judged against the story's SUBSTANTIVE version, not against updated_at (which moves whenever any coverage joins). NULL = no
    // substantive development has ever been recorded, so a read story stays read. Additive and nullable: no existing row is rewritten.
    sql: `
ALTER TABLE story_clusters ADD COLUMN substantive_at INTEGER;
`,
  },
  {
    id: 9,
    name: 'free_coverage_access',
    // "Prefer free coverage": a per-source access setting (default 'unknown' = no opinion, so nothing changes for existing sources) and optional EXPLICIT
    // per-article access from feed metadata (NULL = not stated; it is never inferred). Both additive.
    sql: `
ALTER TABLE sources ADD COLUMN access TEXT NOT NULL DEFAULT 'unknown' CHECK (access IN ('free','metered','paywalled','unknown'));
ALTER TABLE articles ADD COLUMN access TEXT CHECK (access IS NULL OR access IN ('free','metered','paywalled'));
`,
  },
  {
    id: 10,
    name: 'novelty_checks',
    // Durable "is this a new development?" questions that the local checks could not settle. The comparison baseline is FROZEN at creation (so a retry never
    // compares an article with itself), and a check is tied to the article's content hash, so a corrected article is a different question. Rows leave with
    // their article or story (cascade); other changes mark them 'expired'. Additive.
    sql: `
CREATE TABLE novelty_checks (
  id INTEGER PRIMARY KEY,
  article_id INTEGER NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  cluster_id INTEGER NOT NULL REFERENCES story_clusters(id) ON DELETE CASCADE,
  article_hash TEXT NOT NULL,
  baseline TEXT NOT NULL,
  baseline_hash TEXT NOT NULL,
  event_at INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','done','failed','expired')),
  verdict INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (article_id, article_hash)
);
CREATE INDEX idx_novelty_checks_pending ON novelty_checks(status, next_attempt_at);
`,
  },
  {
    id: 11,
    name: 'domain_access',
    // What an automatic check of a publisher's own article pages found about access, one row per domain (no Gemini, no per-article state). It is only an
    // ESTIMATE: it ranks below an article's own feed metadata and below a source's access setting. Additive.
    sql: `
CREATE TABLE domain_access (
  domain TEXT PRIMARY KEY,
  level TEXT NOT NULL CHECK (level IN ('free','metered','paywalled','unknown')),
  evidence TEXT NOT NULL DEFAULT '',
  pages_checked INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  checked_at INTEGER NOT NULL,
  next_check_at INTEGER NOT NULL
);
CREATE INDEX idx_domain_access_due ON domain_access(next_check_at);
`,
  },
];

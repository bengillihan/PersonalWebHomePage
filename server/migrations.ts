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
];

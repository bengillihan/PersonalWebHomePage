# Personal News & Market Dashboard

A private, single-user news reader and market watchlist. One Node service (Fastify + React/Vite/Tailwind + SQLite), built to be cheap on Railway and to sleep when idle.

* **News**: RSS/Atom (publisher feeds first), exact de-duplication, same-event clustering ("See coverage from N sources"), optional Gemini summaries/classification, transparent ranking with "Why am I seeing this?".
* **Markets**: editable watchlist, daily NAV for mutual funds (never faked as intraday), 1D/1W/1M/YTD/1Y.
* **Private**: Google sign-in restricted to one email; everything under `/api` requires a server-side session.
* **No background polling**: data refreshes only when you open the app and the cache is >60 min old (or you press Refresh). Nothing runs on a timer, so Railway Serverless can sleep the service.

## Quick start (local)

Requires Node 22+ (developed on Node 25; `engines` is `>=22`).

```bash
npm install
cp .env.example .env        # fill in values (see below)
npm run dev                 # API on :3000 + Vite on http://localhost:5173
```

Local sign-in without Google credentials: set `DEV_LOGIN=true` in `.env`, then open `http://localhost:5173` and use the "Dev login" link. This is ignored when `NODE_ENV=production`.

Production build/start (what Railway runs):

```bash
npm run build && npm start          # serves API + static UI on $PORT (0.0.0.0 in production)
npm run check                       # typecheck + lint + tests + build
```

## Environment variables

See `.env.example` for the full annotated list.

| Variable | Required | Purpose |
|---|---|---|
| `SESSION_SECRET` | yes | ≥32 random chars (`openssl rand -base64 48`). Signs the login cookie and keys session hashes. |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | yes | Google OAuth web client. |
| `ALLOWED_GOOGLE_EMAIL` | yes | The only account allowed in (checked on every request). |
| `PUBLIC_BASE_URL` | yes | Public origin, e.g. `https://your-app.up.railway.app` (no trailing slash). Production requires https. |
| `SQLITE_PATH` | no | Defaults to `/data/dashboard.sqlite` on Railway, `./data/dashboard.sqlite` locally. |
| `PORT` | no | Railway injects it. |
| `GEMINI_API_KEY`, `GEMINI_MODEL` | no | AI summaries. Default model `gemini-3.5-flash-lite`. |
| `AI_DAILY_REQUEST_BUDGET` | no | Max Gemini requests **attempted** per UTC day (default 200; `0` disables). Editable in Settings. See "What the budget counts". |
| `TWELVEDATA_API_KEY`, `MARKET_PROVIDER` | no | Market prices (see below). |
| `TWELVEDATA_CREDITS_PER_MINUTE` | no | Rolling per-minute credit allowance shared by all Twelve Data calls (default 8, the Basic plan). |
| `CRON_TOKEN` | no | Enables `POST /internal/refresh` for an optional external cron. |

## 1. Google OAuth setup (one-time, by you)

1. Open <https://console.cloud.google.com/>, create/select a project.
2. **APIs & Services → OAuth consent screen**: user type *External*, fill in app name/email. Leave it in *Testing* and add your own Google account under **Test users** (fine for personal use; no verification needed).
3. **APIs & Services → Credentials → Create credentials → OAuth client ID → Web application**.
4. **Authorized redirect URIs** (exact):
   * `http://localhost:5173/auth/callback` (local dev via Vite proxy)
   * `https://<your-railway-domain>/auth/callback`
5. Copy the client ID/secret into `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`, and set `ALLOWED_GOOGLE_EMAIL` to your address.

The flow uses authorization-code + PKCE with `state` and `nonce`; the ID token is verified (signature, audience, expiry), the email must be verified and equal the allow-listed address. Sessions are random 256-bit tokens in an HttpOnly, SameSite=Lax cookie (`__Host-` prefixed and Secure over https); only an HMAC of the token is stored. State-changing API calls need an `x-csrf-token` header plus a same-origin check.

## 2. Gemini API (optional but recommended)

Create a key in [Google AI Studio](https://aistudio.google.com/apikey) and set `GEMINI_API_KEY`. **A consumer Gemini subscription does not include API usage**; the API may need its own billing. Model IDs change, so check <https://ai.google.dev/gemini-api/docs/models> and set `GEMINI_MODEL` (default `gemini-3.5-flash-lite`, listed as stable when this was written).

What is sent: only article headline, publisher and the feed's own excerpt (as fenced, untrusted data), never your login or personal data. Results are cached by content hash + task + model + prompt version, so preference changes never re-spend calls. Quota/429 errors trigger a 15-minute backoff, and the reader keeps working with publisher excerpts or headlines. Without a key the app is fully usable, minus AI summaries/classification (importance falls back to a feed-position heuristic).

**What the budget counts.** The limit counts requests *attempted*, per **UTC** calendar day. A request is reserved in SQLite, atomically, before it is sent, so concurrent refreshes can never overspend. A reservation is never refunded once a request may have reached Google: a timeout, error, unusable answer or a restart mid-request can still have been processed and billed, so it stays counted until the daily reset. Diagnostics shows reserved, completed and failed requests separately (reserved minus completed minus failed is in flight or lost to a restart). Cache hits cost nothing.

Cost estimates in Diagnostics use list prices stored in the `ai_price` setting; check Google AI Studio for real billing.

## 3. Market data (Twelve Data)

Provider: [Twelve Data](https://twelvedata.com) (`/time_series`, one API credit per symbol per refresh). Its free "Basic" plan is 8 credits/min and 800/day and lists US equities/ETFs; **mutual-fund NAV and some index symbols appear on paid tiers**, and the free plan's exact coverage could not be verified without a key. The app therefore never invents prices: if the provider refuses a symbol you see "Not on your plan" with the provider's message, and you can map a symbol to a different provider symbol (e.g. an ETF proxy for an index) in *Settings → Watchlist*.

* Mutual funds show the latest *published daily NAV*, labelled as such. They are refetched only after the expected publication time on business days (NYSE calendar built in), so weekends/holidays cost nothing.
* Equities/ETFs/indexes refresh at most every 10 min while the US market is open, once after close.
* VMFXX (money market) shows the stable NAV and is labelled so; fund *yield* is a separate figure that is not shown or conflated.
* Swapping providers means implementing the small `MarketProvider` interface in `server/market/provider.ts`.

## News sources: what was verified (2026-10-29)

| Source | Result | How it is ingested |
|---|---|---|
| waterlandblog.com | `/feed/` is a live RSS feed | Direct RSS |
| bbc.com/news | `feeds.bbci.co.uk/news/rss.xml` live | Direct RSS |
| mynorthwest.com | `/feed/` returns **403** to non-browser clients. The app does not spoof a browser. | Labeled **Google News aggregator**, restricted to `site:mynorthwest.com`; headline-only |
| cnn.com/business | CNN's RSS feeds are frozen (newest item 2018) | Labeled **Google News aggregator**: `site:cnn.com business`. Google ignores path restrictions, so this is the cnn.com domain filtered by keyword, not the exact /business section; headline-only |

Aggregator items are domain-checked (`<source url>` must match), carry no excerpt (so no summary is invented), and link through Google News. Dead/stale feeds are flagged `stale`/`error` in Sources and Diagnostics (a feed is stale after 21 days without new items). If a publisher later offers a feed or an authorized API, edit the source; the architecture takes more sources from the UI.

## 4. Railway deployment

You perform these steps; nothing here is done automatically.

1. Push this repo to GitHub (already configured as `origin`).
2. Railway → **New Project → Deploy from GitHub repo**. Railpack builds with `npm run build` and starts `npm start` (`railway.toml`; Node is pinned via `engines`).
3. **Add a Volume** to the service, mount path **`/data`**. The app verifies this at startup: on Railway it **refuses to start** (with a clear message in the deploy logs) if `/data` is not a real mounted volume or if the database path is not inside it, so it can never silently create a disposable database. `ALLOW_EPHEMERAL_DB=true` overrides this for intentionally throwaway environments only. Settings → Diagnostics shows the database ID, creation time and volume status; if the ID or creation time changes unexpectedly, the database was replaced. Keep **one replica**: Railway does not allow replicas with volumes, and SQLite needs a single writer. If you see permission errors writing to `/data`, set `RAILWAY_RUN_UID=0` as the Railway volumes docs describe.
4. **Variables**: `SESSION_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ALLOWED_GOOGLE_EMAIL`, `PUBLIC_BASE_URL` (your generated `https://….up.railway.app`), plus optional `GEMINI_API_KEY`, `TWELVEDATA_API_KEY`. `SQLITE_PATH` can stay unset on Railway (defaults to `/data/dashboard.sqlite`).
5. **Settings → Networking → Generate Domain**, put it in `PUBLIC_BASE_URL`, and add `https://<domain>/auth/callback` to the Google OAuth client.
6. **Settings → Serverless**: enable it so the service sleeps when idle. Whether Serverless is offered for services with volumes was not stated in the Railway docs I read, so confirm it appears for your service. The first request after sleeping takes a few seconds to cold start; the app serves cached data immediately and refreshes in the background.
7. Health check path `/health` is set in `railway.toml`.

**Rollback**: Railway → Deployments → pick a previous deployment → *Rollback*. Migrations are append-only and additive; a rollback keeps working against a newer schema unless a future migration drops columns (none do). For a data rollback, restore a backup (below).

### Optional cron worker later

Not deployed. If you want refreshes while you're away, create a Railway cron service that runs `curl -fsS -X POST -H "Authorization: Bearer $CRON_TOKEN" $PUBLIC_BASE_URL/internal/refresh` and set `CRON_TOKEN` (≥32 chars) on the web service. The endpoint does not exist unless the token is set. Note this wakes the sleeping service on each call, which costs compute.

## 5. Backup and restore

SQLite lives on the Railway volume, so **keep a copy elsewhere**.

* **From the UI**: *Settings → Preferences → Download full database backup*. This streams a consistent online snapshot (SQLite backup API, safe under WAL) gzipped to your machine. A smaller *settings export* (JSON: interests, watchlist, sources, preferences, bookmarks) is also offered.
* **From a shell with DB access**: `npm run backup -- ./path/out.sqlite.gz` (runs an integrity check first).
* Railway's own volume backups can supplement these but are on the same platform.

**Restore**: stop the service (or scale to zero), `gunzip` the file, place it at `/data/dashboard.sqlite` (delete any stale `dashboard.sqlite-wal`/`-shm`), start the service. Migrations run automatically on boot. Locally: `gunzip -c backup.sqlite.gz > data/dashboard.sqlite`. This restore path is covered by an automated test.

## Operations & resource monitoring

* **Diagnostics** (Settings → Diagnostics): source health, last ingestion jobs, article/cluster counts, AI usage and estimated cost, DB + WAL size, cache freshness, process RSS.
* Measured locally (macOS, Node 25, four seeded sources, 266 articles after the first refresh, no AI/market keys): RSS was ≈ **51 MB** about 50 s after startup+refresh and ≈ **87 MB** after additional requests and a manual refresh; a refresh took ≈ 0.6 s. This is below the 75–150 MB target locally, but Railway numbers will differ (Node version, container), and AI/market calls were not exercised, so check *Railway → Metrics* for real memory/CPU and cost.
* Retention: 90 days by default (Settings); bookmarked or rated stories are kept. Old sessions, jobs and AI cache are pruned daily when a refresh runs.
* Costs outside Railway: Gemini API (usage-based), Twelve Data (free tier or paid plan), nothing else.
* Logs are structured JSON (pino) with cookies/CSRF headers redacted.

## Architecture notes

```
server/  config, db(+migrations, WAL), seed, auth (Google OIDC, sessions, CSRF)
  net/safeFetch.ts   SSRF-safe fetch (IP checked at connect time, redirect re-validation, size/time caps)
  news/              feed parse+freshness, discovery, ingest (SWR coordinator), cluster, rank, topics, query
  ai/gemini.ts       structured JSON, zod validation, cache, budget, backoff
  market/            provider adapter, NYSE schedule, service
  routes/api.ts      private API   |   app.ts  Fastify wiring, static UI
web/     React + Tailwind UI (charts lazy-loaded)
tests/   vitest (100 tests): security, parsing, ingestion, clustering, ranking, API/auth, Gemini mocks, market, DB
```

Ranking: interests 35 %, importance 25 %, recency 20 %, source preference 10 %, feedback 10 % (all editable). "For You" targets 60 % personalized / 25 % major / 15 % local-or-preferred via a deficit interleave; an empty bucket never gets filler. Thumbs-down reasons are kept separate: *topic* adjusts category affinity, *source* adjusts publisher quality, others affect neither. *Explore* shows stories outside your usual interests.

## Known limitations

* Aggregator-sourced stories (MyNorthwest, CNN) are headline-only with Google News links.
* Without AI, importance is a feed-position heuristic and clusters rely on local similarity only.
* Search is substring matching (fine at this scale; FTS5 would be the next step).
* Single user, single instance by design.

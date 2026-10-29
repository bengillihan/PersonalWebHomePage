# Implementation checklist

- [x] 1. Scaffold (TS, Vite/React/Tailwind, Fastify, better-sqlite3, vitest, eslint)
- [x] 2. Config, SQLite (WAL, migrations), seeds
- [x] 3. Security: SSRF-safe fetch, Google OIDC, sessions, CSRF, rate limits
- [x] 4. News: feed parse/discovery/freshness, ingest, dedupe, clustering, retention
- [x] 5. Gemini: structured output, cache, budget, fallbacks
- [x] 6. Ranking/personalization, feedback, feed API w/ pagination
- [x] 7. Market: Twelve Data adapter, schedule-aware cache, watchlist
- [x] 8. Stale-while-revalidate refresh coordinator (no background polling)
- [x] 9. Frontend (feed, tabs, search, settings, diagnostics, charts lazy)
- [x] 10. Tests, lint, typecheck, build; measure idle memory
- [x] 11. README, .env.example, railway.toml, backup script

Decisions (verified 2026-10-29): Node >=22; better-sqlite3 (loads on Node 25, engines >=22);
default model `gemini-3.5-flash-lite` (stable per ai.google.dev/models); Twelve Data for market
data (mutual-fund NAV is a paid tier there; the UI shows an honest "unavailable" state otherwise).
Feed probe: waterlandblog /feed/ OK, BBC OK, CNN's legacy RSS is dead (2018) and mynorthwest.com/feed
returns 403 to non-browser clients -> both use a labeled Google News RSS aggregator adapter.

## Status
All items implemented. Not verified: live Gemini calls and live Twelve Data calls (no keys available), real Google sign-in (no credentials), Railway deployment, and browser rendering of the UI (typechecked and built, not opened in a browser).

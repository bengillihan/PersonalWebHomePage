import { loadConfig, validateConfig } from './config.js';
import { openDb } from './db.js';
import { seedDefaults } from './seed.js';
import { buildApp } from './app.js';

const cfg = loadConfig();
const problems = validateConfig(cfg);
if (problems.length) {
  console.error('Configuration problems:\n - ' + problems.join('\n - '));
  if (cfg.isProd) process.exit(1);
  console.error('(continuing in development; sign-in will not work until these are fixed)');
}

const db = openDb(cfg.sqlitePath);
seedDefaults(db);
const { app } = await buildApp(cfg, db, { oidc: problems.length && !cfg.devLogin ? null : undefined });

let closing = false;
async function shutdown(signal: string) {
  if (closing) return; closing = true;
  app.log.info({ signal }, 'shutting down');
  const force = setTimeout(() => process.exit(1), 8000); force.unref();
  try { await app.close(); db.pragma('wal_checkpoint(TRUNCATE)'); db.close(); } finally { process.exit(0); }
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('unhandledRejection', (e) => app.log.error({ err: String((e as Error)?.message ?? e) }, 'unhandled rejection'));

await app.listen({ port: cfg.port, host: cfg.host });
app.log.info({ db: cfg.sqlitePath, model: cfg.geminiModel, ai: Boolean(cfg.geminiApiKey), market: Boolean(cfg.twelveDataKey) }, 'ready');

import { loadConfig, validateConfig } from './config.js';
import { openDb } from './db.js';
import { seedDefaults } from './seed.js';
import { ensureTopicIndex } from './news/topics.js';
import { ensureBlockIndex } from './news/blocking.js';
import { buildApp } from './app.js';
import { checkPersistence, databaseFileExists, ensureDbIdentity, formatRefusal } from './storage.js';

const cfg = loadConfig();
const problems = validateConfig(cfg);
if (problems.length) {
  console.error('Configuration problems:\n - ' + problems.join('\n - '));
  if (cfg.isProd) process.exit(1);
  console.error('(continuing in development; sign-in will not work until these are fixed)');
}

// On Railway the database must be on the mounted volume. Verified BEFORE the file is opened, so a missing volume can never lead to a
// silently created, disposable production database.
const persistence = checkPersistence({ sqlitePath: cfg.sqlitePath, required: cfg.onRailway, allowEphemeral: cfg.allowEphemeralDb, volumePath: cfg.persistentVolumePath });
if (!persistence.ok) { console.error(formatRefusal(persistence, cfg.sqlitePath)); process.exit(1); }

const existedBefore = databaseFileExists(cfg.sqlitePath);
const db = openDb(cfg.sqlitePath);
const { identity, status: dbStatus } = ensureDbIdentity(db, existedBefore);
seedDefaults(db);
ensureTopicIndex(db);
ensureBlockIndex(db); // matches the seeded/blocked topics against articles already stored (one time)
const { app } = await buildApp(cfg, db, { persistence, oidc: problems.length && !cfg.devLogin ? null : undefined });

const dbInfo = { databaseId: identity.id, path: cfg.sqlitePath, createdAt: new Date(identity.createdAt).toISOString() };
if (dbStatus === 'created') app.log.warn(dbInfo, '*** NEW DATABASE CREATED *** If this is not your very first deploy, your previous data was NOT found at this path.');
else if (dbStatus === 'adopted') app.log.info(dbInfo, 'Existing database adopted: assigned a persistent id (no data changed)');
else app.log.info(dbInfo, 'Existing database opened');
if (persistence.overridden) app.log.warn({ code: persistence.code }, 'ALLOW_EPHEMERAL_DB=true: database is NOT on verified persistent storage; data will be lost on redeploy');
else if (persistence.verified) app.log.info({ mountPoint: persistence.mountPoint, fsType: persistence.fsType }, 'Persistent volume verified');

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

/**
 * Consistent online backup of the SQLite database (safe while the app is running, WAL-aware).
 * Usage: npm run backup -- [output-file]   (default: ./backups/dashboard-<timestamp>.sqlite.gz)
 * The output must NOT live only on the same Railway volume; copy it somewhere else (see README).
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import Database from 'better-sqlite3';
import { loadConfig } from '../server/config.js';

const cfg = loadConfig();
if (!fs.existsSync(cfg.sqlitePath)) { console.error(`Database not found at ${cfg.sqlitePath}`); process.exit(1); }
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const out = path.resolve(process.argv[2] ?? `./backups/dashboard-${stamp}.sqlite.gz`);
fs.mkdirSync(path.dirname(out), { recursive: true });
const tmp = out.replace(/\.gz$/, '') + '.tmp';

const db = new Database(cfg.sqlitePath, { readonly: true, fileMustExist: true });
await db.backup(tmp);
db.close();

const check = new Database(tmp, { readonly: true });
const ok = check.pragma('integrity_check', { simple: true });
check.close();
if (ok !== 'ok') { fs.rmSync(tmp); console.error('Integrity check failed:', ok); process.exit(1); }

await pipeline(fs.createReadStream(tmp), zlib.createGzip({ level: 9 }), fs.createWriteStream(out));
fs.rmSync(tmp);
console.log(`Backup written: ${out} (${(fs.statSync(out).size / 1024).toFixed(0)} KB, integrity ok)`);

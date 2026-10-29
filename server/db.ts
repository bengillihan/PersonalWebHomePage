import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { MIGRATIONS } from './migrations.js';

export type DB = Database.Database;

export function openDb(file: string): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('cache_size = -8000'); // ~8MB page cache
  db.pragma('wal_autocheckpoint = 500');
  migrate(db);
  return db;
}

export function migrate(db: DB): number[] {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)');
  const done = new Set((db.prepare('SELECT id FROM schema_migrations').all() as { id: number }[]).map((r) => r.id));
  const applied: number[] = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (id, name, applied_at) VALUES (?,?,?)').run(m.id, m.name, Date.now());
    })();
    applied.push(m.id);
  }
  return applied;
}

export function getSetting<T>(db: DB, key: string, fallback: T): T {
  const row = db.prepare('SELECT value FROM application_settings WHERE key = ?').get(key) as { value: string } | undefined;
  if (!row) return fallback;
  try { return JSON.parse(row.value) as T; } catch { return fallback; }
}

export function setSetting(db: DB, key: string, value: unknown): void {
  db.prepare('INSERT INTO application_settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value));
}

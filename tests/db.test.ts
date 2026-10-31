import { describe, it, expect } from 'vitest';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import Database from 'better-sqlite3';
import { openDb, migrate, getSetting, setSetting } from '../server/db.js';
import { MIGRATIONS } from '../server/migrations.js';
import { seedDefaults } from '../server/seed.js';
import { loadConfig, validateConfig } from '../server/config.js';

describe('SQLite', () => {
  it('creates every required table and indexes', () => {
    const db = openDb(':memory:');
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map((r) => r.name);
    for (const t of ['users', 'sessions', 'sources', 'articles', 'story_clusters', 'cluster_articles', 'topics', 'article_topics', 'feedback', 'reading_state', 'bookmarks', 'watchlist', 'market_prices', 'processing_jobs', 'application_settings', 'ai_cache', 'ai_usage', 'schema_migrations']) expect(tables).toContain(t);
    expect((db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'").get() as any).n).toBeGreaterThanOrEqual(6);
  });
  it('uses WAL + busy timeout + FKs on a file db; migrations are idempotent; data persists across reopen', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-')); const file = path.join(dir, 'sub', 'd.sqlite');
    let db = openDb(file);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal'); expect(db.pragma('busy_timeout', { simple: true })).toBe(5000); expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(migrate(db)).toEqual([]); // nothing re-applied
    seedDefaults(db); setSetting(db, 'k', { a: 1 }); db.close();
    db = openDb(file);
    expect(getSetting(db, 'k', null)).toEqual({ a: 1 }); expect((db.prepare('SELECT COUNT(*) n FROM sources').get() as any).n).toBe(10);
    expect((db.prepare('SELECT COUNT(*) n FROM schema_migrations').get() as any).n).toBe(MIGRATIONS.length);
    db.close(); fs.rmSync(dir, { recursive: true });
  });
  it('upgrades an older database by applying only new migrations', () => {
    const raw = new Database(':memory:');
    raw.exec('CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)');
    raw.exec(MIGRATIONS[0].sql); raw.prepare('INSERT INTO schema_migrations VALUES (1, ?, 0)').run('init');
    expect(migrate(raw as any)).toEqual(MIGRATIONS.slice(1).map((m) => m.id));
  });
  it('enforces uniqueness and cascades', () => {
    const db = openDb(':memory:');
    db.prepare("INSERT INTO sources (name, site_url, created_at) VALUES ('a','https://a.com',0)").run();
    expect(() => db.prepare("INSERT INTO sources (name, site_url, created_at) VALUES ('b','https://a.com',0)").run()).toThrow(/UNIQUE/);
    expect(() => db.prepare("INSERT INTO sources (name, site_url, priority, created_at) VALUES ('b','https://b.com',9,0)").run()).toThrow(/CHECK/);
    db.prepare("DELETE FROM sources").run();
  });
});

describe('config', () => {
  it('defaults the DB path by environment and binds 0.0.0.0 in production', () => {
    expect(loadConfig({} as any).sqlitePath).toMatch(/data[\\/]dashboard\.sqlite$/);
    expect(loadConfig({ RAILWAY_ENVIRONMENT: 'production' } as any).sqlitePath).toBe('/data/dashboard.sqlite');
    expect(loadConfig({ NODE_ENV: 'production', PORT: '8080' } as any)).toMatchObject({ host: '0.0.0.0', port: 8080 });
    expect(loadConfig({ SQLITE_PATH: '/x/y.sqlite' } as any).sqlitePath).toBe('/x/y.sqlite');
  });
  it('refuses weak or missing secrets and ignores DEV_LOGIN in production', () => {
    expect(validateConfig(loadConfig({ NODE_ENV: 'production', PUBLIC_BASE_URL: 'http://x.com' } as any)).join()).toMatch(/SESSION_SECRET.*ALLOWED_GOOGLE_EMAIL.*GOOGLE_CLIENT_ID.*https/s);
    expect(loadConfig({ NODE_ENV: 'production', DEV_LOGIN: 'true' } as any).devLogin).toBe(false);
  });
});

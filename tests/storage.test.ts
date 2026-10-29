import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { memDb, testConfig } from './helpers.js';
import { loadConfig } from '../server/config.js';
import { openDb } from '../server/db.js';
import { MIGRATIONS } from '../server/migrations.js';
import { seedDefaults } from '../server/seed.js';
import { buildApp } from '../server/app.js';
import { checkPersistence, databaseFileExists, ensureDbIdentity, formatRefusal, getDbIdentity, parseMountinfo, realpathLoose, type PersistenceInput } from '../server/storage.js';
import type { OidcClient } from '../server/auth.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const mi = (...lines: string[]) => lines.join('\n');
const ROOT_FS = '22 1 8:1 / / rw,relatime shared:1 - ext4 /dev/sda1 rw';
const VOLUME = '40 22 0:35 / /data rw,relatime - ext4 /dev/sdb rw';
const input = (over: Partial<PersistenceInput> = {}): PersistenceInput => ({ sqlitePath: '/data/dashboard.sqlite', required: true, allowEphemeral: false, volumePath: '/data', ...over });
const ident = (p: string) => p;
const check = (text: string, over: Partial<PersistenceInput> = {}, realpath: (p: string) => string = ident) => checkPersistence(input(over), { readMountinfo: () => text, realpath });
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'storage-'));

describe('mountinfo parsing', () => {
  it('reads mount point and filesystem type, including optional fields and escaped spaces', () => {
    const m = parseMountinfo(mi(ROOT_FS, '99 22 0:50 / /mnt/my\\040vol rw,noatime shared:5 master:2 - xfs /dev/vdb rw', 'garbage line', ''));
    expect(m).toEqual([{ mountPoint: '/', fsType: 'ext4' }, { mountPoint: '/mnt/my vol', fsType: 'xfs' }]);
  });
});

describe('persistence verification (Railway)', () => {
  it('accepts a database on the mounted volume (including subdirectories)', () => {
    for (const p of ['/data/dashboard.sqlite', '/data/sub/dir/db.sqlite']) {
      expect(check(mi(ROOT_FS, VOLUME), { sqlitePath: p })).toMatchObject({ ok: true, verified: true, overridden: false, code: 'verified', mountPoint: '/data', fsType: 'ext4' });
    }
  });

  it('REGRESSION: a /data that is only a directory (no volume mounted) is refused, with an actionable message', () => {
    const r = check(mi(ROOT_FS)); // /data exists on the container disk but is not a mount
    expect(r).toMatchObject({ ok: false, verified: false, code: 'volume_not_mounted' });
    const text = formatRefusal(r, '/data/dashboard.sqlite');
    expect(text).toMatch(/REFUSING TO START/); expect(text).toMatch(/Attach a Volume to THIS service with Mount Path exactly \/data/); expect(text).toMatch(/ALLOW_EPHEMERAL_DB=true/); expect(text).toMatch(/\/data\/dashboard\.sqlite/);
  });

  it('refuses a memory-backed mount at /data', () => {
    expect(check(mi(ROOT_FS, '40 22 0:35 / /data rw - tmpfs tmpfs rw'))).toMatchObject({ ok: false, code: 'ephemeral_filesystem', fsType: 'tmpfs' });
  });

  it('refuses a database path outside the volume, including prefix look-alikes and ".." traversal', () => {
    for (const p of ['/app/data/dashboard.sqlite', '/tmp/dashboard.sqlite', '/datafoo/dashboard.sqlite', '/data/../tmp/dashboard.sqlite', './data/dashboard.sqlite']) {
      expect(check(mi(ROOT_FS, VOLUME), { sqlitePath: p }), p).toMatchObject({ ok: false, code: 'path_outside_volume' });
    }
  });

  it('refuses a database on a different mount nested inside the volume', () => {
    const text = mi(ROOT_FS, VOLUME, '50 40 0:50 / /data/cache rw - tmpfs tmpfs rw');
    expect(check(text, { sqlitePath: '/data/cache/db.sqlite' })).toMatchObject({ ok: false, code: 'nested_mount' });
    expect(check(text, { sqlitePath: '/data/dashboard.sqlite' }).ok).toBe(true);
  });

  it('refuses when the mount table cannot be read (cannot prove persistence)', () => {
    const r = checkPersistence(input(), { readMountinfo: () => { throw new Error('ENOENT'); }, realpath: ident });
    expect(r).toMatchObject({ ok: false, code: 'cannot_verify' });
  });

  it('refuses a simulated symlink escape and names the symlink in the message', () => {
    const r = check(mi(ROOT_FS, VOLUME), { sqlitePath: '/data/link/dashboard.sqlite' }, (p) => (p.startsWith('/data/link') ? p.replace('/data/link', '/tmp/elsewhere') : p));
    expect(r).toMatchObject({ ok: false, code: 'path_outside_volume', resolvedPath: '/tmp/elsewhere/dashboard.sqlite' });
    expect(r.message).toMatch(/symbolic link/);
  });

  it('real symlinks on disk: directory link, dangling file link and a symlinked volume path', () => {
    const base = tmp(); const vol = fs.realpathSync(fs.mkdirSync(path.join(base, 'vol'), { recursive: true }) ?? path.join(base, 'vol')); const outside = path.join(base, 'outside'); fs.mkdirSync(outside);
    const mounts = mi(ROOT_FS, `40 22 0:35 / ${vol} rw - ext4 /dev/sdb rw`);
    const at = (sqlitePath: string, volumePath = vol) => checkPersistence({ sqlitePath, required: true, allowEphemeral: false, volumePath }, { readMountinfo: () => mounts });
    fs.symlinkSync(outside, path.join(vol, 'dirlink'));
    expect(at(path.join(vol, 'dirlink', 'db.sqlite'))).toMatchObject({ ok: false, code: 'path_outside_volume' }); // directory symlink out of the volume
    fs.symlinkSync(path.join(outside, 'new.sqlite'), path.join(vol, 'dangling.sqlite')); // target does not exist yet; SQLite would create it outside
    expect(at(path.join(vol, 'dangling.sqlite'))).toMatchObject({ ok: false, code: 'path_outside_volume' });
    fs.writeFileSync(path.join(outside, 'real.sqlite'), 'x'); fs.symlinkSync(path.join(outside, 'real.sqlite'), path.join(vol, 'filelink.sqlite'));
    expect(at(path.join(vol, 'filelink.sqlite'))).toMatchObject({ ok: false, code: 'path_outside_volume' }); // existing file symlinked outside
    expect(at(path.join(vol, 'db.sqlite'))).toMatchObject({ ok: true, verified: true }); // an ordinary path inside the volume is fine
    expect(at(path.join(vol, 'newdir', 'db.sqlite'))).toMatchObject({ ok: true, verified: true }); // not created yet
    fs.symlinkSync(vol, path.join(base, 'volume-alias'));
    expect(at(path.join(base, 'volume-alias', 'db.sqlite'), path.join(base, 'volume-alias'))).toMatchObject({ ok: true, verified: true }); // volume reached through a symlink still resolves to the real mount
    expect(realpathLoose(path.join(vol, 'dangling.sqlite'))).toBe(path.join(fs.realpathSync(outside), 'new.sqlite')); // follows a dangling link to where SQLite would really write
    fs.rmSync(base, { recursive: true });
  });

  it('local development needs no volume and never reads the mount table', () => {
    const read = vi.fn(() => { throw new Error('should not be read'); });
    const r = checkPersistence(input({ required: false, sqlitePath: './data/dashboard.sqlite' }), { readMountinfo: read });
    expect(r).toMatchObject({ ok: true, verified: false, code: 'not_required' }); expect(read).not.toHaveBeenCalled();
  });

  it('the ephemeral override is explicit, loud, narrow, and never off by default', () => {
    const r = check(mi(ROOT_FS), { allowEphemeral: true });
    expect(r).toMatchObject({ ok: true, overridden: true, verified: false, code: 'volume_not_mounted' }); expect(r.message).toMatch(/^OVERRIDE ALLOW_EPHEMERAL_DB=true/);
    expect(check(mi(ROOT_FS, VOLUME), { allowEphemeral: true })).toMatchObject({ ok: true, verified: true, overridden: false }); // does not mask a verified volume
    expect(loadConfig({ RAILWAY_ENVIRONMENT: 'production' } as any).allowEphemeralDb).toBe(false);
    for (const v of ['1', 'yes', 'TRUE', 'True', ' true', '']) expect(loadConfig({ ALLOW_EPHEMERAL_DB: v } as any).allowEphemeralDb, JSON.stringify(v)).toBe(false);
    expect(loadConfig({ ALLOW_EPHEMERAL_DB: 'true' } as any).allowEphemeralDb).toBe(true);
  });

  it('config: Railway detection, default volume path and database path are unchanged', () => {
    expect(loadConfig({ RAILWAY_ENVIRONMENT: 'production' } as any)).toMatchObject({ onRailway: true, persistentVolumePath: '/data', sqlitePath: '/data/dashboard.sqlite' });
    expect(loadConfig({ RAILWAY_PROJECT_ID: 'p' } as any).onRailway).toBe(true);
    expect(loadConfig({} as any)).toMatchObject({ onRailway: false }); expect(loadConfig({ PERSISTENT_VOLUME_PATH: '/vol' } as any).persistentVolumePath).toBe('/vol');
  });
});

describe('database identity', () => {
  it('a fresh database gets a persistent id and creation time; later calls return the same ones', () => {
    const db = memDb(); const before = Date.now();
    const a = ensureDbIdentity(db, false);
    expect(a.status).toBe('created'); expect(a.identity.id).toMatch(/^[0-9a-f-]{36}$/); expect(a.identity.createdAt).toBeGreaterThanOrEqual(before); expect(a.identity.origin).toBe('created');
    expect(ensureDbIdentity(db, true)).toEqual({ identity: a.identity, status: 'existing' }); expect(getDbIdentity(db)).toEqual(a.identity);
  });

  it('survives closing and reopening the database file', () => {
    const dir = tmp(); const file = path.join(dir, 'd.sqlite');
    expect(databaseFileExists(file)).toBe(false);
    const existed1 = databaseFileExists(file); // like startup: asked BEFORE the file is opened
    let db = openDb(file); const first = ensureDbIdentity(db, existed1); db.close();
    expect(first.status).toBe('created'); expect(databaseFileExists(file)).toBe(true);
    const existed2 = databaseFileExists(file);
    db = openDb(file); const again = ensureDbIdentity(db, existed2); db.close();
    expect(again).toEqual({ identity: first.identity, status: 'existing' });
    fs.writeFileSync(path.join(dir, 'empty.sqlite'), ''); expect(databaseFileExists(path.join(dir, 'empty.sqlite'))).toBe(false); // an empty file is a new database
    fs.rmSync(dir, { recursive: true });
  });

  it('an existing production database is adopted, not mislabelled as new; its data and migrations 1-4 are untouched', () => {
    const dir = tmp(); const file = path.join(dir, 'prod.sqlite');
    let db = openDb(file); seedDefaults(db); db.prepare('UPDATE sources SET created_at = 1000 WHERE id = 1').run(); db.prepare('UPDATE sources SET created_at = 5000 WHERE id > 1').run();
    const tables = () => (db.prepare('SELECT name FROM sqlite_master ORDER BY name').all() as any[]).map((r) => r.name).join(',');
    const snapshot = () => JSON.stringify([db.prepare('SELECT * FROM sources').all(), db.prepare('SELECT * FROM watchlist').all(), db.prepare('SELECT * FROM schema_migrations').all(),
      db.prepare("SELECT * FROM application_settings WHERE key != 'database_identity'").all()]);
    const before = { tables: tables(), snap: snapshot() }; db.close(); db = openDb(file);
    const r = ensureDbIdentity(db, true);
    expect(r.status).toBe('adopted'); expect(r.identity).toMatchObject({ origin: 'adopted', createdAt: 1000 });
    expect(tables()).toBe(before.tables); expect(snapshot()).toBe(before.snap); // no schema or data change besides the identity setting
    expect((db.prepare('SELECT COUNT(*) n FROM schema_migrations').get() as any).n).toBe(MIGRATIONS.length);
    db.close(); fs.rmSync(dir, { recursive: true });
  });
});

describe('Diagnostics exposes database identity and persistence status (and no secrets)', () => {
  const oidc: OidcClient & { nonce?: string } = { authUrl: ({ state, nonce }) => `https://x/?state=${state}&nonce=${nonce}`, async exchange() { return { sub: 's', email: 'me@example.com', emailVerified: true, name: 'Me', nonce: oidc.nonce ?? null }; } };
  async function diagnostics(persistence?: ReturnType<typeof checkPersistence>) {
    const db = memDb(); const { identity } = ensureDbIdentity(db, false);
    const { app } = await buildApp(testConfig(), db, { oidc, logger: false, transport: null, persistence });
    expect((await app.inject({ url: '/api/diagnostics' })).statusCode).toBe(401);
    const r1 = await app.inject({ url: '/auth/login' }); const loc = new URL(r1.headers.location as string); oidc.nonce = loc.searchParams.get('nonce')!;
    const r2 = await app.inject({ url: `/auth/callback?code=c&state=${loc.searchParams.get('state')}`, cookies: { oauth_tx: r1.cookies[0].value } });
    const res = await app.inject({ url: '/api/diagnostics', cookies: { sid: r2.cookies.find((c) => c.name === 'sid')!.value } });
    await app.close(); return { body: res.json(), raw: res.body, identity };
  }
  it('shows id, creation time and the verified volume', async () => {
    const v = checkPersistence(input(), { readMountinfo: () => mi(ROOT_FS, VOLUME), realpath: ident });
    const { body, raw, identity } = await diagnostics(v);
    expect(body.database.identity).toEqual(identity);
    expect(body.database.persistence).toMatchObject({ required: true, verified: true, overridden: false, mountPoint: '/data', fsType: 'ext4', volumePath: '/data' });
    expect(raw).not.toMatch(/x{20}|"sec"|GOOGLE_CLIENT/); // neither the session secret nor the client secret
  });
  it('flags an override and defaults to "not required" for local runs', async () => {
    const o = await diagnostics(checkPersistence(input({ allowEphemeral: true }), { readMountinfo: () => mi(ROOT_FS), realpath: ident }));
    expect(o.body.database.persistence).toMatchObject({ verified: false, overridden: true }); expect(o.body.database.persistence.message).toMatch(/OVERRIDE/);
    expect((await diagnostics()).body.database.persistence).toMatchObject({ required: false, code: 'not_required' });
  });
});

describe('startup behavior (real server process)', () => {
  const base = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', SESSION_SECRET: 's'.repeat(40), ALLOWED_GOOGLE_EMAIL: 'me@example.com', GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'the-client-secret-value', PUBLIC_BASE_URL: 'https://example.test' };
  const port = () => String(38000 + Math.floor(Math.random() * 1500));

  /** Runs server/index.ts. Resolves on exit; if `stopWhen` matches the output, asks the server to shut down gracefully. */
  function run(env: Record<string, string>, stopWhen?: RegExp): Promise<{ code: number | null; out: string; err: string }> {
    return new Promise((resolve) => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'server/index.ts'], { cwd: ROOT, env: { ...base, PORT: port(), ...env } });
      let out = ''; let err = ''; let stopped = false;
      const maybeStop = () => { if (stopWhen && !stopped && stopWhen.test(out)) { stopped = true; child.kill('SIGINT'); } };
      child.stdout.on('data', (d) => { out += d; maybeStop(); }); child.stderr.on('data', (d) => { err += d; });
      child.on('exit', (code) => resolve({ code, out, err }));
      setTimeout(() => child.kill('SIGKILL'), 25_000).unref();
    });
  }
  const line = (out: string, re: RegExp) => out.split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).find((j) => j && re.test(j.msg));
  const ready = /"msg":"ready"/;

  it('REGRESSION: on Railway without a verified volume it refuses to start and never creates a database', async () => {
    const dir = tmp(); const dbPath = path.join(dir, 'missing-volume', 'dashboard.sqlite');
    const r = await run({ RAILWAY_ENVIRONMENT: 'production', NODE_ENV: 'production', SQLITE_PATH: dbPath });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/REFUSING TO START/); expect(r.err).toMatch(/\((cannot_verify|volume_not_mounted|path_outside_volume)\)/); expect(r.err).toMatch(/Mount Path exactly \/data/);
    expect(fs.existsSync(path.dirname(dbPath))).toBe(false); // nothing was created anywhere
    expect(r.out + r.err).not.toContain('the-client-secret-value'); expect(r.out + r.err).not.toContain('s'.repeat(40));
    fs.rmSync(dir, { recursive: true });
  }, 30_000);

  it('local development starts without a volume, logs the new database prominently, and reopens it with the same id', async () => {
    const dir = tmp(); const dbPath = path.join(dir, 'dashboard.sqlite');
    const first = await run({ SQLITE_PATH: dbPath }, ready);
    const created = line(first.out, /NEW DATABASE CREATED/);
    expect(created).toMatchObject({ level: 40, path: dbPath }); expect(created.databaseId).toMatch(/^[0-9a-f-]{36}$/); expect(new Date(created.createdAt).toISOString()).toBe(created.createdAt);
    expect(fs.existsSync(dbPath)).toBe(true); expect(first.out + first.err).not.toContain('the-client-secret-value');
    const second = await run({ SQLITE_PATH: dbPath }, ready);
    expect(line(second.out, /NEW DATABASE CREATED/)).toBeUndefined();
    expect(line(second.out, /Existing database opened/)).toMatchObject({ databaseId: created.databaseId, createdAt: created.createdAt });
    fs.rmSync(dir, { recursive: true });
  }, 60_000);

  it('the explicit override lets a throwaway Railway-like environment start, with a loud warning', async () => {
    const dir = tmp(); const dbPath = path.join(dir, 'dashboard.sqlite');
    const r = await run({ RAILWAY_ENVIRONMENT: 'preview', NODE_ENV: 'production', SQLITE_PATH: dbPath, ALLOW_EPHEMERAL_DB: 'true' }, ready);
    expect(line(r.out, /ALLOW_EPHEMERAL_DB=true/)).toMatchObject({ level: 40 }); expect(line(r.out, /NEW DATABASE CREATED/)).toBeTruthy(); expect(fs.existsSync(dbPath)).toBe(true);
    fs.rmSync(dir, { recursive: true });
  }, 30_000);

  it('an existing production database starts normally: adopted, data and migrations untouched, no "new database" alarm', async () => {
    const dir = tmp(); const dbPath = path.join(dir, 'dashboard.sqlite');
    const seed = openDb(dbPath); seedDefaults(seed); seed.prepare("INSERT INTO application_settings (key, value) VALUES ('keep','\"me\"')").run();
    const sources = (seed.prepare('SELECT COUNT(*) n FROM sources').get() as any).n; seed.close();
    const r = await run({ SQLITE_PATH: dbPath }, ready);
    expect(line(r.out, /NEW DATABASE CREATED/)).toBeUndefined(); expect(line(r.out, /Existing database adopted/)).toBeTruthy();
    const db = openDb(dbPath);
    expect((db.prepare('SELECT COUNT(*) n FROM sources').get() as any).n).toBe(sources);
    expect((db.prepare("SELECT value FROM application_settings WHERE key = 'keep'").get() as any).value).toBe('"me"');
    expect((db.prepare('SELECT COUNT(*) n FROM schema_migrations').get() as any).n).toBe(MIGRATIONS.length);
    db.close(); fs.rmSync(dir, { recursive: true });
  }, 30_000);
});

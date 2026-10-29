import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { DB } from './db.js';
import { getSetting, setSetting } from './db.js';

/**
 * Persistence guard. On Railway the SQLite file must live on the attached volume. A plain directory called /data is NOT proof of that:
 * without a volume the app would silently create a disposable database that vanishes on the next deploy. So we check the kernel's
 * mount table, and that the real (symlink-resolved) database path is inside that mount, before the database is ever opened.
 */

export interface Mount { mountPoint: string; fsType: string }

const unescapeOctal = (s: string) => s.replace(/\\([0-7]{3})/g, (_, o) => String.fromCharCode(parseInt(o, 8))); // mountinfo escapes space as \040

/** Parses /proc/self/mountinfo: `id parent maj:min root mountpoint opts [optional...] - fstype source superopts`. */
export function parseMountinfo(text: string): Mount[] {
  const mounts: Mount[] = [];
  for (const line of text.split('\n')) {
    const parts = line.trim().split(' ');
    const dash = parts.indexOf('-');
    if (dash < 6 || parts.length < dash + 3) continue;
    mounts.push({ mountPoint: unescapeOctal(parts[4]), fsType: parts[dash + 1] });
  }
  return mounts;
}

/** realpath that also works for files/dirs that do not exist yet, and follows dangling symlinks (so a link cannot hide an escape). */
export function realpathLoose(p: string, depth = 0): string {
  if (depth > 40) throw new Error('too many symbolic links');
  try { return fs.realpathSync(p); } catch (e: any) { if (e.code !== 'ENOENT' && e.code !== 'ENOTDIR') throw e; }
  let st: fs.Stats | undefined;
  try { st = fs.lstatSync(p); } catch { /* does not exist */ }
  if (st?.isSymbolicLink()) return realpathLoose(path.resolve(path.dirname(p), fs.readlinkSync(p)), depth + 1);
  const parent = path.dirname(p);
  return parent === p ? p : path.join(realpathLoose(parent, depth + 1), path.basename(p));
}

export type PersistenceCode = 'not_required' | 'verified' | 'cannot_verify' | 'volume_not_mounted' | 'ephemeral_filesystem' | 'path_outside_volume' | 'nested_mount';
export interface PersistenceInput { sqlitePath: string; required: boolean; allowEphemeral: boolean; volumePath: string }
export interface PersistenceDeps { readMountinfo?: () => string; realpath?: (p: string) => string }
export interface PersistenceReport {
  required: boolean; ok: boolean; verified: boolean; overridden: boolean; code: PersistenceCode; message: string;
  mountPoint: string | null; fsType: string | null; resolvedPath: string | null; volumePath: string;
}

const EPHEMERAL_FS = new Set(['tmpfs', 'ramfs']);
const inside = (p: string, dir: string) => p === dir || p.startsWith(dir === '/' ? '/' : dir + '/');

export function checkPersistence(input: PersistenceInput, deps: PersistenceDeps = {}): PersistenceReport {
  const volumePath = path.resolve(input.volumePath);
  const base = { required: input.required, volumePath, mountPoint: null as string | null, fsType: null as string | null, resolvedPath: null as string | null };
  if (!input.required) return { ...base, ok: true, verified: false, overridden: false, code: 'not_required', message: 'Not running on Railway: persistent-volume check skipped (local development).' };

  const readMountinfo = deps.readMountinfo ?? (() => fs.readFileSync('/proc/self/mountinfo', 'utf8'));
  const realpath = deps.realpath ?? realpathLoose;
  const fail = (code: PersistenceCode, message: string, extra: Partial<PersistenceReport> = {}): PersistenceReport => {
    const r: PersistenceReport = { ...base, ...extra, ok: false, verified: false, overridden: false, code, message };
    return input.allowEphemeral ? { ...r, ok: true, overridden: true, message: `OVERRIDE ALLOW_EPHEMERAL_DB=true: running WITHOUT verified persistent storage. Data will be lost on redeploy. (${message})` } : r;
  };

  let mounts: Mount[];
  try { mounts = parseMountinfo(readMountinfo()); }
  catch { return fail('cannot_verify', 'Could not read /proc/self/mountinfo, so the persistent volume cannot be verified.'); }

  let realVolume: string; let resolved: string;
  try { realVolume = realpath(volumePath); resolved = realpath(path.resolve(input.sqlitePath)); }
  catch (e) { return fail('cannot_verify', `Could not resolve the database path (${(e as Error).message}).`); }
  const extra = { resolvedPath: resolved };

  const volume = mounts.find((m) => m.mountPoint === realVolume);
  if (realVolume === '/' || !volume) return fail('volume_not_mounted', `${volumePath} is not a mounted volume (it is only a directory on the container's disk).`, extra);
  if (EPHEMERAL_FS.has(volume.fsType)) return fail('ephemeral_filesystem', `${volumePath} is mounted as ${volume.fsType}, which is memory-backed and not persistent.`, { ...extra, mountPoint: volume.mountPoint, fsType: volume.fsType });
  if (!inside(resolved, realVolume)) {
    const via = path.resolve(input.sqlitePath) !== resolved ? ` (configured path ${input.sqlitePath} resolves through a symbolic link or '..' to ${resolved})` : '';
    return fail('path_outside_volume', `The database path is not inside ${volumePath}${via}.`, { ...extra, mountPoint: volume.mountPoint, fsType: volume.fsType });
  }
  const deepest = mounts.filter((m) => inside(resolved, m.mountPoint)).sort((a, b) => b.mountPoint.length - a.mountPoint.length)[0];
  if (deepest && deepest.mountPoint !== volume.mountPoint) return fail('nested_mount', `The database path is on a different mount (${deepest.mountPoint}, ${deepest.fsType}) nested inside ${volumePath}, not on the volume itself.`, { ...extra, mountPoint: volume.mountPoint, fsType: volume.fsType });
  return { ...base, ok: true, verified: true, overridden: false, code: 'verified', mountPoint: volume.mountPoint, fsType: volume.fsType, resolvedPath: resolved, message: `Database is on the persistent volume mounted at ${volume.mountPoint} (${volume.fsType}).` };
}

/** Multi-line, actionable refusal text. Contains only paths and reasons, never secrets. */
export function formatRefusal(r: PersistenceReport, sqlitePath: string): string {
  return [
    '', '============================================================',
    'REFUSING TO START: SQLite database is not on persistent storage',
    '============================================================',
    `Reason (${r.code}): ${r.message}`, `Database path: ${sqlitePath}`, '',
    'Starting anyway would silently create a brand-new, empty database that is deleted on the next deploy.', '',
    'Fix in Railway:',
    `  1. Attach a Volume to THIS service with Mount Path exactly ${r.volumePath}`,
    `  2. Leave SQLITE_PATH unset, or set it to ${r.volumePath}/dashboard.sqlite (no symlinks pointing outside the volume)`,
    '  3. Redeploy',
    '',
    'Only if you intentionally want disposable storage (for example a throwaway preview): set ALLOW_EPHEMERAL_DB=true.',
    '============================================================', '',
  ].join('\n');
}

export type DbOrigin = 'created' | 'adopted' | 'existing';
export interface DbIdentity { id: string; createdAt: number; origin: 'created' | 'adopted' }

/**
 * Persistent identity, kept in application_settings (migrations 1-4 are untouched). If the volume is ever lost and a new database appears,
 * the id/creation time change, and Diagnostics + the startup log make that visible. A database that predates this feature is "adopted":
 * it gets an id now and its creation time is its oldest known source, never claimed as newly created.
 */
export function ensureDbIdentity(db: DB, existedBefore: boolean): { identity: DbIdentity; status: DbOrigin } {
  const saved = getSetting<DbIdentity | null>(db, 'database_identity', null);
  if (saved?.id) return { identity: saved, status: 'existing' };
  const oldest = existedBefore ? (db.prepare('SELECT MIN(created_at) m FROM sources WHERE created_at > 0').get() as { m: number | null }).m : null;
  const identity: DbIdentity = { id: crypto.randomUUID(), createdAt: existedBefore ? oldest ?? Date.now() : Date.now(), origin: existedBefore ? 'adopted' : 'created' };
  setSetting(db, 'database_identity', identity);
  return { identity, status: identity.origin };
}

export const getDbIdentity = (db: DB): DbIdentity | null => getSetting<DbIdentity | null>(db, 'database_identity', null);

/** A file counts as "existing" only if it has content; an empty file on a fresh volume is a new database. */
export const databaseFileExists = (file: string): boolean => { try { return fs.statSync(file).size > 0; } catch { return false; } };

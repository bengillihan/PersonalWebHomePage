import type { DB } from '../db.js';

/**
 * Source health = connectivity (did the last check work?) + freshness (is the newest article recent enough?), evaluated from
 * columns already in SQLite, so it costs no network request and works the same after an HTTP 304.
 *   last_checked_at  every attempt          | last_success_at  last successful connection (200 or 304)
 *   last_item_at     newest valid article's publication time (never moved by a 304 or by "now")
 *   last_error       set only when the last attempt failed (connection/parse/retrieval)
 */
export const FRESHNESS_TZ = 'America/Los_Angeles'; // weekends are Sat/Sun in this zone
export const DEFAULT_FRESHNESS_HOURS = { major: 24, local: 72 } as const;
export const MAX_FRESHNESS_HOURS = 336;
const HOUR = 3_600_000;
const LOOKBACK_MS = 60 * 24 * HOUR;

export type SourceStatus = 'ok' | 'stale' | 'error' | 'disabled' | 'unknown';
export interface HealthRow { enabled: number; is_local: number; freshness_hours: number | null; last_checked_at: number | null; last_error: string | null; last_item_at: number | null }
export interface Evaluation { status: SourceStatus; reason: string | null; thresholdHours: number; defaultHours: number }

const weekday = new Intl.DateTimeFormat('en-US', { timeZone: FRESHNESS_TZ, weekday: 'short' });
const isWeekend = (ms: number) => { const d = weekday.format(ms); return d === 'Sat' || d === 'Sun'; };

/** Hours between two instants, not counting Saturday/Sunday, so a quiet weekend never makes a feed look dead. */
export function activeHoursBetween(from: number, to: number): number {
  if (to <= from) return 0;
  let t = Math.max(from, to - LOOKBACK_MS); let total = 0;
  while (t < to) { const step = Math.min(HOUR, to - t); if (!isWeekend(t + step / 2)) total += step; t += step; }
  return total / HOUR;
}

export function evaluateSource(row: HealthRow, now = Date.now()): Evaluation {
  const defaultHours = row.is_local ? DEFAULT_FRESHNESS_HOURS.local : DEFAULT_FRESHNESS_HOURS.major;
  const thresholdHours = row.freshness_hours ?? defaultHours;
  const out = (status: SourceStatus, reason: string | null): Evaluation => ({ status, reason, thresholdHours, defaultHours });
  if (!row.enabled) return out('disabled', 'Turned off');
  if (row.last_error) return out('error', row.last_error); // a failed check outranks content freshness
  if (row.last_checked_at == null) return out('unknown', null);
  if (row.last_item_at == null) return out('stale', 'No article with a publication date on record');
  const age = activeHoursBetween(row.last_item_at, now);
  return age > thresholdHours ? out('stale', `Newest article is ${Math.round(age)}h old (expected within ${thresholdHours}h, weekends excluded)`) : out('ok', null);
}

/** Re-evaluates and stores the status snapshot. Local only: reads existing columns (and, if needed, existing articles). */
export function refreshHealth(db: DB, sourceId: number, now = Date.now()): SourceStatus {
  const row = db.prepare('SELECT enabled, is_local, freshness_hours, last_checked_at, last_error, last_item_at, health FROM sources WHERE id = ?').get(sourceId) as (HealthRow & { health: string }) | undefined;
  if (!row) return 'unknown';
  let lastItem = row.last_item_at;
  if (lastItem == null) { // rows from before last_item_at was tracked: fall back to what we already stored
    lastItem = (db.prepare('SELECT MAX(a.published_at) m FROM article_sources x JOIN articles a ON a.id = x.article_id WHERE x.source_id = ?').get(sourceId) as { m: number | null }).m;
    if (lastItem != null) db.prepare('UPDATE sources SET last_item_at = ? WHERE id = ?').run(lastItem, sourceId);
  }
  const ev = evaluateSource({ ...row, last_item_at: lastItem }, now);
  if (ev.status !== 'disabled' && ev.status !== row.health) db.prepare('UPDATE sources SET health = ? WHERE id = ?').run(ev.status, sourceId);
  return ev.status;
}

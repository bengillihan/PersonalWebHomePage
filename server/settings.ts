import type { DB } from './db.js';
import { getSetting, setSetting } from './db.js';

export interface Prefs {
  weights: { interests: number; importance: number; recency: number; source: number; feedback: number };
  quotas: { personalized: number; major: number; local: number };
  preferredPublishers: string[];
  mutedPublishers: string[];
  showImages: boolean;
  retentionDays: number;
  staleMinutes: number;
  theme: 'light' | 'dark' | 'system';
  showRead: boolean; // show already-read stories in the main feeds (dimmed); off by default
}

export const DEFAULT_PREFS: Prefs = {
  weights: { interests: 0.35, importance: 0.25, recency: 0.2, source: 0.1, feedback: 0.1 },
  quotas: { personalized: 0.6, major: 0.25, local: 0.15 },
  preferredPublishers: [],
  mutedPublishers: [],
  showImages: true,
  retentionDays: 90,
  staleMinutes: 60,
  theme: 'system',
  showRead: false,
};

export function getPrefs(db: DB): Prefs {
  const saved = getSetting<Partial<Prefs>>(db, 'prefs', {});
  return {
    ...DEFAULT_PREFS, ...saved,
    weights: { ...DEFAULT_PREFS.weights, ...saved.weights },
    quotas: { ...DEFAULT_PREFS.quotas, ...saved.quotas },
  };
}
export function savePrefs(db: DB, prefs: Prefs): void { setSetting(db, 'prefs', prefs); }

/**
 * Where "Local", "Regional" and "Washington" stories are found. Matched against a story's own headline and summary (never the publisher's
 * location), so a story can qualify for several of them. Every list is editable in Settings -> Geography.
 */
export interface GeoPrefs {
  local: string[]; localPriority: string[]; regional: string[]; washington: string[];
}
export const DEFAULT_GEO: GeoPrefs = {
  local: ['Des Moines', 'Federal Way', 'SeaTac', 'Sea-Tac', 'Kent', 'Burien', 'Normandy Park', 'South King County', 'Tukwila', 'Renton', 'Covington', 'Maple Valley', 'Highline', 'Auburn, WA', 'Redondo', 'Midway'],
  localPriority: ['Des Moines', 'Federal Way'],
  regional: ['Seattle', 'Bellevue', 'Tacoma', 'Everett', 'Puget Sound', 'King County', 'Pierce County', 'Snohomish County', 'Redmond', 'Kirkland', 'Bothell', 'Issaquah', 'Sound Transit', 'Port of Seattle', 'Sea-Tac Airport'],
  washington: ['Washington state', 'Washington State Legislature', 'Olympia', 'state legislature', 'state lawmakers', 'WSDOT', 'Spokane', 'Yakima', 'Bellingham', 'Wenatchee', 'Tri-Cities', 'Washington Supreme Court', 'Washington governor', 'Evergreen State'],
};
const cleanList = (xs: unknown, fallback: string[]) => (Array.isArray(xs) ? [...new Set(xs.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean))].slice(0, 100) : fallback);
export function getGeo(db: DB): GeoPrefs {
  const s = getSetting<Partial<GeoPrefs>>(db, 'geo', {});
  return { local: cleanList(s.local, DEFAULT_GEO.local), localPriority: cleanList(s.localPriority, DEFAULT_GEO.localPriority), regional: cleanList(s.regional, DEFAULT_GEO.regional), washington: cleanList(s.washington, DEFAULT_GEO.washington) };
}
export function saveGeo(db: DB, geo: GeoPrefs): void { setSetting(db, 'geo', geo); }

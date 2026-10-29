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

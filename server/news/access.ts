/**
 * "Prefer free coverage". How readable a story's articles are, from two kinds of evidence only, never guessed and never fetched:
 *  - EXPLICIT article metadata from the feed itself (schema.org `isAccessibleForFree`), stored on the article; it overrides the publisher default;
 *  - the publisher-level setting the user chose per source (Settings -> Sources -> Access); "unknown" is the default and means "no opinion".
 * Missing metadata is never read as "free" or "paywalled".
 */
export type Access = 'free' | 'metered' | 'paywalled' | 'unknown';
export const ACCESS_LEVELS = ['free', 'metered', 'paywalled', 'unknown'] as const;
export interface AccessInfo { level: Access; basis: 'article' | 'publisher' | 'none'; label: string | null }

const known = (v: unknown): v is 'free' | 'metered' | 'paywalled' => v === 'free' || v === 'metered' || v === 'paywalled';
const publisherLevel = (v: unknown): Access => (known(v) ? v : 'unknown');

/** Lower is better: 0 known-free article, 1 usually-free publisher, 2 unknown, 3 metered, 4 paywalled (explicit article metadata beats the publisher default). */
export function accessTier(article: string | null | undefined, publisher: string | null | undefined): number {
  if (known(article)) return { free: 0, metered: 3, paywalled: 4 }[article];
  return { free: 1, unknown: 2, metered: 3, paywalled: 4 }[publisherLevel(publisher)];
}

/** Concise label shown beside a source. Estimates from the publisher setting say "Likely"/"Usually"; explicit article metadata is stated plainly. */
export function accessInfo(article: string | null | undefined, publisher: string | null | undefined): AccessInfo {
  if (known(article)) return { level: article, basis: 'article', label: { free: 'Free', metered: 'Metered', paywalled: 'Paywall' }[article] };
  const level = publisherLevel(publisher);
  return { level, basis: level === 'unknown' ? 'none' : 'publisher', label: { free: 'Usually free', metered: 'Metered', paywalled: 'Likely paywall', unknown: null }[level] };
}

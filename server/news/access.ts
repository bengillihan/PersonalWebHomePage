/**
 * "Prefer free coverage". How readable a story's articles are, from three kinds of evidence only, never guessed by a model:
 *  - EXPLICIT article metadata from the feed itself (schema.org `isAccessibleForFree`), stored on the article; it overrides the publisher default;
 *  - the publisher-level setting the user chose per source (Settings -> Sources -> Access); "unknown" is the default and means "no opinion";
 *  - an automatic check of the domain's own article pages (domain-access.ts), used only when neither of the above says anything.
 * Missing metadata is never read as "free" or "paywalled".
 */
export type Access = 'free' | 'metered' | 'paywalled' | 'unknown';
export const ACCESS_LEVELS = ['free', 'metered', 'paywalled', 'unknown'] as const;
export interface AccessInfo { level: Access; basis: 'article' | 'publisher' | 'domain' | 'none'; label: string | null }

const known = (v: unknown): v is 'free' | 'metered' | 'paywalled' => v === 'free' || v === 'metered' || v === 'paywalled';
const publisherLevel = (v: unknown): Access => (known(v) ? v : 'unknown');

/**
 * Lower is better: 0 known-free article, 1 usually-free publisher, 1.5 domain check found it free, 2 unknown, 3 metered, 4 paywalled.
 * Evidence order: the article's own feed metadata, then the access the user set on the source, then the automatic domain check (an estimate, so it never beats either).
 */
export function accessTier(article: string | null | undefined, publisher: string | null | undefined, domain?: string | null): number {
  if (known(article)) return { free: 0, metered: 3, paywalled: 4 }[article];
  const level = publisherLevel(publisher);
  if (level !== 'unknown') return { free: 1, metered: 3, paywalled: 4 }[level];
  return known(domain) ? { free: 1.5, metered: 3, paywalled: 4 }[domain] : 2;
}

/** Concise label shown beside a source. Estimates (the publisher setting, the domain check) say "Likely"/"Usually"; explicit article metadata is stated plainly. */
export function accessInfo(article: string | null | undefined, publisher: string | null | undefined, domain?: string | null): AccessInfo {
  if (known(article)) return { level: article, basis: 'article', label: { free: 'Free', metered: 'Metered', paywalled: 'Paywall' }[article] };
  const level = publisherLevel(publisher);
  if (level !== 'unknown') return { level, basis: 'publisher', label: { free: 'Usually free', metered: 'Metered', paywalled: 'Likely paywall', unknown: null }[level] };
  if (known(domain)) return { level: domain, basis: 'domain', label: { free: 'Likely free', metered: 'Likely metered', paywalled: 'Likely paywall' }[domain] };
  return { level: 'unknown', basis: 'none', label: null };
}

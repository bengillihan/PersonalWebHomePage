import crypto from 'node:crypto';

const TRACKING = /^(utm_.*|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|ocid|cmpid|smid|smtyp|ref|ref_src|source|cid|ncid|taid|at_.*|_ga|igshid|share|rss|partner|referrer)$/i;

export function sha1(s: string): string { return crypto.createHash('sha1').update(s).digest('hex'); }
export function sha256(s: string): string { return crypto.createHash('sha256').update(s).digest('hex'); }

/** Canonical identifier for exact-duplicate detection. */
export function canonicalizeUrl(raw: string): string {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return raw.trim(); }
  u.hash = '';
  u.protocol = 'https:';
  u.hostname = u.hostname.toLowerCase().replace(/^(www|m|amp|mobile)\./, '');
  if (u.port === '443' || u.port === '80') u.port = '';
  const kept = [...u.searchParams.entries()].filter(([k]) => !TRACKING.test(k)).sort(([a], [b]) => a.localeCompare(b));
  u.search = '';
  for (const [k, v] of kept) u.searchParams.append(k, v);
  let p = u.pathname.replace(/\/{2,}/g, '/').replace(/\/(amp|index\.html?)$/i, '');
  if (p.length > 1) p = p.replace(/\/+$/, '');
  u.pathname = p;
  return u.toString();
}

const STOP = new Set('a an the and or but of in on at to for from by with as is are was were be been it its this that these those after before over under into amid new says say said will would could may might not no up out off about than more most how why what who when where which has have had his her their our your you we they he she i just also us'.split(' '));

export function normalizeTitle(t: string): string {
  return t.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/&amp;/g, ' ').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

export function tokens(t: string): string[] {
  return normalizeTitle(t).split(' ').filter((w) => w.length > 1 && !STOP.has(w)).map(stem);
}

function stem(w: string): string {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('es')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

export function jaccard(a: Iterable<string>, b: Iterable<string>): number {
  const A = new Set(a), B = new Set(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/** Capitalized / numeric tokens approximate named entities and figures without any model. */
export function entities(title: string): Set<string> {
  const out = new Set<string>();
  for (const m of title.matchAll(/\b([A-Z][a-zA-Z]{2,}|\d[\d,.]*%?)\b/g)) out.add(m[1].toLowerCase());
  return out;
}

export function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#8217;/g, '’').replace(/&#8216;/g, '‘').replace(/&#8220;/g, '“').replace(/&#8221;/g, '”').replace(/&#8211;/g, '–').replace(/&#8230;/g, '…')
    .replace(/\s+/g, ' ').trim();
}

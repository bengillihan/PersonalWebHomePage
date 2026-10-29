/** US market calendar helpers (NYSE regular sessions). All times evaluated in America/New_York. */
const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' });

export interface EtParts { y: number; m: number; d: number; hh: number; mm: number; dow: number; date: string }
export function etParts(ms: number): EtParts {
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(p.weekday);
  const hh = Number(p.hour) % 24;
  return { y: +p.year, m: +p.month, d: +p.day, hh, mm: +p.minute, dow, date: `${p.year}-${p.month}-${p.day}` };
}

function nthWeekday(y: number, m: number, dow: number, n: number): number {
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();
  return 1 + ((dow - first + 7) % 7) + (n - 1) * 7;
}
function lastWeekday(y: number, m: number, dow: number): number {
  const last = new Date(Date.UTC(y, m, 0));
  return last.getUTCDate() - ((last.getUTCDay() - dow + 7) % 7);
}
function easter(y: number): [number, number] {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30, i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7, mm = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * mm + 114) / 31), day = ((h + l - 7 * mm + 114) % 31) + 1;
  return [month, day];
}
const iso = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
function observed(y: number, m: number, d: number): string {
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  if (dow === 6) return iso(y, m, d - 1) // Saturday -> Friday (may cross year only for Jan 1, which NYSE does not observe)
  ;
  if (dow === 0) return iso(y, m, d + 1);
  return iso(y, m, d);
}

export function nyseHolidays(y: number): Set<string> {
  const s = new Set<string>();
  const ny = new Date(Date.UTC(y, 0, 1)).getUTCDay();
  if (ny !== 6) s.add(observed(y, 1, 1)); // NYSE doesn't close the prior Friday for a Saturday New Year
  s.add(iso(y, 1, nthWeekday(y, 1, 1, 3)));
  s.add(iso(y, 2, nthWeekday(y, 2, 1, 3)));
  const [em, ed] = easter(y); const gf = new Date(Date.UTC(y, em - 1, ed - 2)); s.add(iso(y, gf.getUTCMonth() + 1, gf.getUTCDate()));
  s.add(iso(y, 5, lastWeekday(y, 5, 1)));
  if (y >= 2022) s.add(observed(y, 6, 19));
  s.add(observed(y, 7, 4));
  s.add(iso(y, 9, nthWeekday(y, 9, 1, 1)));
  s.add(iso(y, 11, nthWeekday(y, 11, 4, 4)));
  s.add(observed(y, 12, 25));
  return s;
}

export function isBusinessDay(date: string): boolean {
  const [y, m, d] = date.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return dow !== 0 && dow !== 6 && !nyseHolidays(y).has(date);
}

export function prevBusinessDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  let t = Date.UTC(y, m - 1, d);
  do { t -= 86_400_000; const x = new Date(t); date = iso(x.getUTCFullYear(), x.getUTCMonth() + 1, x.getUTCDate()); } while (!isBusinessDay(date));
  return date;
}

export function marketOpen(ms: number): boolean {
  const p = etParts(ms);
  if (!isBusinessDay(p.date)) return false;
  const mins = p.hh * 60 + p.mm;
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

/** The most recent session date whose closing data should already be published (equities ~16:15 ET, fund NAVs ~20:00 ET). */
export function latestExpectedDate(ms: number, kind: 'market' | 'nav'): string {
  const p = etParts(ms);
  const cutoffMins = kind === 'nav' ? 20 * 60 : 16 * 60 + 15;
  const mins = p.hh * 60 + p.mm;
  if (isBusinessDay(p.date) && mins >= cutoffMins) return p.date;
  return prevBusinessDay(p.date);
}

export interface CacheState { fetchedAt: number | null; lastBarDate: string | null; hadError: boolean }

/** Decides whether a provider call is worthwhile. Weekends and holidays naturally yield false once data is current. */
export function needsRefresh(type: 'equity' | 'etf' | 'mutual_fund' | 'index', c: CacheState, now: number): boolean {
  if (!c.fetchedAt || !c.lastBarDate) return !c.fetchedAt || now - c.fetchedAt > 30 * 60_000;
  const age = now - c.fetchedAt;
  if (c.hadError) return age > 30 * 60_000;
  if (type === 'mutual_fund') {
    const expected = latestExpectedDate(now, 'nav');
    return c.lastBarDate < expected && age > 2 * 3_600_000;
  }
  if (marketOpen(now)) return age > 10 * 60_000;
  const expected = latestExpectedDate(now, 'market');
  return c.lastBarDate < expected && age > 30 * 60_000;
}

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { memDb, fixtureServer, testConfig, type Fixture } from './helpers.js';
import { Weather, parseForecast, describeWeather, DEFAULT_LOCATION, TTL_MS, type WeatherLocation } from '../server/weather/weather.js';
import { buildApp } from '../server/app.js';
import type { OidcClient } from '../server/auth.js';
import type { DB } from '../server/db.js';

let fx: Fixture;
beforeAll(async () => { fx = await fixtureServer(); });
afterAll(async () => { await fx.close(); });

const forecastBody = (over: Record<string, unknown> = {}) => JSON.stringify({
  timezone: 'America/Los_Angeles',
  current: { temperature_2m: 47.9, weather_code: 3, is_day: 1 },
  daily: {
    time: ['2026-10-29', '2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02', '2026-11-03'],
    weather_code: [61, 53, 3, 51, 0, 95],
    temperature_2m_max: [54.2, 52.5, 52.3, 53.2, 53.1, 50],
    temperature_2m_min: [41.0, 41.7, 39.1, 44.0, 40.7, 40],
    precipitation_probability_max: [29, 33, 2, null, 9, 80],
  }, ...over,
});
const ZIP_98198 = JSON.stringify({ country: 'United States', 'post code': '98198', places: [{ 'place name': 'Seattle', longitude: '-122.3129', latitude: '47.3929', state: 'Washington', 'state abbreviation': 'WA' }] });
const GEO = JSON.stringify({ results: [
  { name: 'Des Moines', latitude: 41.6, longitude: -93.6, admin1: 'Iowa', country_code: 'US', country: 'United States' },
  { name: 'Des Moines', latitude: 47.4, longitude: -122.3, admin1: 'Washington', country_code: 'US', country: 'United States' },
] });

let db: DB; let clock: number;
const make = () => new Weather(db, { forecastBase: fx.url, geocodeBase: fx.url, zipBase: fx.url, fetchOpts: { allowPrivate: true }, now: () => clock });
const until = async (cond: () => Promise<boolean> | boolean) => { for (let i = 0; i < 100 && !(await cond()); i++) await new Promise((r) => setTimeout(r, 50)); };
const forecastHits = () => fx.hits.filter((h) => h.startsWith('/v1/forecast')).length;
const okRoutes = () => { fx.routes.set('/v1/forecast', { type: 'application/json', body: forecastBody() }); fx.routes.set('/us/98198', { type: 'application/json', body: ZIP_98198 }); fx.routes.set('/v1/search', { type: 'application/json', body: GEO }); };
beforeEach(() => { db = memDb(); clock = Date.now(); fx.hits.length = 0; okRoutes(); });

describe('forecast parsing', () => {
  it('returns five days starting today, rounded °F, precipitation chance, description and icon', () => {
    const f = parseForecast(JSON.parse(forecastBody()));
    expect(f.days).toHaveLength(5);
    expect(f.days[0]).toEqual({ date: '2026-10-29', code: 61, description: 'Light rain', icon: '🌧️', highF: 54, lowF: 41, precipPct: 29 });
    expect(f.days[3].precipPct).toBeNull(); // missing probability is not invented
    expect(f.current).toMatchObject({ tempF: 48, description: 'Overcast', isDay: true });
  });
  it('skips incomplete days and rejects malformed bodies', () => {
    const f = parseForecast(JSON.parse(forecastBody({ daily: { time: ['2026-10-29', '2026-10-30'], weather_code: [null, 3], temperature_2m_max: [50, 51], temperature_2m_min: [40, 41], precipitation_probability_max: [1, 2] } })));
    expect(f.days.map((d) => d.date)).toEqual(['2026-10-30']);
    expect(() => parseForecast({ nope: true })).toThrow(/Unexpected/);
    expect(() => parseForecast(JSON.parse(forecastBody({ daily: { time: [], weather_code: [], temperature_2m_max: [], temperature_2m_min: [], precipitation_probability_max: [] } })))).toThrow(/no days/);
  });
  it('maps WMO codes, with a night icon for clear skies', () => {
    expect(describeWeather(0, true).icon).toBe('☀️'); expect(describeWeather(0, false).icon).toBe('🌙');
    expect(describeWeather(95).description).toBe('Thunderstorm'); expect(describeWeather(999).description).toBe('Unknown');
  });
});

describe('location: ZIP resolution, search and persistence', () => {
  it('defaults to Des Moines, WA (98198) with no network call', async () => {
    const w = make();
    expect(w.location()).toEqual(DEFAULT_LOCATION); expect(DEFAULT_LOCATION).toMatchObject({ zip: '98198', label: 'Des Moines, WA' });
    expect(fx.hits).toHaveLength(0);
  });
  it('resolves a US ZIP through the ZIP geocoder (not Open-Meteo city search)', async () => {
    const loc = await make().lookupZip('98198');
    expect(loc).toEqual({ label: 'Seattle, WA 98198', lat: 47.3929, lon: -122.3129, zip: '98198' });
    expect(fx.hits).toEqual(['/us/98198']);
    expect(await make().lookupZip('00000')).toBeNull(); // 404 -> not found
    expect(await make().lookupZip('9819')).toBeNull(); expect(await make().lookupZip('abcde')).toBeNull(); // never reaches the network
    expect(fx.hits.filter((h) => h.startsWith('/us/'))).toEqual(['/us/98198', '/us/00000']);
  });
  it('searches cities, narrowing "City, State" when the state matches', async () => {
    const all = await make().searchCities('Des Moines');
    expect(all.map((l) => l.label)).toEqual(['Des Moines, Iowa', 'Des Moines, Washington']);
    expect((await make().searchCities('Des Moines, Wash')).map((l) => l.label)).toEqual(['Des Moines, Washington']);
    expect((await make().searchCities('Des Moines, Narnia')).length).toBe(2); // no match: don't hide results
    expect(await make().searchCities('x')).toEqual([]);
    expect(fx.hits.find((h) => h.startsWith('/v1/search'))).toContain('name=Des+Moines');
  });
  it('persists the chosen location in SQLite, across service instances, and writes only on change', () => {
    const tacoma: WeatherLocation = { label: 'Tacoma, Washington', lat: 47.25, lon: -122.44, zip: null };
    make().setLocation(tacoma);
    expect(make().location()).toEqual(tacoma); // a fresh instance (e.g. after a deploy) on the same database
    const before = db.pragma('data_version', { simple: true }) as number; const changes = (db as any).prepare('SELECT total_changes() n').get().n;
    make().setLocation(tacoma);
    expect((db as any).prepare('SELECT total_changes() n').get().n).toBe(changes); void before; // no write when unchanged
  });
  it('surfaces geocoder outages as errors instead of guessing', async () => {
    fx.routes.set('/us/98198', { status: 500, body: 'boom' });
    await expect(make().lookupZip('98198')).rejects.toMatchObject({ kind: 'unavailable' });
    fx.routes.set('/v1/search', { type: 'application/json', body: '{"garbage":' });
    await expect(make().searchCities('Seattle')).rejects.toMatchObject({ kind: 'unavailable' });
  });
});

describe('caching (60 min, stale-while-revalidate, no polling)', () => {
  it('first load fetches once; fresh cache is served with zero further requests', async () => {
    const w = make();
    const v1 = await w.get();
    expect(v1.forecast!.days).toHaveLength(5); expect(v1.stale).toBe(false); expect(v1.fetchedAt).toBe(clock); expect(forecastHits()).toBe(1);
    clock += TTL_MS - 1000;
    const v2 = await make().get(); // new instance: the cache lives in SQLite
    expect(v2.forecast).toEqual(v1.forecast); expect(v2.stale).toBe(false); expect(forecastHits()).toBe(1);
    await new Promise((r) => setTimeout(r, 50)); expect(forecastHits()).toBe(1); // nothing runs on a timer
    const q = new URL('http://x' + fx.hits[0]).searchParams;
    expect(q.get('temperature_unit')).toBe('fahrenheit'); expect(q.get('forecast_days')).toBe('5'); expect(q.get('timezone')).toBe('auto');
    expect(q.get('latitude')).toBe(String(DEFAULT_LOCATION.lat));
  });
  it('after 60 minutes returns the cached forecast immediately (stale) and refreshes once, even for concurrent requests', async () => {
    const w = make(); await w.get();
    clock += TTL_MS + 1;
    fx.routes.set('/v1/forecast', { type: 'application/json', body: forecastBody({ current: { temperature_2m: 60.2, weather_code: 0, is_day: 1 } }) });
    const views = await Promise.all([w.get(), w.get(), w.get(), w.get(), w.get()]);
    expect(views.every((v) => v.stale && v.forecast!.current.tempF === 48)).toBe(true); // old data served instantly
    await new Promise((r) => setTimeout(r, 100));
    expect(forecastHits()).toBe(2); // exactly one refresh for five requests
    const v = await w.get();
    expect(v.stale).toBe(false); expect(v.forecast!.current.tempF).toBe(60); expect(v.fetchedAt).toBe(clock);
  });
  it('a different location never shows another location\'s cached forecast', async () => {
    const w = make(); await w.get();
    w.setLocation({ label: 'Tacoma, Washington', lat: 47.25, lon: -122.44, zip: null });
    const v = await w.get();
    expect(v.location.label).toBe('Tacoma, Washington'); expect(forecastHits()).toBe(2);
    expect(new URL('http://x' + fx.hits[1]).searchParams.get('latitude')).toBe('47.25');
  });
});

describe('API failures', () => {
  it('first load with the upstream down: no forecast, a readable error, no exception', async () => {
    fx.routes.set('/v1/forecast', { status: 500, body: 'down' });
    const v = await make().get();
    expect(v.forecast).toBeNull(); expect(v.fetchedAt).toBeNull(); expect(v.error).toMatch(/HTTP 500|unreachable/);
  });
  it('keeps the last good forecast and its update time during an outage, and backs off instead of hammering', async () => {
    const w = make(); const first = await w.get();
    clock += TTL_MS + 1;
    fx.routes.set('/v1/forecast', { status: 503, body: 'down' });
    await w.get(); await until(async () => (await w.get()).error !== null); // refresh (with its own retry/backoff) finishes in the background
    const hitsAfterFailure = forecastHits();
    const v = await w.get();
    expect(v.forecast).toEqual(first.forecast); expect(v.fetchedAt).toBe(first.fetchedAt); expect(v.stale).toBe(true); expect(v.error).toBeTruthy();
    await w.get(); await w.get(); await new Promise((r) => setTimeout(r, 50));
    expect(forecastHits()).toBe(hitsAfterFailure); // inside the 5-minute backoff
    clock += 6 * 60_000;
    fx.routes.set('/v1/forecast', { type: 'application/json', body: forecastBody() });
    await w.get(); await until(async () => (await w.get()).error === null);
    const recovered = await w.get();
    expect(recovered.error).toBeNull(); expect(recovered.stale).toBe(false);
  });
  it('invalid JSON or an unexpected shape is treated as an outage', async () => {
    fx.routes.set('/v1/forecast', { type: 'application/json', body: '<html>oops' });
    expect((await make().get()).error).toMatch(/invalid data/);
    db = memDb(); fx.routes.set('/v1/forecast', { type: 'application/json', body: '{"hello":1}' });
    expect((await make().get()).error).toMatch(/Unexpected/);
  });
});

describe('weather API (authenticated)', () => {
  let app: FastifyInstance; let cookie = ''; let csrf = '';
  const oidc: OidcClient & { nonce?: string } = { authUrl: ({ state, nonce }) => `https://x/?state=${state}&nonce=${nonce}`, async exchange() { return { sub: 's', email: 'me@example.com', emailVerified: true, name: 'Me', nonce: oidc.nonce ?? null }; } };
  beforeEach(async () => {
    ({ app } = await buildApp(testConfig(), db, { oidc, logger: false, transport: null, fetchOpts: { allowPrivate: true }, weather: { forecastBase: fx.url, geocodeBase: fx.url, zipBase: fx.url } }));
    const r1 = await app.inject({ url: '/auth/login' }); const loc = new URL(r1.headers.location as string); oidc.nonce = loc.searchParams.get('nonce')!;
    const r2 = await app.inject({ url: `/auth/callback?code=c&state=${loc.searchParams.get('state')}`, cookies: { oauth_tx: r1.cookies[0].value } });
    cookie = r2.cookies.find((c) => c.name === 'sid')!.value;
    csrf = (await app.inject({ url: '/api/me', cookies: { sid: cookie } })).json().csrfToken;
  });
  const call = (method: any, url: string, payload?: unknown) => app.inject({ method, url, cookies: { sid: cookie }, headers: { 'x-csrf-token': csrf }, payload: payload as any });

  it('requires sign-in to search for or change the weather location (the forecast itself is a public read)', async () => {
    for (const [m, u] of [['GET', '/api/weather/search?q=seattle'], ['PUT', '/api/weather/location']] as const) expect((await app.inject({ method: m, url: u })).statusCode, u).toBe(401);
    await app.close();
  });
  it('serves the default location with a five-day forecast and attribution', async () => {
    const r = await call('GET', '/api/weather'); const j = r.json();
    expect(r.statusCode).toBe(200); expect(j.location.label).toBe('Des Moines, WA'); expect(j.forecast.days).toHaveLength(5);
    expect(j.attribution.map((a: any) => a.url)).toContain('https://open-meteo.com/');
    await app.close();
  });
  it('changes location by ZIP, persists it, and validates input', async () => {
    fx.routes.set('/us/98101', { type: 'application/json', body: JSON.stringify({ places: [{ 'place name': 'Seattle', longitude: '-122.33', latitude: '47.61', state: 'Washington', 'state abbreviation': 'WA' }] }) });
    const put = await call('PUT', '/api/weather/location', { zip: '98101' });
    expect(put.statusCode).toBe(200); expect(put.json().location).toEqual({ label: 'Seattle, WA 98101', lat: 47.61, lon: -122.33, zip: '98101' });
    expect(put.json().forecast.days).toHaveLength(5);
    expect((await call('GET', '/api/weather')).json().location.zip).toBe('98101'); // persisted, visible to any other device
    expect(new Weather(db).location().zip).toBe('98101'); // and in SQLite after a "restart"
    expect((await call('PUT', '/api/weather/location', { zip: '9810' })).statusCode).toBe(400);
    expect((await call('PUT', '/api/weather/location', { zip: '00000' })).statusCode).toBe(404);
    expect((await call('PUT', '/api/weather/location', { label: 'x', lat: 999, lon: 0 })).statusCode).toBe(400);
    expect((await call('PUT', '/api/weather/location', {})).statusCode).toBe(400);
    expect((await call('PUT', '/api/weather/location', { label: 'Tacoma, Washington', lat: 47.25, lon: -122.44 })).json().location.zip).toBeNull();
    expect((await app.inject({ method: 'PUT', url: '/api/weather/location', cookies: { sid: cookie }, payload: { zip: '98101' } })).statusCode).toBe(403); // CSRF
    await app.close();
  });
  it('search handles ZIPs and cities, and reports geocoder failures as 502', async () => {
    expect((await call('GET', '/api/weather/search?q=98198')).json()[0].label).toBe('Seattle, WA 98198');
    expect((await call('GET', '/api/weather/search?q=Des Moines')).json()).toHaveLength(2);
    expect((await call('GET', '/api/weather/search?q=00000')).json()).toEqual([]);
    expect((await call('GET', '/api/weather/search?q=a')).statusCode).toBe(400);
    fx.routes.set('/v1/search', { status: 500, body: 'x' });
    expect((await call('GET', '/api/weather/search?q=Seattle')).statusCode).toBe(502);
    await app.close();
  });
});

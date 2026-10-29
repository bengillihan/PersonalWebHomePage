import { z } from 'zod';
import type { DB } from '../db.js';
import { getSetting, setSetting } from '../db.js';
import { fetchWithRetry, type SafeFetchOptions } from '../net/safeFetch.js';

export interface WeatherLocation { label: string; lat: number; lon: number; zip: string | null }
export interface DayForecast { date: string; code: number; description: string; icon: string; highF: number; lowF: number; precipPct: number | null }
export interface CurrentWeather { tempF: number; code: number; description: string; icon: string; isDay: boolean }
export interface Forecast { timezone: string; current: CurrentWeather; days: DayForecast[] }
export interface WeatherView { location: WeatherLocation; forecast: Forecast | null; fetchedAt: number | null; stale: boolean; refreshing: boolean; error: string | null }

/** ZIP 98198 coordinates as returned by Zippopotam.us (verified 2026-10-29); its place name there is "Seattle", the user wants Des Moines. */
export const DEFAULT_LOCATION: WeatherLocation = { label: 'Des Moines, WA', lat: 47.3929, lon: -122.3129, zip: '98198' };
export const TTL_MS = 60 * 60_000;
const FAILURE_BACKOFF_MS = 5 * 60_000;

export class WeatherError extends Error { constructor(message: string, public kind: 'not_found' | 'unavailable') { super(message); } }

export interface WeatherOptions { forecastBase?: string; geocodeBase?: string; zipBase?: string; fetchOpts?: SafeFetchOptions; now?: () => number }

/** WMO weather interpretation codes (as documented by Open-Meteo) -> short text + emoji icon. */
export function describeWeather(code: number, isDay = true): { description: string; icon: string } {
  if (code === 0) return isDay ? { description: 'Clear', icon: '☀️' } : { description: 'Clear', icon: '🌙' };
  if (code === 1) return isDay ? { description: 'Mostly clear', icon: '🌤️' } : { description: 'Mostly clear', icon: '🌙' };
  if (code === 2) return { description: 'Partly cloudy', icon: '⛅' };
  if (code === 3) return { description: 'Overcast', icon: '☁️' };
  if (code === 45 || code === 48) return { description: 'Fog', icon: '🌫️' };
  if (code >= 51 && code <= 55) return { description: code === 51 ? 'Light drizzle' : 'Drizzle', icon: '🌦️' };
  if (code === 56 || code === 57) return { description: 'Freezing drizzle', icon: '🌧️' };
  if (code === 61 || code === 63 || code === 65) return { description: code === 61 ? 'Light rain' : code === 63 ? 'Rain' : 'Heavy rain', icon: '🌧️' };
  if (code === 66 || code === 67) return { description: 'Freezing rain', icon: '🌧️' };
  if (code === 71 || code === 73 || code === 75) return { description: code === 71 ? 'Light snow' : code === 73 ? 'Snow' : 'Heavy snow', icon: '🌨️' };
  if (code === 77) return { description: 'Snow grains', icon: '🌨️' };
  if (code >= 80 && code <= 82) return { description: code === 80 ? 'Light showers' : 'Showers', icon: '🌦️' };
  if (code === 85 || code === 86) return { description: 'Snow showers', icon: '🌨️' };
  if (code === 95) return { description: 'Thunderstorm', icon: '⛈️' };
  if (code === 96 || code === 99) return { description: 'Thunderstorm, hail', icon: '⛈️' };
  return { description: 'Unknown', icon: '❔' };
}

const nums = z.array(z.number().nullable());
const forecastSchema = z.object({
  timezone: z.string(),
  current: z.object({ temperature_2m: z.number(), weather_code: z.number(), is_day: z.number() }),
  daily: z.object({ time: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)), weather_code: nums, temperature_2m_max: nums, temperature_2m_min: nums, precipitation_probability_max: nums }),
});

/** Validates an Open-Meteo forecast body and returns up to five complete days (today first). */
export function parseForecast(body: unknown): Forecast {
  const r = forecastSchema.safeParse(body);
  if (!r.success) throw new WeatherError('Unexpected weather response', 'unavailable');
  const { current, daily, timezone } = r.data;
  const days: DayForecast[] = [];
  for (let i = 0; i < daily.time.length && days.length < 5; i++) {
    const code = daily.weather_code[i], hi = daily.temperature_2m_max[i], lo = daily.temperature_2m_min[i];
    if (code == null || hi == null || lo == null) continue;
    days.push({ date: daily.time[i], code, ...pick(describeWeather(code)), highF: Math.round(hi), lowF: Math.round(lo), precipPct: daily.precipitation_probability_max[i] ?? null });
  }
  if (!days.length) throw new WeatherError('Forecast contained no days', 'unavailable');
  const isDay = current.is_day === 1;
  return { timezone, current: { tempF: Math.round(current.temperature_2m), code: current.weather_code, isDay, ...pick(describeWeather(current.weather_code, isDay)) }, days };
}
const pick = (d: { description: string; icon: string }) => ({ description: d.description, icon: d.icon });

const zipSchema = z.object({ places: z.array(z.object({ 'place name': z.string(), latitude: z.string(), longitude: z.string(), 'state abbreviation': z.string() })).min(1) });
const geoSchema = z.object({ results: z.array(z.object({ name: z.string(), latitude: z.number(), longitude: z.number(), admin1: z.string().optional(), country_code: z.string().optional(), country: z.string().optional() })).optional() });

export class Weather {
  private inflight: Promise<void> | null = null;
  private failedUntil = 0;
  private lastError: string | null = null;
  private readonly o: Required<Pick<WeatherOptions, 'forecastBase' | 'geocodeBase' | 'zipBase'>>;
  private readonly now: () => number;
  private readonly fetchOpts: SafeFetchOptions;

  constructor(private db: DB, opts: WeatherOptions = {}) {
    this.o = { forecastBase: opts.forecastBase ?? 'https://api.open-meteo.com', geocodeBase: opts.geocodeBase ?? 'https://geocoding-api.open-meteo.com', zipBase: opts.zipBase ?? 'https://api.zippopotam.us' };
    this.now = opts.now ?? Date.now;
    this.fetchOpts = { timeoutMs: 8000, maxBytes: 300_000, retries: 1, ...opts.fetchOpts } as SafeFetchOptions;
  }

  location(): WeatherLocation { return getSetting<WeatherLocation>(this.db, 'weather_location', DEFAULT_LOCATION); }

  /** Persists the choice (shared by every device and surviving deploys via the SQLite volume). No write when unchanged. */
  setLocation(loc: WeatherLocation): WeatherLocation {
    const cur = this.location();
    if (cur.lat !== loc.lat || cur.lon !== loc.lon || cur.label !== loc.label || cur.zip !== loc.zip) {
      setSetting(this.db, 'weather_location', loc);
      this.failedUntil = 0; this.lastError = null;
    }
    return loc;
  }

  private cache(loc: WeatherLocation): { fetchedAt: number; forecast: Forecast } | null {
    const c = getSetting<{ lat: number; lon: number; fetchedAt: number; forecast: Forecast } | null>(this.db, 'weather_cache', null);
    return c && c.lat === loc.lat && c.lon === loc.lon ? c : null; // a cache for another location is never shown
  }

  /** Stale-while-revalidate: serves cached data immediately; only a missing cache waits (briefly) for the first fetch. */
  async get(): Promise<WeatherView> {
    const location = this.location();
    let cached = this.cache(location);
    const now = this.now();
    const stale = !cached || now - cached.fetchedAt > TTL_MS;
    if (stale && !this.inflight && now >= this.failedUntil) void this.refresh(location);
    if (!cached && this.inflight) {
      await Promise.race([this.inflight, new Promise((r) => setTimeout(r, 4000).unref())]);
      cached = this.cache(location);
    }
    return { location, forecast: cached?.forecast ?? null, fetchedAt: cached?.fetchedAt ?? null, stale: !cached || this.now() - cached.fetchedAt > TTL_MS, refreshing: this.inflight !== null, error: this.lastError };
  }

  private refresh(loc: WeatherLocation): Promise<void> {
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const u = new URL('/v1/forecast', this.o.forecastBase);
        u.search = new URLSearchParams({
          latitude: String(loc.lat), longitude: String(loc.lon), current: 'temperature_2m,weather_code,is_day',
          daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max',
          temperature_unit: 'fahrenheit', timezone: 'auto', forecast_days: '5',
        }).toString();
        const res = await fetchWithRetry(u.toString(), this.fetchOpts);
        if (res.status !== 200) throw new WeatherError(`Weather service returned HTTP ${res.status}`, 'unavailable');
        let body: unknown;
        try { body = JSON.parse(res.text()); } catch { throw new WeatherError('Weather service returned invalid data', 'unavailable'); }
        const forecast = parseForecast(body);
        if (this.location().lat === loc.lat && this.location().lon === loc.lon) { // location may have changed mid-flight
          setSetting(this.db, 'weather_cache', { lat: loc.lat, lon: loc.lon, fetchedAt: this.now(), forecast });
        }
        this.lastError = null; this.failedUntil = 0;
      } catch (e) {
        this.lastError = e instanceof WeatherError ? e.message : 'Weather service is unreachable';
        this.failedUntil = this.now() + FAILURE_BACKOFF_MS; // don't hammer a failing upstream; last good data keeps showing
      } finally { this.inflight = null; }
    })();
    return this.inflight;
  }

  /** US ZIP -> coordinates via Zippopotam.us (Open-Meteo's geocoder does not resolve ZIP codes). Null if unknown. */
  async lookupZip(zip: string): Promise<WeatherLocation | null> {
    if (!/^\d{5}$/.test(zip)) return null;
    let res;
    try { res = await fetchWithRetry(new URL(`/us/${zip}`, this.o.zipBase).toString(), this.fetchOpts); } catch { throw new WeatherError('ZIP lookup service is unreachable', 'unavailable'); }
    if (res.status === 404) return null;
    if (res.status !== 200) throw new WeatherError(`ZIP lookup returned HTTP ${res.status}`, 'unavailable');
    const r = zipSchema.safeParse(safeJson(res.text()));
    if (!r.success) throw new WeatherError('Unexpected ZIP lookup response', 'unavailable');
    const p = r.data.places[0]; const lat = Number(p.latitude), lon = Number(p.longitude);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new WeatherError('Unexpected ZIP lookup response', 'unavailable');
    return { label: `${p['place name']}, ${p['state abbreviation']} ${zip}`, lat, lon, zip };
  }

  /** City search via Open-Meteo's geocoding API. "City, State" narrows results by state/country text when it matches any. */
  async searchCities(query: string): Promise<WeatherLocation[]> {
    const [name, region] = query.split(',').map((s) => s.trim());
    if (!name || name.length < 2) return [];
    const u = new URL('/v1/search', this.o.geocodeBase);
    u.search = new URLSearchParams({ name, count: '10', language: 'en', format: 'json' }).toString();
    let res;
    try { res = await fetchWithRetry(u.toString(), this.fetchOpts); } catch { throw new WeatherError('City search is unreachable', 'unavailable'); }
    if (res.status !== 200) throw new WeatherError(`City search returned HTTP ${res.status}`, 'unavailable');
    const r = geoSchema.safeParse(safeJson(res.text()));
    if (!r.success) throw new WeatherError('Unexpected city search response', 'unavailable');
    let hits = r.data.results ?? [];
    if (region) { const f = hits.filter((h) => [h.admin1, h.country, h.country_code].some((x) => x?.toLowerCase().startsWith(region.toLowerCase()))); if (f.length) hits = f; }
    return hits.slice(0, 6).map((h) => ({ label: [h.name, h.admin1 ?? h.country].filter(Boolean).join(', '), lat: h.latitude, lon: h.longitude, zip: null }));
  }
}

function safeJson(t: string): unknown { try { return JSON.parse(t); } catch { return null; } }

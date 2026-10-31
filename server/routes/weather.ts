import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { Weather, WeatherError, publicLabel } from '../weather/weather.js';

export function registerWeather(app: FastifyInstance, weather: Weather) {
  const limited = { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } };
  const fail = (e: unknown) => {
    if (e instanceof WeatherError) return { code: e.kind === 'not_found' ? 404 : 502, body: { error: e.kind, message: e.message } };
    throw e;
  };

  app.get('/api/weather', { config: { rateLimit: { max: (req: any) => (req.session ? 300 : 60), timeWindow: '1 minute' } } }, async (req) => {
    // The owner's visit may refresh a stale forecast. A visitor only reads what is stored (no upstream request, no waiting) and sees the place by name:
    // never the coordinates or the ZIP code, in the fields or in the label.
    const view = req.session ? await weather.get() : weather.peek();
    return {
    ...(req.session ? view : { ...view, location: { label: publicLabel(view.location.label), lat: null, lon: null, zip: null } }),
    attribution: [{ text: 'Weather data by Open-Meteo.com (CC BY 4.0, non-commercial use)', url: 'https://open-meteo.com/' }, { text: 'ZIP lookup by Zippopotam.us', url: 'https://www.zippopotam.us/' }],
  }; });

  app.get('/api/weather/search', limited, async (req, reply) => {
    const { q } = z.object({ q: z.string().trim().min(2).max(60) }).parse(req.query);
    try {
      if (/^\d{5}$/.test(q)) { const loc = await weather.lookupZip(q); return loc ? [loc] : []; }
      return await weather.searchCities(q);
    } catch (e) { const f = fail(e); return reply.code(f.code).send(f.body); }
  });

  app.put('/api/weather/location', limited, async (req, reply) => {
    const body = z.union([
      z.object({ zip: z.string().regex(/^\d{5}$/, 'ZIP code must be 5 digits') }),
      z.object({ label: z.string().trim().min(1).max(100), lat: z.number().min(-90).max(90), lon: z.number().min(-180).max(180) }),
    ]).parse(req.body);
    try {
      if ('zip' in body) {
        const loc = await weather.lookupZip(body.zip);
        if (!loc) return reply.code(404).send({ error: 'zip_not_found', message: `No location found for ZIP ${body.zip}` });
        weather.setLocation(loc);
      } else weather.setLocation({ label: body.label, lat: body.lat, lon: body.lon, zip: null });
    } catch (e) { const f = fail(e); return reply.code(f.code).send(f.body); }
    return weather.get(); // awaits the first fetch for a new location, so the UI can render immediately
  });
}

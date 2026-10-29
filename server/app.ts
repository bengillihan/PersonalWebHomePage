import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import cookie from '@fastify/cookie';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import { ZodError } from 'zod';
import type { Config } from './config.js';
import type { DB } from './db.js';
import { Ai, createGeminiTransport, type AiTransport } from './ai/gemini.js';
import { Refresher } from './news/ingest.js';
import { MarketService } from './market/service.js';
import { createTwelveData, CreditLimiter, type MarketProvider } from './market/provider.js';
import { registerAuth, createGoogleOidc, type OidcClient } from './auth.js';
import { registerApi } from './routes/api.js';
import { checkPersistence, type PersistenceReport } from './storage.js';
import { Weather, type WeatherOptions } from './weather/weather.js';
import { registerWeather } from './routes/weather.js';
import { registerBlocked } from './routes/blocked.js';
import { FetchError } from './net/safeFetch.js';
import { redactUrl, scrubSecrets } from './logging.js';

export interface AppOverrides { oidc?: OidcClient | null; transport?: AiTransport | null; provider?: MarketProvider; fetchOpts?: { allowPrivate?: boolean }; logger?: boolean; logStream?: { write(msg: string): void }; weather?: WeatherOptions; persistence?: PersistenceReport }
export interface Built { app: FastifyInstance; refresher: Refresher; ai: Ai; market: MarketService }

export async function buildApp(cfg: Config, db: DB, o: AppOverrides = {}): Promise<Built> {
  const app = Fastify({
    logger: o.logger === false ? false : { level: cfg.isProd ? 'info' : 'debug', redact: ['req.headers.cookie', 'req.headers.authorization', 'req.headers["x-csrf-token"]'],
      // the default serializer logs the raw URL, which includes OAuth codes and search text
      serializers: { req: (req: any) => ({ method: req.method, url: redactUrl(req.url), host: req.host, remoteAddress: req.ip, remotePort: req.socket?.remotePort }) },
      ...(o.logStream ? { stream: o.logStream } : {}) },
    trustProxy: true, // Railway terminates TLS in front of the app
    bodyLimit: 256 * 1024,
  });
  await app.register(cookie, { secret: cfg.sessionSecret || 'insecure-test-secret' });
  await app.register(helmet, { contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], imgSrc: ["'self'", 'https:', 'data:'], styleSrc: ["'self'", "'unsafe-inline'"], scriptSrc: ["'self'"], connectSrc: ["'self'"], frameAncestors: ["'none'"], formAction: ["'self'", 'https://accounts.google.com'] } }, referrerPolicy: { policy: 'no-referrer' } });
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });

  const transport = o.transport !== undefined ? o.transport : cfg.geminiApiKey ? createGeminiTransport(cfg.geminiApiKey, cfg.geminiModel) : null;
  const ai = new Ai(db, cfg.geminiModel, transport, cfg.aiDailyBudget);
  const provider = o.provider ?? createTwelveData(cfg.twelveDataKey, undefined, {}, new CreditLimiter(db, cfg.twelveDataCreditsPerMinute));
  const market = new MarketService(db, provider);
  const refresher = new Refresher({ db, ai, log: app.log as any, fetchOpts: o.fetchOpts });
  const oidc = o.oidc !== undefined ? o.oidc : cfg.googleClientId && cfg.googleClientSecret ? createGoogleOidc(cfg) : null;

  registerAuth(app, cfg, db, oidc);
  registerApi(app, { cfg, db, ai, refresher, market, provider, fetchOpts: o.fetchOpts, persistence: o.persistence ?? checkPersistence({ sqlitePath: cfg.sqlitePath, required: false, allowEphemeral: false, volumePath: cfg.persistentVolumePath }) });
  registerBlocked(app, db);
  registerWeather(app, new Weather(db, { fetchOpts: o.fetchOpts, ...o.weather }));

  // Optional external trigger (e.g. a Railway cron service calling curl). Off unless CRON_TOKEN (>=32 chars) is set.
  // The web app itself never polls: this is the only way refreshes happen without a user request.
  if (cfg.cronToken) {
    const want = Buffer.from(cfg.cronToken);
    app.post('/internal/refresh', { config: { rateLimit: { max: 6, timeWindow: '1 minute' } } }, async (req, reply) => {
      const got = Buffer.from(String(req.headers.authorization ?? '').replace(/^Bearer /, ''));
      if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) return reply.code(401).send({ error: 'unauthorized' });
      void refresher.trigger('cron').catch(() => {}); void market.refreshIfNeeded().catch(() => {});
      return reply.code(202).send({ ok: true });
    });
  }

  app.get('/health', { config: { rateLimit: false } }, async () => ({ ok: true }));

  app.setErrorHandler((err: any, req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: 'invalid_input', issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    if (err instanceof FetchError) return reply.code(err.code === 'not_found' ? 404 : 422).send({ error: err.code, message: err.message });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.code ?? 'error', message: err.message });
    req.log.error({ err: { message: scrubSecrets(String(err.message)), stack: cfg.isProd || !err.stack ? undefined : scrubSecrets(err.stack) }, url: redactUrl(req.url) }, 'unhandled error');
    return reply.code(500).send({ error: 'internal_error' });
  });

  const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../web');
  if (fs.existsSync(webDir)) {
    await app.register(fastifyStatic, { root: webDir, wildcard: false, setHeaders: (res, p) => { res.header('cache-control', p.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache'); } });
    app.setNotFoundHandler((req, reply) => {
      if (req.method !== 'GET' || /^\/(api|auth|internal)\//.test(req.url)) return reply.code(404).send({ error: 'not_found' });
      return reply.header('cache-control', 'no-cache').sendFile('index.html');
    });
  }
  return { app, refresher, ai, market };
}

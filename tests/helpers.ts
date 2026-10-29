import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { loadConfig, type Config } from '../server/config.js';
import { openDb, type DB } from '../server/db.js';

export const memDb = (): DB => openDb(':memory:');

export function testConfig(over: Record<string, string> = {}): Config {
  return loadConfig({ NODE_ENV: 'test', SESSION_SECRET: 'x'.repeat(40), ALLOWED_GOOGLE_EMAIL: 'me@example.com', GOOGLE_CLIENT_ID: 'cid', GOOGLE_CLIENT_SECRET: 'sec', PUBLIC_BASE_URL: 'http://localhost:3000', PORT: '3000', ...over } as any);
}

export const rss = (items: { title: string; link: string; date: Date; desc?: string }[], title = 'Test Feed') =>
  `<?xml version="1.0"?><rss version="2.0"><channel><title>${title}</title>${items.map((i) =>
    `<item><title>${i.title}</title><link>${i.link}</link><pubDate>${i.date.toUTCString()}</pubDate>${i.desc ? `<description>${i.desc}</description>` : ''}</item>`).join('')}</channel></rss>`;

export interface Fixture { url: string; close(): Promise<void>; routes: Map<string, { status?: number; type?: string; body: string | Buffer; headers?: Record<string, string> }>; hits: string[] }

export async function fixtureServer(): Promise<Fixture> {
  const routes: Fixture['routes'] = new Map(); const hits: string[] = [];
  const srv = http.createServer((req, res) => {
    hits.push(req.url!);
    const r = routes.get(req.url!);
    if (!r) { res.statusCode = 404; return res.end('nope'); }
    res.writeHead(r.status ?? 200, { 'content-type': r.type ?? 'application/rss+xml', ...r.headers });
    res.end(r.body);
  });
  await new Promise<void>((ok) => srv.listen(0, '127.0.0.1', ok));
  const port = (srv.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}`, routes, hits, close: () => new Promise((ok) => srv.close(() => ok())) };
}

export const logger = { info() {}, warn() {}, error() {} };
export const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

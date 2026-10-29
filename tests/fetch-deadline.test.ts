import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { safeFetch } from '../server/net/safeFetch.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('#4 fetch timeouts bound the total request duration', () => {
  const servers: http.Server[] = [];
  afterEach(async () => { for (const s of servers.splice(0)) { s.closeAllConnections(); await new Promise((r) => s.close(r)); } });
  const serve = async (handler: http.RequestListener) => { const s = http.createServer(handler); servers.push(s); await new Promise<void>((r) => s.listen(0, '127.0.0.1', r)); return `http://127.0.0.1:${(s.address() as AddressInfo).port}`; };

  it('REGRESSION: a server that trickles bytes forever is cut off at the deadline (an idle timeout never fires)', async () => {
    const base = await serve((_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); const t = setInterval(() => res.write('x'), 20); setTimeout(() => { clearInterval(t); res.end(); }, 1500); res.on('close', () => clearInterval(t)); });
    const t0 = Date.now();
    await expect(safeFetch(base + '/', { allowPrivate: true, timeoutMs: 100 })).rejects.toMatchObject({ code: 'timeout' });
    expect(Date.now() - t0).toBeLessThan(700); // before the fix it ran to completion after ~1.5s
  });

  it('the deadline spans redirect hops: each hop is quick but the chain is not allowed to exceed the total', async () => {
    const base = await serve(async (req, res) => { await sleep(80); if (req.url === '/r1') { res.writeHead(302, { location: '/r2' }); return res.end(); } if (req.url === '/r2') { res.writeHead(302, { location: '/r3' }); return res.end(); } res.end('done'); });
    await expect(safeFetch(base + '/r1', { allowPrivate: true, timeoutMs: 150 })).rejects.toMatchObject({ code: 'timeout' });
    expect((await safeFetch(base + '/r1', { allowPrivate: true, timeoutMs: 2000 })).text()).toBe('done'); // fine with an adequate budget
  });

  it('normal and moderately slow responses still succeed within the limit', async () => {
    const base = await serve(async (_req, res) => { await sleep(60); res.end('hello'); });
    expect((await safeFetch(base + '/', { allowPrivate: true, timeoutMs: 1000 })).text()).toBe('hello');
  });
});

import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import { isBlockedIp, validateUrl, safeFetch, fetchWithRetry } from '../server/net/safeFetch.js';
import { fixtureServer, type Fixture } from './helpers.js';

describe('SSRF defenses', () => {
  it.each(['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', '::', 'fe80::1', 'fc00::1', 'fd12::1', '::ffff:127.0.0.1', '::ffff:7f00:1', '224.0.0.1'])('blocks %s', (ip) => {
    expect(isBlockedIp(ip)).toBe(true);
  });
  it.each(['8.8.8.8', '1.1.1.1', '151.101.1.1', '2606:4700:4700::1111'])('allows public %s', (ip) => { expect(isBlockedIp(ip)).toBe(false); });
  it('rejects bad URLs, schemes, credentials, ports, literal private IPs', () => {
    for (const u of ['ftp://x.com/', 'file:///etc/passwd', 'javascript:alert(1)', 'not a url', 'http://user:pw@example.com/', 'http://example.com:6379/', 'http://127.0.0.1/', 'http://[::1]/', 'http://localhost/', 'http://169.254.169.254/latest/meta-data', 'http://foo.internal/'])
      expect(() => validateUrl(u), u).toThrow();
    expect(() => validateUrl('https://example.com/feed')).not.toThrow();
  });
  it('blocks hostnames that resolve to loopback (DNS check at connect time)', async () => {
    await expect(safeFetch('http://localtest.me/')).rejects.toThrow(); // either blocked_ip or network error offline; never a response
  });
});

describe('safeFetch limits (fixture server, private allowed only for tests)', () => {
  let fx: Fixture;
  beforeAll(async () => { fx = await fixtureServer(); });
  afterAll(async () => { await fx.close(); });
  const o = { allowPrivate: true };

  it('refuses private destinations by default', async () => {
    fx.routes.set('/a', { body: 'hi' });
    await expect(safeFetch(fx.url + '/a')).rejects.toMatchObject({ code: expect.stringMatching(/blocked_/) });
  });
  it('refuses private first hops, so a redirect chain can never start inside the network', async () => {
    fx.routes.set('/r', { status: 302, body: '', headers: { location: 'http://169.254.169.254/latest' } });
    await expect(safeFetch(fx.url + '/r')).rejects.toMatchObject({ code: expect.stringMatching(/blocked_/) });
  });
  it('limits redirect chains', async () => {
    fx.routes.set('/loop', { status: 302, body: '', headers: { location: '/loop' } });
    await expect(safeFetch(fx.url + '/loop', { ...o, maxRedirects: 3 })).rejects.toMatchObject({ code: 'too_many_redirects' });
  });
  it('enforces response size cap', async () => {
    fx.routes.set('/big', { body: 'x'.repeat(50_000) });
    await expect(safeFetch(fx.url + '/big', { ...o, maxBytes: 1000 })).rejects.toMatchObject({ code: 'too_large' });
  });
  it('returns small bodies and does not retry permanent errors', async () => {
    fx.routes.set('/ok', { body: 'hello' });
    expect((await safeFetch(fx.url + '/ok', o)).text()).toBe('hello');
    await expect(fetchWithRetry('http://127.0.0.1/', { retries: 3 })).rejects.toMatchObject({ code: 'blocked_ip' });
  });
  it('times out slow servers', async () => {
    const http = await import('node:http');
    const slow = http.createServer(() => { /* never respond */ });
    await new Promise<void>((r) => slow.listen(0, '127.0.0.1', r));
    const port = (slow.address() as any).port;
    await expect(safeFetch(`http://127.0.0.1:${port}/`, { ...o, timeoutMs: 200 })).rejects.toMatchObject({ code: 'timeout' });
    slow.closeAllConnections(); slow.close();
  });
});

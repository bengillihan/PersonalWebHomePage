import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns';
import net from 'node:net';
import zlib from 'node:zlib';

export class FetchError extends Error {
  constructor(message: string, public code: string, public status?: number) { super(message); }
}

export const USER_AGENT = 'PersonalNewsDashboard/1.0 (+personal feed reader; respects robots/feeds)';

/** True for loopback, private, link-local, CGNAT, multicast, reserved and mapped-private addresses. */
export function isBlockedIp(ip: string): boolean {
  const v = net.isIP(ip);
  if (v === 4) return blockedV4(ip);
  if (v === 6) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return blockedV4(mapped[1]);
    const mappedHex = lower.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) {
      const a = parseInt(mappedHex[1], 16), b = parseInt(mappedHex[2], 16);
      return blockedV4(`${a >> 8}.${a & 255}.${b >> 8}.${b & 255}`);
    }
    const first = parseInt(lower.split(':')[0] || '0', 16);
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
    if ((first & 0xff00) === 0xff00) return true; // multicast
    if (lower.startsWith('64:ff9b:')) return true; // NAT64
    if (lower.startsWith('2001:db8')) return true; // documentation
    return false;
  }
  return true; // not an IP: fail closed
}

function blockedV4(ip: string): boolean {
  const [a, b] = ip.split('.').map(Number);
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

/** Parses and validates a user-supplied URL (scheme, credentials, port, literal IP hosts). */
export function validateUrl(input: string, opts: { allowPrivate?: boolean } = {}): URL {
  let u: URL;
  try { u = new URL(input.trim()); } catch { throw new FetchError('Invalid URL', 'invalid_url'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new FetchError('Only http(s) URLs are allowed', 'invalid_scheme');
  if (u.username || u.password) throw new FetchError('Credentials in URLs are not allowed', 'invalid_url');
  if (!opts.allowPrivate) {
    const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
    if (port !== 80 && port !== 443) throw new FetchError('Only ports 80 and 443 are allowed', 'blocked_port');
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && isBlockedIp(host)) throw new FetchError('Destination address is not allowed', 'blocked_ip');
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) throw new FetchError('Destination host is not allowed', 'blocked_host');
  }
  return u;
}

export interface SafeFetchOptions {
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
  headers?: Record<string, string>;
  /** Tests only: permit private destinations (e.g. a local fixture server). */
  allowPrivate?: boolean;
}
export interface SafeResponse { status: number; url: string; headers: http.IncomingHttpHeaders; body: Buffer; text(): string }

export async function safeFetch(input: string, opts: SafeFetchOptions = {}): Promise<SafeResponse> {
  const { timeoutMs = 10_000, maxBytes = 2_000_000, maxRedirects = 4 } = opts;
  let url = validateUrl(input, opts);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const res = await once(url, opts, timeoutMs, maxBytes);
    if ([301, 302, 303, 307, 308].includes(res.status) && res.headers.location) {
      if (hop === maxRedirects) throw new FetchError('Too many redirects', 'too_many_redirects');
      url = validateUrl(new URL(String(res.headers.location), url).toString(), opts);
      continue;
    }
    return res;
  }
  throw new FetchError('Too many redirects', 'too_many_redirects');
}

function once(url: URL, opts: SafeFetchOptions, timeoutMs: number, maxBytes: number): Promise<SafeResponse> {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http;
    // The lookup validates the exact address the socket will connect to, which defeats DNS rebinding.
    const lookup: net.LookupFunction = (hostname, options, cb) => {
      dns.lookup(hostname, { ...options, all: true }, (err, addrs) => {
        if (err) return (cb as any)(err);
        const list = addrs as dns.LookupAddress[];
        if (!opts.allowPrivate) {
          const bad = list.find((a) => isBlockedIp(a.address));
          if (bad) return (cb as any)(new FetchError('Destination resolves to a blocked address', 'blocked_ip'));
        }
        if ((options as any).all) return (cb as any)(null, list);
        (cb as any)(null, list[0].address, list[0].family);
      });
    };
    let settled = false;
    const fail = (e: unknown) => { if (!settled) { settled = true; reject(e instanceof FetchError ? e : new FetchError(String((e as Error)?.message ?? e), (e as any)?.code ?? 'network_error')); } };
    const req = lib.request(url, {
      method: 'GET', lookup,
      headers: { 'user-agent': USER_AGENT, accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.8, application/json;q=0.7, */*;q=0.5', 'accept-encoding': 'gzip, deflate', ...opts.headers },
    }, (res) => {
      const enc = String(res.headers['content-encoding'] ?? '').toLowerCase();
      const stream: NodeJS.ReadableStream = enc === 'gzip' ? res.pipe(zlib.createGunzip()) : enc === 'deflate' ? res.pipe(zlib.createInflate()) : res;
      const chunks: Buffer[] = []; let size = 0;
      const declared = Number(res.headers['content-length'] ?? 0);
      if (declared > maxBytes * 4 && !enc) { req.destroy(); return fail(new FetchError('Response too large', 'too_large')); }
      stream.on('data', (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) { req.destroy(); fail(new FetchError(`Response exceeds ${maxBytes} bytes`, 'too_large')); return; }
        chunks.push(c);
      });
      stream.on('end', () => {
        if (settled) return; settled = true;
        const body = Buffer.concat(chunks);
        resolve({ status: res.statusCode ?? 0, url: url.toString(), headers: res.headers, body, text: () => decode(body, String(res.headers['content-type'] ?? '')) });
      });
      stream.on('error', fail);
    });
    req.setTimeout(timeoutMs, () => { req.destroy(); fail(new FetchError('Request timed out', 'timeout')); });
    req.on('error', fail);
    req.end();
  });
}

function decode(buf: Buffer, contentType: string): string {
  const head = buf.subarray(0, 200).toString('latin1');
  const label = (/charset=([\w-]+)/i.exec(contentType)?.[1] ?? /encoding=["']([\w-]+)["']/i.exec(head)?.[1] ?? 'utf-8').toLowerCase();
  try { return new TextDecoder(label).decode(buf); } catch { return buf.toString('utf8'); }
}

/** Retries transient failures (timeouts, 5xx, 429) with exponential backoff + jitter. */
export async function fetchWithRetry(url: string, opts: SafeFetchOptions & { retries?: number } = {}): Promise<SafeResponse> {
  const retries = opts.retries ?? 2;
  let lastErr: unknown;
  for (let i = 0; i <= retries; i++) {
    try {
      const res = await safeFetch(url, opts);
      if (res.status === 429 || res.status >= 500) throw new FetchError(`HTTP ${res.status}`, 'http_error', res.status);
      return res;
    } catch (e) {
      lastErr = e;
      const code = (e as FetchError).code;
      if (['blocked_ip', 'blocked_host', 'blocked_port', 'invalid_url', 'invalid_scheme', 'too_large', 'too_many_redirects'].includes(code)) throw e;
      if (i < retries) await new Promise((r) => setTimeout(r, 400 * 2 ** i + Math.random() * 200));
    }
  }
  throw lastErr;
}

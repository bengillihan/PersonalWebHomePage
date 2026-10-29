/**
 * Log hygiene. Request URLs carry secrets (the OAuth callback has the authorization `code` and `state`) and private text (search terms),
 * and Fastify logs the full URL by default. Query values are therefore masked unless the parameter is on a small, known-harmless list,
 * so a new parameter can never leak by default.
 */
const SAFE_PARAMS = new Set(['tab', 'limit', 'topic', 'range', 'symbol', 'id', 'error']);

export function redactUrl(url: string): string {
  const i = url.indexOf('?');
  if (i < 0) return url;
  const parts = url.slice(i + 1).split('&').filter(Boolean).map((kv) => {
    const eq = kv.indexOf('='); const key = eq < 0 ? kv : kv.slice(0, eq);
    let name = key; try { name = decodeURIComponent(key); } catch { /* keep raw */ }
    return SAFE_PARAMS.has(name.toLowerCase()) ? kv : `${key}=[redacted]`;
  });
  return parts.length ? `${url.slice(0, i)}?${parts.join('&')}` : url.slice(0, i);
}

/** Masks credential-looking `name=value` pairs and bearer tokens inside free text such as error messages and stack traces. */
export function scrubSecrets(text: string): string {
  return text
    .replace(/\b(code|state|token|access_token|id_token|refresh_token|client_secret|api_?key|key|secret|password|signature)=([^&\s"'<>]+)/gi, '$1=[redacted]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]');
}

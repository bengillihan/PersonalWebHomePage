import { describe, it, expect, afterEach } from 'vitest';
import { memDb, testConfig } from './helpers.js';
import { redactUrl, scrubSecrets } from '../server/logging.js';
import { buildApp } from '../server/app.js';
import type { OidcClient } from '../server/auth.js';
import type { DB } from '../server/db.js';

let db: DB;

describe('#2 logs never contain OAuth codes or other query secrets', () => {
  it('redactUrl masks query values unless the parameter is known-harmless', () => {
    expect(redactUrl('/auth/callback?code=4%2F0AbCd&state=xyz123')).toBe('/auth/callback?code=[redacted]&state=[redacted]');
    expect(redactUrl('/api/feed?tab=latest&limit=20&q=private+words&cursor=abc&topic=Business')).toBe('/api/feed?tab=latest&limit=20&q=[redacted]&cursor=[redacted]&topic=Business');
    expect(redactUrl('/auth/callback?error=access_denied&error_description=secret+text')).toBe('/auth/callback?error=access_denied&error_description=[redacted]');
    expect(redactUrl('/x?%63ode=abc&flag')).toBe('/x?%63ode=[redacted]&flag=[redacted]'); // percent-encoded names are decoded before checking
    expect(redactUrl('/health')).toBe('/health'); expect(redactUrl('/x?')).toBe('/x');
  });
  it('scrubSecrets masks credential-looking pairs and bearer tokens in free text', () => {
    expect(scrubSecrets('failed: code=4/0AbCd state=zz&token=t1 Authorization: Bearer abc.def-ghi ok')).toBe('failed: code=[redacted] state=[redacted]&token=[redacted] Authorization: Bearer [redacted] ok');
    expect(scrubSecrets('plain message')).toBe('plain message');
  });

  const lines: string[] = []; const logStream = { write: (m: string) => { lines.push(m); } };
  const oidc: OidcClient & { nonce?: string; fail?: boolean } = {
    authUrl: ({ state, nonce }) => `https://x/?state=${state}&nonce=${nonce}`,
    async exchange() { if (oidc.fail) throw new Error('upstream rejected request: code=UPSTREAMSECRET state=zzz'); return { sub: 's', email: 'me@example.com', emailVerified: true, name: 'Me', nonce: oidc.nonce ?? null }; },
  };
  afterEach(() => { lines.length = 0; });
  const logged = () => lines.join('');

  it('REGRESSION: the request log for a dummy OAuth callback no longer contains the code or state', async () => {
    db = memDb();
    const { app } = await buildApp(testConfig(), db, { oidc, logStream, transport: null });
    await app.inject({ url: '/auth/callback?code=SECRETCODE123&state=SECRETSTATE456' });
    await app.close();
    expect(lines.length).toBeGreaterThan(0); // the request IS logged...
    expect(logged()).toContain('/auth/callback?code=[redacted]&state=[redacted]'); // ...with masked values
    expect(logged()).not.toContain('SECRETCODE123'); expect(logged()).not.toContain('SECRETSTATE456');
  });

  it('error logs are sanitized too: unhandled errors and failed OAuth exchanges', async () => {
    db = memDb();
    const { app } = await buildApp(testConfig(), db, { oidc, logStream, transport: null });
    app.get('/boom', async () => { throw new Error('exploded code=ERRORSECRET789 while handling the request'); });
    await app.inject({ url: '/boom?code=QUERYSECRET321&q=private+search' });
    const r1 = await app.inject({ url: '/auth/login' }); const loc = new URL(r1.headers.location as string);
    oidc.nonce = loc.searchParams.get('nonce')!; oidc.fail = true;
    await app.inject({ url: `/auth/callback?code=THECODEVALUE&state=${loc.searchParams.get('state')}`, cookies: { oauth_tx: r1.cookies[0].value } });
    oidc.fail = false; await app.close();
    expect(logged()).toContain('unhandled error'); expect(logged()).toContain('oauth callback failed');
    for (const secret of ['ERRORSECRET789', 'QUERYSECRET321', 'private+search', 'private search', 'UPSTREAMSECRET', 'THECODEVALUE', String(loc.searchParams.get('state'))]) expect(logged(), secret).not.toContain(secret);
  });
});


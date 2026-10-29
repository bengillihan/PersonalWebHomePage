import crypto from 'node:crypto';
import { OAuth2Client, CodeChallengeMethod } from 'google-auth-library';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Config } from './config.js';
import type { DB } from './db.js';

export interface OidcIdentity { sub: string; email: string; emailVerified: boolean; name: string | null; nonce: string | null }
export interface OidcClient {
  authUrl(p: { state: string; nonce: string; codeChallenge: string }): string;
  exchange(code: string, codeVerifier: string): Promise<OidcIdentity>;
}

export function createGoogleOidc(cfg: Config): OidcClient {
  const client = new OAuth2Client({ clientId: cfg.googleClientId, clientSecret: cfg.googleClientSecret, redirectUri: `${cfg.publicBaseUrl}/auth/callback` });
  return {
    authUrl: ({ state, nonce, codeChallenge }) => client.generateAuthUrl({
      access_type: 'online', scope: ['openid', 'email', 'profile'], state, prompt: 'select_account',
      code_challenge: codeChallenge, code_challenge_method: CodeChallengeMethod.S256, nonce,
    } as any),
    async exchange(code, codeVerifier) {
      const { tokens } = await client.getToken({ code, codeVerifier });
      if (!tokens.id_token) throw new Error('No id_token returned');
      const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: cfg.googleClientId }); // signature, aud, exp, iss
      const p = ticket.getPayload();
      if (!p?.sub || !p.email) throw new Error('Incomplete identity');
      return { sub: p.sub, email: p.email, emailVerified: p.email_verified === true, name: p.name ?? null, nonce: (p as any).nonce ?? null };
    },
  };
}

const SESSION_DAYS = 14;
const b64 = (n: number) => crypto.randomBytes(n).toString('base64url');
const hmac = (secret: string, v: string) => crypto.createHmac('sha256', secret).update(v).digest('hex');
const safeEq = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };

export interface Session { userId: number; email: string; name: string | null; csrf: string }
declare module 'fastify' { interface FastifyRequest { session: Session | null } }

export function registerAuth(app: FastifyInstance, cfg: Config, db: DB, oidc: OidcClient | null) {
  const sidName = cfg.secureCookies ? '__Host-sid' : 'sid';
  const txName = cfg.secureCookies ? '__Host-oauth_tx' : 'oauth_tx';
  const baseCookie = { httpOnly: true, secure: cfg.secureCookies, sameSite: 'lax' as const, path: '/' };

  function createSession(userId: number): { token: string; csrf: string } {
    const token = b64(32); const csrf = b64(24); const now = Date.now();
    db.prepare('INSERT INTO sessions (id_hash, user_id, csrf_token, created_at, expires_at) VALUES (?,?,?,?,?)').run(hmac(cfg.sessionSecret, token), userId, csrf, now, now + SESSION_DAYS * 86_400_000);
    return { token, csrf };
  }
  function startSession(reply: FastifyReply, email: string, sub: string, name: string | null) {
    const now = Date.now();
    db.prepare(`INSERT INTO users (google_sub, email, name, created_at, last_login_at) VALUES (?,?,?,?,?)
      ON CONFLICT(google_sub) DO UPDATE SET email=excluded.email, name=excluded.name, last_login_at=excluded.last_login_at`).run(sub, email, name, now, now);
    const user = db.prepare('SELECT id FROM users WHERE google_sub = ?').get(sub) as { id: number };
    const { token } = createSession(user.id);
    reply.setCookie(sidName, token, { ...baseCookie, maxAge: SESSION_DAYS * 86_400 });
  }

  app.decorateRequest('session', null);
  app.addHook('onRequest', async (req) => {
    const token = req.cookies[sidName];
    if (!token) return;
    const row = db.prepare(`SELECT s.csrf_token, s.expires_at, u.id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id_hash = ?`).get(hmac(cfg.sessionSecret, token)) as any;
    if (!row || row.expires_at < Date.now() || row.email.toLowerCase() !== cfg.allowedEmail) return; // allowlist re-checked on every request
    req.session = { userId: row.id, email: row.email, name: row.name, csrf: row.csrf_token };
  });

  const origin = new URL(cfg.publicBaseUrl).origin;
  /** Guards the private API: session required; state-changing methods also need CSRF header + same-origin. */
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/api/')) return;
    if (!req.session) return reply.code(401).send({ error: 'unauthenticated' });
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      const hdr = String(req.headers['x-csrf-token'] ?? '');
      if (!safeEq(hdr, req.session.csrf)) return reply.code(403).send({ error: 'bad_csrf' });
      const o = req.headers.origin;
      if (o && o !== origin) return reply.code(403).send({ error: 'bad_origin' });
    }
  });

  const authLimit = { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } };

  app.get('/auth/login', authLimit, async (_req, reply) => {
    if (!oidc) return reply.code(503).send({ error: 'Google sign-in is not configured' });
    const state = b64(24), nonce = b64(24), verifier = b64(48);
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    reply.setCookie(txName, JSON.stringify({ state, nonce, verifier }), { ...baseCookie, sameSite: 'lax', maxAge: 600, signed: true });
    return reply.redirect(oidc.authUrl({ state, nonce, codeChallenge: challenge }));
  });

  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>('/auth/callback', authLimit, async (req, reply) => {
    const raw = req.cookies[txName];
    reply.clearCookie(txName, baseCookie);
    const un = raw ? req.unsignCookie(raw) : null;
    if (!oidc || !un?.valid || !un.value) return reply.code(400).send({ error: 'login_expired' });
    const tx = JSON.parse(un.value) as { state: string; nonce: string; verifier: string };
    const { code, state } = req.query;
    if (!code || !state || !safeEq(state, tx.state)) return reply.code(400).send({ error: 'bad_state' });
    try {
      const id = await oidc.exchange(code, tx.verifier);
      if (!id.nonce || !safeEq(id.nonce, tx.nonce)) return reply.code(400).send({ error: 'bad_nonce' });
      if (!id.emailVerified || id.email.toLowerCase() !== cfg.allowedEmail) {
        req.log.warn('login rejected: account not on allowlist');
        return reply.code(403).type('text/html').send('<h1>Access denied</h1><p>This dashboard is private.</p>');
      }
      startSession(reply, id.email, id.sub, id.name);
      return reply.redirect('/');
    } catch (e) {
      req.log.warn({ err: (e as Error).message }, 'oauth callback failed');
      return reply.code(400).send({ error: 'login_failed' });
    }
  });

  if (cfg.devLogin) {
    app.get('/auth/dev', async (_req, reply) => { startSession(reply, cfg.allowedEmail, 'dev-user', 'Dev User'); return reply.redirect('/'); });
  }

  app.post('/auth/logout', async (req, reply) => {
    if (req.session) {
      if (!safeEq(String(req.headers['x-csrf-token'] ?? ''), req.session.csrf)) return reply.code(403).send({ error: 'bad_csrf' });
      db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(hmac(cfg.sessionSecret, req.cookies[sidName]!));
    }
    reply.clearCookie(sidName, baseCookie);
    return { ok: true };
  });

  return { createSession, sidName, startSession };
}

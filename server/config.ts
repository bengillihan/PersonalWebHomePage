import path from 'node:path';

export interface Config {
  nodeEnv: string;
  isProd: boolean;
  port: number;
  host: string;
  publicBaseUrl: string;
  secureCookies: boolean;
  sqlitePath: string;
  sessionSecret: string;
  googleClientId: string;
  googleClientSecret: string;
  allowedEmail: string;
  geminiApiKey: string;
  geminiModel: string;
  aiDailyBudget: number;
  marketProvider: string;
  twelveDataKey: string;
  devLogin: boolean;
  cronToken: string;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const isProd = env.NODE_ENV === 'production';
  const onRailway = Boolean(env.RAILWAY_ENVIRONMENT || env.RAILWAY_PROJECT_ID);
  const port = Number(env.PORT ?? 3000);
  const publicBaseUrl = (env.PUBLIC_BASE_URL ?? `http://localhost:${port}`).replace(/\/+$/, '');
  const sessionSecret = env.SESSION_SECRET ?? '';
  const cfg: Config = {
    nodeEnv: env.NODE_ENV ?? 'development',
    isProd,
    port,
    host: isProd || onRailway ? '0.0.0.0' : '127.0.0.1',
    publicBaseUrl,
    secureCookies: publicBaseUrl.startsWith('https://'),
    sqlitePath: path.resolve(env.SQLITE_PATH ?? (onRailway ? '/data/dashboard.sqlite' : './data/dashboard.sqlite')),
    sessionSecret,
    googleClientId: env.GOOGLE_CLIENT_ID ?? '',
    googleClientSecret: env.GOOGLE_CLIENT_SECRET ?? '',
    allowedEmail: (env.ALLOWED_GOOGLE_EMAIL ?? '').trim().toLowerCase(),
    geminiApiKey: env.GEMINI_API_KEY ?? '',
    geminiModel: env.GEMINI_MODEL ?? 'gemini-3.5-flash-lite',
    aiDailyBudget: Number(env.AI_DAILY_REQUEST_BUDGET ?? 200),
    marketProvider: env.MARKET_PROVIDER ?? 'twelvedata',
    twelveDataKey: env.TWELVEDATA_API_KEY ?? '',
    devLogin: env.DEV_LOGIN === 'true' && !isProd,
    cronToken: (env.CRON_TOKEN ?? '').length >= 32 ? env.CRON_TOKEN! : '',
  };
  return cfg;
}

/** Returns human-readable problems; the server refuses to start in production if any are fatal. */
export function validateConfig(cfg: Config): string[] {
  const problems: string[] = [];
  if (cfg.sessionSecret.length < 32) problems.push('SESSION_SECRET must be at least 32 characters');
  if (!cfg.allowedEmail) problems.push('ALLOWED_GOOGLE_EMAIL is required');
  if (!cfg.devLogin) {
    if (!cfg.googleClientId) problems.push('GOOGLE_CLIENT_ID is required');
    if (!cfg.googleClientSecret) problems.push('GOOGLE_CLIENT_SECRET is required');
  }
  if (cfg.isProd && !cfg.publicBaseUrl.startsWith('https://')) problems.push('PUBLIC_BASE_URL must be https in production');
  return problems;
}

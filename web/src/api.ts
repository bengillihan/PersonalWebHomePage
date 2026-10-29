let csrf = '';
export const setCsrf = (t: string) => { csrf = t; };

export class ApiError extends Error {
  constructor(public status: number, public body: any) { super(body?.message ?? body?.error ?? `HTTP ${status}`); }
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const method = opts.method ?? 'GET';
  const res = await fetch(path, {
    method, signal: opts.signal, credentials: 'same-origin',
    headers: { ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(method !== 'GET' ? { 'x-csrf-token': csrf } : {}) },
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const text = await res.text();
  const json = text ? JSON.parse(text) : null;
  if (!res.ok) throw new ApiError(res.status, json);
  return json as T;
}

export function timeAgo(ms: number | null | undefined): string {
  if (!ms) return 'never';
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
export const fullDate = (ms: number) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

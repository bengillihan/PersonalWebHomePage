import { describe, it, expect, beforeEach } from 'vitest';
import Database from 'better-sqlite3';
import { memDb } from './helpers.js';
import { Ai, QuotaError, type AiTransport, type ArticleInput } from '../server/ai/gemini.js';
import { migrate, setSetting } from '../server/db.js';
import { MIGRATIONS } from '../server/migrations.js';
import type { DB } from '../server/db.js';

let db: DB; let n = 0;
const CATS = ['Local', 'World', 'Business', 'Other'];
const art = (): ArticleInput => { n++; return { id: n, publisher: 'Pub', title: `Title ${n}`, excerpt: 'A sufficiently long excerpt describing what happened in the story in some detail.', publishedAt: Date.now(), contentHash: `h${n}` }; };
const answer = (prompt: string) => { const ids = [...prompt.matchAll(/<article id="(\d+)"/g)].map((m) => Number(m[1])); return { text: JSON.stringify({ items: ids.map((id) => ({ id, category: 'Business', importance: 0.5, summary: 'S.' })) }), inputTokens: 100, outputTokens: 40 }; };
const row = (day?: string) => db.prepare(day ? 'SELECT * FROM ai_usage WHERE day = ?' : 'SELECT * FROM ai_usage ORDER BY day DESC LIMIT 1').get(...(day ? [day] : [])) as { day: string; requests: number; completed: number; errors: number; input_tokens: number; output_tokens: number } | undefined;
/** A transport that counts calls, can be held open, and lets a test look at the world while a request is "at Gemini". */
function slow(ms = 40, inFlight?: () => void) {
  const st = { calls: 0 };
  const transport: AiTransport = { async generateJson({ prompt }) { st.calls++; inFlight?.(); await new Promise((r) => setTimeout(r, ms)); return answer(prompt); } };
  return { st, transport };
}
beforeEach(() => { db = memDb(); });

describe('the daily Gemini budget is reserved atomically', () => {
  it('REGRESSION: two concurrent calls competing for one remaining request send exactly one', async () => {
    const { st, transport } = slow(); const ai = new Ai(db, 'm', transport, 1);
    const [r1, r2] = await Promise.all([ai.analyzeArticles([art()], CATS), ai.analyzeArticles([art()], CATS)]);
    expect(st.calls).toBe(1); // before the fix: 2, because both checked before either recorded
    expect([r1.size, r2.size].sort()).toEqual([0, 1]); // one got an answer, the other was refused and falls back locally
    expect(ai.requestsToday()).toBe(1); expect(row()).toMatchObject({ requests: 1, completed: 1, errors: 0 });
  });

  it('many concurrent calls never exceed the allowance, even across separate Ai instances sharing the database', async () => {
    const { st, transport } = slow(30); const a = new Ai(db, 'm', transport, 3), b = new Ai(db, 'm', transport, 3); // e.g. two overlapping runs
    await Promise.all(Array.from({ length: 10 }, (_, i) => (i % 2 ? a : b).analyzeArticles([art()], CATS)));
    expect(st.calls).toBe(3); expect(row()).toMatchObject({ requests: 3, completed: 3 });
  });

  it('the request is counted BEFORE it is sent, so a restart mid-call cannot hand the allowance back', async () => {
    let during: any; let restarted: Ai | undefined;
    const { st, transport } = slow(30, () => { during = { ...row()! }; restarted = new Ai(db, 'm', transport, 1); }); // a fresh instance = a restarted process
    const ai = new Ai(db, 'm', transport, 1);
    const run = ai.analyzeArticles([art()], CATS);
    await new Promise((r) => setTimeout(r, 10));
    expect(during).toMatchObject({ requests: 1, completed: 0, errors: 0 }); // reserved, not yet completed: accounted separately
    expect(restarted!.canCall()).toBe(false); expect((await restarted!.analyzeArticles([art()], CATS)).size).toBe(0); expect(st.calls).toBe(1);
    await run; expect(row()).toMatchObject({ requests: 1, completed: 1, errors: 0 });
  });

  it('a request that died mid-flight (process killed) stays counted: nothing is refunded', async () => {
    const hang: AiTransport = { generateJson: () => new Promise(() => { /* never answers: the process "dies" */ }) };
    const ai = new Ai(db, 'm', hang, 2); void ai.analyzeArticles([art()], CATS);
    await new Promise((r) => setTimeout(r, 10));
    expect(row()).toMatchObject({ requests: 1, completed: 0, errors: 0 }); // reserved and unsettled, persisted in SQLite
    const after = new Ai(db, 'm', slow(1).transport, 2); expect(after.usage()).toMatchObject({ requestsToday: 1, unsettledToday: 1 });
    await after.analyzeArticles([art()], CATS); expect((await after.analyzeArticles([art()], CATS)).size).toBe(0); // 1 reserved + 1 used = 2 of 2
  });

  it('failures and unusable answers are not refunded: they count once, as errors', async () => {
    const boom: AiTransport = { async generateJson() { throw new Error('503 unavailable'); } };
    const ai = new Ai(db, 'm', boom, 2);
    expect((await ai.analyzeArticles([art()], CATS)).size).toBe(0);
    expect(row()).toMatchObject({ requests: 1, completed: 0, errors: 1 }); expect(ai.requestsToday()).toBe(1); // the provider may have processed it
    const junk: AiTransport = { async generateJson() { return { text: 'not json at all', inputTokens: 90, outputTokens: 10 }; } };
    const ai2 = new Ai(db, 'm', junk, 2); await ai2.analyzeArticles([art()], CATS);
    expect(row()).toMatchObject({ requests: 2, completed: 0, errors: 2, input_tokens: 90, output_tokens: 10 }); // counted ONCE (not double), tokens kept
    expect(ai2.canCall()).toBe(false);
  });

  it('a quota error counts as an attempt and starts the backoff', async () => {
    const quota: AiTransport = { async generateJson() { throw new QuotaError('RESOURCE_EXHAUSTED'); } };
    const ai = new Ai(db, 'm', quota, 5); await ai.analyzeArticles([art()], CATS);
    expect(row()).toMatchObject({ requests: 1, errors: 1 }); expect(ai.canCall()).toBe(false); expect(ai.usage().backoffUntil).not.toBeNull();
  });

  it('budget 0 disables Gemini without counting anything; the setting is read on every reservation', async () => {
    const { st, transport } = slow(1); const ai = new Ai(db, 'm', transport, 0);
    expect((await ai.analyzeArticles([art()], CATS)).size).toBe(0); expect(st.calls).toBe(0); expect(row()).toBeUndefined();
    setSetting(db, 'ai_daily_budget', 1); expect((await ai.analyzeArticles([art()], CATS)).size).toBe(1); expect((await ai.analyzeArticles([art()], CATS)).size).toBe(0); expect(st.calls).toBe(1);
    setSetting(db, 'ai_daily_budget', 0); expect(ai.canCall()).toBe(false);
  });

  it('cache hits consume no allowance', async () => {
    const { st, transport } = slow(1); const ai = new Ai(db, 'm', transport, 1); const a = art();
    await ai.analyzeArticles([a], CATS); expect((await ai.analyzeArticles([a], CATS)).size).toBe(1); expect(st.calls).toBe(1); expect(row()!.requests).toBe(1);
  });
});

describe('daily reset (UTC) and attribution', () => {
  const at = (iso: string) => Date.parse(iso);
  it('REGRESSION: a request reserved just before midnight UTC is accounted to that day even if it completes after; the next day starts fresh', async () => {
    let now = at('2026-10-29T23:59:59.900Z'); const clock = () => now;
    const transport: AiTransport = { async generateJson({ prompt }) { now = at('2026-10-30T00:00:00.200Z'); return answer(prompt); } }; // the answer arrives after midnight
    const ai = new Ai(db, 'm', transport, 1, clock);
    await ai.analyzeArticles([art()], CATS);
    expect(row('2026-10-29')).toMatchObject({ requests: 1, completed: 1, input_tokens: 100, output_tokens: 40 }); // tokens belong to the day it was requested
    expect(row('2026-10-30')).toBeUndefined(); // nothing leaked into the new day
    expect(ai.requestsToday()).toBe(0); expect(ai.canCall()).toBe(true); // a new UTC day: fresh allowance
    expect((await ai.analyzeArticles([art()], CATS)).size).toBe(1); expect(row('2026-10-30')).toMatchObject({ requests: 1, completed: 1 }); expect(row('2026-10-29')!.requests).toBe(1);
  });

  it('the day is the UTC date, whatever the server time zone: 23:30 Pacific is already tomorrow in UTC', () => {
    const ai = new Ai(db, 'm', null, 5, () => at('2026-10-29T23:30:00-07:00')); // = 2026-10-30T06:30Z
    expect(ai.usage().days).toEqual([]); (db.prepare("INSERT INTO ai_usage (day, requests) VALUES ('2026-10-30', 4)").run()); expect(ai.requestsToday()).toBe(4);
  });

  it('usage() reports reserved, completed, failed and unsettled separately and says what is counted', () => {
    db.prepare("INSERT INTO ai_usage (day, requests, completed, errors, input_tokens, output_tokens) VALUES ('2026-10-29', 5, 2, 1, 300, 100)").run();
    const u = new Ai(db, 'm', null, 10, () => at('2026-10-29T12:00:00Z')).usage();
    expect(u).toMatchObject({ requestsToday: 5, completedToday: 2, failedToday: 1, unsettledToday: 2, dailyBudget: 10 }); expect(u.note).toMatch(/attempted/i);
  });
});

describe('migration 6: ai_usage.completed', () => {
  it('adds the column, backfills history consistently, and touches nothing else', () => {
    const raw = new Database(':memory:');
    raw.exec('CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)');
    for (const m of MIGRATIONS.filter((x) => x.id <= 5)) { raw.exec(m.sql); raw.prepare('INSERT INTO schema_migrations VALUES (?,?,0)').run(m.id, m.name); }
    raw.prepare("INSERT INTO ai_usage (day, requests, input_tokens, output_tokens, errors) VALUES ('2026-10-01', 10, 500, 200, 3), ('2026-10-02', 2, 50, 20, 5)").run();
    raw.prepare("INSERT INTO application_settings VALUES ('keep','1')").run();
    expect(migrate(raw as DB)).toEqual([6, 7, 8, 9, 10]);
    expect(raw.prepare('SELECT day, requests, completed, errors, input_tokens, output_tokens FROM ai_usage ORDER BY day').all()).toEqual([
      { day: '2026-10-01', requests: 10, completed: 7, errors: 3, input_tokens: 500, output_tokens: 200 }, { day: '2026-10-02', requests: 2, completed: 0, errors: 5, input_tokens: 50, output_tokens: 20 }]); // never negative
    expect(raw.prepare("SELECT value FROM application_settings WHERE key = 'keep'").get()).toEqual({ value: '1' });
    expect(migrate(raw as DB)).toEqual([]);
  });
});

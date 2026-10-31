import { describe, expect, it, vi, afterEach } from 'vitest';
import { openDb } from '../server/db.js';
import { Ai, type AiTransport } from '../server/ai/gemini.js';

afterEach(() => vi.useRealTimers());

describe('Gemini request pacing', () => {
  const make = (perMinute: number, sent: number[]) => new Ai(openDb(':memory:'), 'm', { async generateJson() { sent.push(Date.now()); return { text: JSON.stringify({ pairs: [] }), inputTokens: 1, outputTokens: 1 }; } } as AiTransport, 1000, Date.now, perMinute);
  const ask = (ai: Ai, n: number) => ai.verifyPairs([{ id: 1, a: { publisher: 'A', title: 'a' + n, publishedAt: 1 }, b: { publisher: 'B', title: 'b' + n, publishedAt: 1 } }]);

  it('never sends more than the per-minute limit in any rolling minute, even when callers arrive together', async () => {
    vi.useFakeTimers(); const sent: number[] = []; const ai = make(5, sent);
    const all = Promise.all(Array.from({ length: 12 }, (_, i) => ask(ai, i)));
    await vi.advanceTimersByTimeAsync(180_000); await all;
    expect(sent).toHaveLength(12);
    for (const t of sent) expect(sent.filter((u) => u >= t && u < t + 60_000).length).toBeLessThanOrEqual(5);
  });

  it('does not delay requests under the limit', async () => {
    const sent: number[] = []; const ai = make(12, sent); const t0 = Date.now();
    for (let i = 0; i < 12; i++) await ask(ai, i);
    expect(sent).toHaveLength(12); expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe('Gemini pacing robustness', () => {
  const transport = (sent: number[]) => ({ async generateJson() { sent.push(Date.now()); return { text: JSON.stringify({ pairs: [] }), inputTokens: 1, outputTokens: 1 }; } } as AiTransport);
  const ask = (ai: Ai, n: number) => ai.verifyPairs([{ id: 1, a: { publisher: 'A', title: 'a' + n, publishedAt: 1 }, b: { publisher: 'B', title: 'b' + n, publishedAt: 1 } }]);

  it('a late timer (paused process) cannot release more than the limit in a rolling minute', async () => {
    vi.useFakeTimers(); const sent: number[] = []; const ai = new Ai(openDb(':memory:'), 'm', transport(sent), 1000, Date.now, 12);
    const all = Promise.all(Array.from({ length: 36 }, (_, i) => ask(ai, i)));
    await vi.advanceTimersByTimeAsync(0); expect(sent).toHaveLength(12);
    vi.setSystemTime(Date.now() + 120_000); // the clock jumps two minutes while timers are stalled
    await vi.advanceTimersByTimeAsync(400_000); await all;
    expect(sent).toHaveLength(36);
    for (const t of sent) expect(sent.filter((u) => u >= t && u < t + 60_000).length).toBeLessThanOrEqual(12);
  });

  it('a fractional or invalid limit still throttles (never an unthrottled fallthrough)', async () => {
    vi.useFakeTimers();
    for (const bad of [12.5, NaN, -3, Infinity]) {
      const sent: number[] = []; const ai = new Ai(openDb(':memory:'), 'm', transport(sent), 1000, Date.now, bad);
      const all = Promise.all(Array.from({ length: 30 }, (_, i) => ask(ai, i)));
      await vi.advanceTimersByTimeAsync(0); expect(sent).toHaveLength(12);
      await vi.advanceTimersByTimeAsync(300_000); await all;
    }
  });

  it('zero disables pacing explicitly', async () => {
    const sent: number[] = []; const ai = new Ai(openDb(':memory:'), 'm', transport(sent), 1000, Date.now, 0);
    await Promise.all(Array.from({ length: 30 }, (_, i) => ask(ai, i))); expect(sent).toHaveLength(30);
  });
});

describe('AI_REQUESTS_PER_MINUTE config', () => {
  it('accepts whole numbers and 0, defaults when unset, rejects everything else', async () => {
    const { loadConfig } = await import('../server/config.js');
    const base = { SESSION_SECRET: 'x'.repeat(40) } as NodeJS.ProcessEnv;
    const get = (v?: string) => loadConfig({ ...base, ...(v === undefined ? {} : { AI_REQUESTS_PER_MINUTE: v }) }).aiPerMinute;
    expect(get()).toBe(12); expect(get('10')).toBe(10); expect(get('0')).toBe(0);
    for (const bad of ['12.5', 'abc', '-1', 'Infinity', '1e400']) expect(() => get(bad)).toThrow(/AI_REQUESTS_PER_MINUTE/);
  });
});

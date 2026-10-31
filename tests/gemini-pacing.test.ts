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

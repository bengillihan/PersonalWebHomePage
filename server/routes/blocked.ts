import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { DB } from '../db.js';
import { loadBlockedTopics, parseBlockPhrases, previewBlock, reindexBlocks, suggestBlock } from '../news/blocking.js';

const idParam = z.object({ id: z.coerce.number().int().positive() });
const body = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(400).default(''),
  keywords: z.array(z.string().trim().min(1).max(60)).max(30).optional(),
  categories: z.array(z.string().trim().min(1).max(40)).max(10).default([]),
  enabled: z.boolean().optional(),
});
const dedupe = (xs: string[]) => xs.filter((x, i) => xs.findIndex((y) => y.toLowerCase() === x.toLowerCase()) === i);

/** "Not interested": hard topic exclusions. Separate from soft thumbs-down feedback; local matching only, never an AI request. */
export function registerBlocked(app: FastifyInstance, db: DB) {
  const limited = { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } };
  const counts = () => new Map((db.prepare('SELECT topic_id, COUNT(*) n FROM article_blocks GROUP BY topic_id').all() as { topic_id: number; n: number }[]).map((r) => [r.topic_id, r.n]));
  const list = () => { const c = counts(); return loadBlockedTopics(db).map((t) => ({ ...t, blockedArticles: c.get(t.id) ?? 0 })); };
  /** Natural language in, matching phrases out (unless the caller supplied explicit keywords). */
  const terms = (b: z.infer<typeof body>) => ({ keywords: dedupe(b.keywords?.length ? b.keywords : parseBlockPhrases(b.description || b.name)), categories: dedupe(b.categories) });
  const noTerms = { error: 'no_match_terms', message: 'Nothing to match: add at least one specific word or phrase (for example “hockey, NHL”) or a category.' };

  app.get('/api/blocked-topics', async () => list());

  app.post('/api/blocked-topics', limited, async (req, reply) => {
    const b = body.parse(req.body); const t = terms(b);
    if (!t.keywords.length && !t.categories.length) return reply.code(400).send(noTerms);
    try {
      const id = Number(db.prepare('INSERT INTO blocked_topics (name, description, keywords, categories, enabled, created_at) VALUES (?,?,?,?,?,?)')
        .run(b.name, b.description, JSON.stringify(t.keywords), JSON.stringify(t.categories), b.enabled === false ? 0 : 1, Date.now()).lastInsertRowid);
      reindexBlocks(db, id); // takes effect immediately for already-ingested articles
      return reply.code(201).send(list().find((x) => x.id === id));
    } catch (e) { if (String(e).includes('UNIQUE')) return reply.code(409).send({ error: 'duplicate', message: 'A blocked topic with this name already exists.' }); throw e; }
  });

  app.put('/api/blocked-topics/:id', limited, async (req, reply) => {
    const { id } = idParam.parse(req.params); const b = body.parse(req.body); const t = terms(b);
    if (!db.prepare('SELECT 1 FROM blocked_topics WHERE id = ?').get(id)) return reply.code(404).send({ error: 'not_found' });
    if (!t.keywords.length && !t.categories.length) return reply.code(400).send(noTerms);
    try {
      db.prepare('UPDATE blocked_topics SET name = ?, description = ?, keywords = ?, categories = ?, enabled = COALESCE(?, enabled) WHERE id = ?')
        .run(b.name, b.description, JSON.stringify(t.keywords), JSON.stringify(t.categories), b.enabled === undefined ? null : b.enabled ? 1 : 0, id);
    } catch (e) { if (String(e).includes('UNIQUE')) return reply.code(409).send({ error: 'duplicate', message: 'A blocked topic with this name already exists.' }); throw e; }
    reindexBlocks(db, id);
    return list().find((x) => x.id === id);
  });

  // Enabling/disabling needs no recompute: matches are kept for every topic and "enabled" is read when the feed is built.
  app.patch('/api/blocked-topics/:id', async (req, reply) => {
    const { id } = idParam.parse(req.params); const { enabled } = z.object({ enabled: z.boolean() }).parse(req.body);
    const r = db.prepare('UPDATE blocked_topics SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
    return r.changes ? list().find((x) => x.id === id) : reply.code(404).send({ error: 'not_found' });
  });

  app.delete('/api/blocked-topics/:id', async (req) => { const { id } = idParam.parse(req.params); db.prepare('DELETE FROM blocked_topics WHERE id = ?').run(id); return { ok: true }; });

  /** What this definition would hide among recent articles. Saves nothing. */
  app.post('/api/blocked-topics/preview', limited, async (req) => {
    const b = z.object({ description: z.string().trim().max(400).default(''), keywords: z.array(z.string().trim().min(1).max(60)).max(30).optional(), categories: z.array(z.string().trim().min(1).max(40)).max(10).default([]) }).parse(req.body);
    const keywords = dedupe(b.keywords?.length ? b.keywords : parseBlockPhrases(b.description)); const categories = dedupe(b.categories);
    return { keywords, categories, ...(keywords.length || categories.length ? previewBlock(db, { keywords, categories }) : { matches: 0, samples: [] }) };
  });

  app.get('/api/stories/:id/block-suggestion', async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const row = db.prepare('SELECT c.title, c.category, a.ai_category FROM story_clusters c LEFT JOIN articles a ON a.id = c.primary_article_id WHERE c.id = ?').get(id) as { title: string; category: string | null; ai_category: string | null } | undefined;
    return row ? suggestBlock(row.title, row.category ?? row.ai_category) : reply.code(404).send({ error: 'not_found' });
  });
}

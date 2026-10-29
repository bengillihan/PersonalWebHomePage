import { describe, it, expect, beforeEach } from 'vitest';
import { memDb } from './helpers.js';
import { recomputeCluster } from '../server/news/cluster.js';
import { queryFeed } from '../server/news/query.js';
import { indexArticleTopics, loadTopics } from '../server/news/topics.js';
import { reindexBlocks } from '../server/news/blocking.js';
import { seedDefaults } from '../server/seed.js';
import { getPrefs, savePrefs } from '../server/settings.js';
import type { DB } from '../server/db.js';

let db: DB; let n = 0;
const src = (name: string, coverage: 'comprehensive' | 'interest') => Number(db.prepare('INSERT INTO sources (name, site_url, coverage, created_at) VALUES (?,?,?,0)').run(name, `https://${name.replace(/\W/g, '')}${++n}.example`, coverage).lastInsertRowid);
function story(source: number, title: string, cluster?: number) {
  n++; const at = Date.now() - 3_600_000; const pub = (db.prepare('SELECT name FROM sources WHERE id = ?').get(source) as any).name;
  const a = Number(db.prepare(`INSERT INTO articles (source_id,url,canonical_url,canonical_hash,publisher,title,title_norm,excerpt,published_at,fetched_at,content_hash,availability,summary,summary_kind,importance)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,'excerpt',?,'excerpt',0.3)`).run(source, `https://x.example/${n}`, `https://x.example/${n}`, `h${n}`, pub, title, title.toLowerCase(), `${title}. Detail.`, at, at, `c${n}`, `${title}. Detail.`).lastInsertRowid);
  const c = cluster ?? Number(db.prepare('INSERT INTO story_clusters (primary_article_id,title,first_published_at,last_published_at,updated_at,created_at) VALUES (?,?,?,?,?,?)').run(a, title, at, at, at, at).lastInsertRowid);
  db.prepare('UPDATE articles SET cluster_id = ? WHERE id = ?').run(c, a); db.prepare('INSERT INTO cluster_articles VALUES (?,?,0,?)').run(c, a, at); db.prepare('INSERT INTO article_sources VALUES (?,?,?)').run(a, source, at);
  indexArticleTopics(db, [a]); recomputeCluster(db, c); return c;
}
const ids = (tab: string, extra: Record<string, string> = {}) => queryFeed(db, { tab, limit: 50, ...extra }).items.map((i) => i.id).sort((a, b) => a - b);
const setStance = (name: string, stance: 'prefer' | 'less') => db.prepare('UPDATE topics SET stance = ? WHERE name = ?').run(stance, name);
const CELEB = 'Celebrity gossip: stars walk the red carpet'; const AI = 'NVIDIA ships new AI hardware';
let niche: number, general: number;
beforeEach(() => { db = memDb(); seedDefaults(db); niche = src('Niche Blog', 'interest'); general = src('General News', 'comprehensive'); });

describe('a "show less" match never makes a story eligible', () => {
  it('REGRESSION: an interest-only source\'s celebrity story (matching only a show-less topic) is not shown anywhere, while a positive match is', () => {
    const celeb = story(niche, CELEB), ai = story(niche, AI); const gossipTopic = loadTopics(db).find((t) => t.name === 'Low priority: celebrity gossip')!;
    expect(db.prepare('SELECT COUNT(*) n FROM article_topics WHERE topic_id = ?').get(gossipTopic.id)).toEqual({ n: 1 }); // it did match, and that match is kept for ranking
    for (const tab of ['latest', 'foryou', 'unread', 'explore']) { expect(ids(tab), tab).not.toContain(celeb); }
    for (const tab of ['latest', 'foryou']) expect(ids(tab), tab).toContain(ai); // before the fix the celebrity story was listed too
  });

  it('the rule is the stance, applied immediately: flipping it in either direction changes eligibility with no reindex or AI call', () => {
    const celeb = story(niche, CELEB); expect(ids('latest')).toEqual([]);
    setStance('Low priority: celebrity gossip', 'prefer'); expect(ids('latest')).toEqual([celeb]); // now a positive interest
    setStance('Low priority: celebrity gossip', 'less'); expect(ids('latest')).toEqual([]);
    const ai = story(niche, AI); setStance('AI and technology', 'less'); expect(ids('latest')).not.toContain(ai);
  });

  it('a story with both a positive and a show-less match stays eligible (and is only ranked lower)', () => {
    const both = story(niche, 'NVIDIA celebrity gossip: stars at the AI hardware red carpet'); expect(ids('latest')).toContain(both);
    const item = queryFeed(db, { tab: 'foryou', limit: 50 }).items.find((i) => i.id === both)!; expect(item.why!.reasons.join(' ')).toMatch(/weight 5 of 5/); expect(item.why!.reasons.join(' ')).toMatch(/Shown less/); // explanations preserved
  });

  it('comprehensive sources stay eligible and are demoted, subject to hard blocks and mutes; multi-source stories keep a qualifying article', () => {
    const celeb = story(general, CELEB); expect(ids('latest')).toEqual([celeb]);
    const mixed = story(niche, CELEB + ' continues'); // interest-only article joins a comprehensive one: eligible via the comprehensive article
    const shared = story(general, 'Harbor tunnel repairs finish', undefined); story(niche, 'Celebrity gossip about harbor repairs', shared); expect(ids('latest')).toContain(shared);
    savePrefs(db, { ...getPrefs(db), mutedPublishers: ['General News'] }); expect(ids('latest')).not.toContain(celeb); expect(ids('latest')).not.toContain(shared);
    savePrefs(db, { ...getPrefs(db), mutedPublishers: [] });
    db.prepare("INSERT INTO blocked_topics (name, description, keywords, categories, enabled, created_at) VALUES ('Gossip','','[\"red carpet\"]','[]',1,0)").run(); // hard blocks still win
    reindexBlocks(db); expect(ids('latest')).not.toContain(celeb); expect(ids('latest')).not.toContain(mixed);
  });

  it('Saved still reaches a show-less-only story with bookmarks and read state intact; search policy is unchanged', () => {
    const celeb = story(niche, CELEB); db.prepare('INSERT INTO bookmarks VALUES (?,1)').run(celeb); savePrefs(db, { ...getPrefs(db), showRead: true }); db.prepare('INSERT INTO reading_state (cluster_id, read_at) VALUES (?,?)').run(celeb, Date.now());
    expect(ids('latest')).toEqual([]);
    expect(ids('saved')).toEqual([celeb]); // Saved always shows every bookmark
    expect(ids('latest', { q: 'celebrity' })).toEqual([]); // search keeps its existing policy: interest-only sources are searchable only for stories they are eligible for
    const general2 = story(general, CELEB + ' again'); expect(ids('latest', { q: 'celebrity' })).toEqual([general2]); // a comprehensive source's story is found
    expect(queryFeed(db, { tab: 'saved' }).items[0]).toMatchObject({ bookmarked: true, isRead: true });
  });
});

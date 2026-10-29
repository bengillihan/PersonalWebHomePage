import { describe, it, expect, beforeEach } from 'vitest';
import { memDb } from './helpers.js';
import { queryFeed } from '../server/news/query.js';
import { pruneOldData } from '../server/news/ingest.js';
import type { DB } from '../server/db.js';

const DAY = 86_400_000;
let db: DB; let n = 0;

/** One cluster with one article per publisher, each published `ageDays[i]` days ago. */
function story(title: string, ageDays: number[], publishers = ageDays.map((_, i) => `Pub${i}`)): number {
  const times = ageDays.map((d) => Date.now() - d * DAY);
  const cluster = Number(db.prepare('INSERT INTO story_clusters (title,summary,first_published_at,last_published_at,updated_at,created_at,article_count,source_count) VALUES (?,?,?,?,?,?,?,?)')
    .run(title, `Summary of ${title}`, Math.min(...times), Math.max(...times), Math.max(...times), Math.max(...times), ageDays.length, new Set(publishers).size).lastInsertRowid);
  ageDays.forEach((_, i) => {
    n++;
    const source = Number(db.prepare('INSERT INTO sources (name, site_url, created_at) VALUES (?,?,0)').run(publishers[i], `https://s${n}.example`).lastInsertRowid);
    const a = Number(db.prepare(`INSERT INTO articles (source_id,url,canonical_url,canonical_hash,publisher,title,title_norm,published_at,fetched_at,content_hash,availability,cluster_id)
      VALUES (?,?,?,?,?,?,?,?,?,?,'headline_only',?)`).run(source, `https://s${n}.example/a`, `https://s${n}.example/a`, `h${n}`, publishers[i], `${title} (${publishers[i]})`, title, times[i], times[i], `c${n}`, cluster).lastInsertRowid);
    db.prepare('INSERT INTO cluster_articles VALUES (?,?,0,?)').run(cluster, a, times[i]);
    if (i === 0) db.prepare('UPDATE story_clusters SET primary_article_id = ? WHERE id = ?').run(a, cluster);
  });
  return cluster;
}
const save = (c: number) => db.prepare('INSERT INTO bookmarks VALUES (?,?)').run(c, Date.now());
const ids = (tab: string, extra: Record<string, string> = {}) => queryFeed(db, { tab, ...extra }).items.map((i) => i.id);
const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;

beforeEach(() => { db = memDb(); });

describe('Saved view ignores the retention window; ordinary feeds keep it', () => {
  it('REGRESSION: a bookmarked story older than 90 days still appears in Saved', () => {
    const old = story('Old saved story', [200]); const recent = story('Recent story', [1]);
    save(old);
    expect(ids('saved')).toEqual([old]); // before the fix: []
    expect(ids('latest')).toEqual([recent]); // ordinary feed still applies retention (90 days)
    expect(ids('unread')).toEqual([recent]); expect(ids('foryou')).toEqual([recent]);
  });

  it('REGRESSION: multi-source clusters keep every source article and attribution when old', () => {
    const c = story('Old multi-source story', [150, 130, 95], ['Alpha', 'Beta', 'Gamma']);
    save(c);
    const [item] = queryFeed(db, { tab: 'saved' }).items;
    expect(item).toMatchObject({ id: c, sourceCount: 3, bookmarked: true, primary: { publisher: 'Alpha' } });
    expect(item.articles.map((a) => a.publisher).sort()).toEqual(['Alpha', 'Beta', 'Gamma']);
    expect(item.articles.every((a) => a.url.startsWith('https://s'))).toBe(true);
  });

  it('a bookmark survives pruning with all its articles, clusters and user state; unsaved old stories are pruned', () => {
    const saved = story('Saved multi', [200, 190], ['A', 'B']); const unsaved = story('Unsaved old', [200]); const fresh = story('Fresh', [2]);
    save(saved);
    db.prepare('INSERT INTO reading_state (cluster_id, read_at) VALUES (?,?)').run(saved, 123);
    db.prepare("INSERT INTO feedback (cluster_id, rating, reason, category, created_at, updated_at) VALUES (?,1,NULL,NULL,1,1)").run(saved);
    const rated = story('Old but rated', [180]); db.prepare("INSERT INTO feedback (cluster_id, rating, reason, category, created_at, updated_at) VALUES (?,-1,'topic',NULL,1,1)").run(rated);

    pruneOldData(db);

    expect(count('SELECT COUNT(*) n FROM story_clusters WHERE id IN (' + [saved, rated, fresh].join(',') + ')')).toBe(3);
    expect(count(`SELECT COUNT(*) n FROM story_clusters WHERE id = ${unsaved}`)).toBe(0);
    expect(count(`SELECT COUNT(*) n FROM articles WHERE cluster_id = ${saved}`)).toBe(2); // both source articles kept
    expect(count(`SELECT COUNT(*) n FROM cluster_articles WHERE cluster_id = ${saved}`)).toBe(2);
    expect(count(`SELECT COUNT(*) n FROM reading_state WHERE cluster_id = ${saved}`)).toBe(1);
    expect(count(`SELECT COUNT(*) n FROM feedback WHERE cluster_id IN (${saved}, ${rated})`)).toBe(2);
    const [item] = queryFeed(db, { tab: 'saved' }).items;
    expect(item).toMatchObject({ id: saved, isRead: true, rating: 1, sourceCount: 2 }); expect(item.articles).toHaveLength(2);
  });

  it('paginates old saved stories efficiently: newest first, no duplicates or gaps, hidden ones included', () => {
    const made = Array.from({ length: 7 }, (_, i) => story(`Saved ${i}`, [100 + i * 10])); // 100,110,...,160 days old
    made.forEach(save);
    db.prepare('INSERT INTO reading_state (cluster_id, hidden_at) VALUES (?,?)').run(made[2], 1); // hidden stories are still saved
    const seen: number[] = []; let cursor: string | undefined;
    for (let guard = 0; guard < 10; guard++) {
      const p = queryFeed(db, { tab: 'saved', limit: 3, cursor });
      seen.push(...p.items.map((i) => i.id)); cursor = p.nextCursor ?? undefined;
      if (!cursor) break;
    }
    expect(seen).toEqual(made); // newest (100 days) first, all 7 exactly once
    const plan = (db.prepare("EXPLAIN QUERY PLAN SELECT c.id FROM story_clusters c LEFT JOIN bookmarks b ON b.cluster_id = c.id WHERE b.cluster_id IS NOT NULL ORDER BY c.last_published_at DESC, c.id DESC LIMIT 4").all() as { detail: string }[]).map((r) => r.detail).join(' | ');
    expect(plan).toMatch(/bookmarks|idx_clusters_last_pub/); // uses an index; no full sort of the clusters table via temp b-tree on c
  });

  it('removing a bookmark restores normal retention: hidden from feeds, gone from Saved, pruned next time', () => {
    const old = story('Old story', [200, 160], ['A', 'B']); save(old);
    expect(ids('saved')).toEqual([old]);
    db.prepare('DELETE FROM bookmarks WHERE cluster_id = ?').run(old);
    expect(ids('saved')).toEqual([]); expect(ids('latest')).toEqual([]);
    pruneOldData(db);
    expect(count('SELECT COUNT(*) n FROM story_clusters')).toBe(0); expect(count('SELECT COUNT(*) n FROM articles')).toBe(0);
  });

  it('ordinary feeds still honor a configured retention window', () => {
    const d30 = story('Thirty days old', [30]); const d100 = story('Hundred days old', [100]);
    expect(ids('latest').sort()).toEqual([d30]); // default 90 days
    db.prepare("INSERT INTO application_settings (key, value) VALUES ('prefs', ?)").run(JSON.stringify({ retentionDays: 20 }));
    expect(ids('latest')).toEqual([]);
    db.prepare("UPDATE application_settings SET value = ? WHERE key = 'prefs'").run(JSON.stringify({ retentionDays: 365 }));
    expect(ids('latest')).toEqual([d30, d100]);
    save(d100); db.prepare("UPDATE application_settings SET value = ? WHERE key = 'prefs'").run(JSON.stringify({ retentionDays: 20 }));
    expect(ids('saved')).toEqual([d100]); // still saved under a short window
  });
});

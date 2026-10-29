import { describe, it, expect, beforeEach } from 'vitest';
import { memDb } from './helpers.js';
import { recomputeCluster } from '../server/news/cluster.js';
import { queryFeed } from '../server/news/query.js';
import { getPrefs, savePrefs } from '../server/settings.js';
import type { DB } from '../server/db.js';

let db: DB; let n = 0;
const src = (name: string) => Number(db.prepare('INSERT INTO sources (name, site_url, coverage, created_at) VALUES (?,?,?,0)').run(name, `https://${name.replace(/\W/g, '')}${++n}.example`, 'comprehensive').lastInsertRowid);
/** An article in `cluster` (created if omitted). `summary: null` means the publisher's feed gave no excerpt. */
function art(source: number, title: string, summary: string | null, o: { cluster?: number; ageMin?: number } = {}) {
  n++; const at = Date.now() - (o.ageMin ?? 60) * 60_000; const pub = (db.prepare('SELECT name FROM sources WHERE id = ?').get(source) as any).name;
  const a = Number(db.prepare(`INSERT INTO articles (source_id,url,canonical_url,canonical_hash,publisher,title,title_norm,excerpt,published_at,fetched_at,content_hash,availability,summary,summary_kind,importance)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,0.9)`).run(source, `https://x.example/${n}`, `https://x.example/${n}`, `h${n}`, pub, title, title.toLowerCase(), summary, at, at, `c${n}`, summary ? 'excerpt' : 'headline_only', summary, summary ? 'excerpt' : 'headline').lastInsertRowid);
  const c = o.cluster ?? Number(db.prepare('INSERT INTO story_clusters (primary_article_id,title,first_published_at,last_published_at,updated_at,created_at) VALUES (?,?,?,?,?,?)').run(a, title, at, at, at, at).lastInsertRowid);
  db.prepare('UPDATE articles SET cluster_id = ? WHERE id = ?').run(c, a); db.prepare('INSERT INTO cluster_articles VALUES (?,?,0,?)').run(c, a, at); db.prepare('INSERT INTO article_sources VALUES (?,?,?)').run(a, source, at);
  recomputeCluster(db, c); return c;
}
const mute = (...names: string[]) => savePrefs(db, { ...getPrefs(db), mutedPublishers: names });
const card = (tab = 'latest', extra: Record<string, string> = {}) => queryFeed(db, { tab, limit: 50, ...extra }).items[0];
const makePrimary = (c: number, publisher: string) => db.prepare('UPDATE story_clusters SET primary_article_id = (SELECT id FROM articles WHERE publisher = ? AND cluster_id = ?) WHERE id = ?').run(publisher, c, c);
const MUTED_TEXT = 'Loud Blog says the harbor tunnel will close for repairs until spring.';
const OTHER_TEXT = 'General reports the harbor tunnel closure is expected to last until spring.';
let loud: number, general: number, quiet: number;
beforeEach(() => { db = memDb(); loud = src('Loud Blog'); general = src('General'); quiet = src('Quiet Wire'); });

describe('the visible card is one publisher\'s headline, link and excerpt', () => {
  it('REGRESSION: muting the primary publisher switches headline, link AND excerpt to another publisher (never the muted one\'s text)', () => {
    const c = art(loud, 'Loud Blog: tunnel closes', MUTED_TEXT, { ageMin: 90 }); art(general, 'General: tunnel closure planned', OTHER_TEXT, { cluster: c }); makePrimary(c, 'Loud Blog');
    expect(card()).toMatchObject({ title: expect.stringContaining('Loud Blog'), summary: MUTED_TEXT, primary: { publisher: 'Loud Blog' } }); // before muting
    mute('Loud Blog');
    const s = card(); expect(s.primary!.publisher).toBe('General'); expect(s.title).toBe('General: tunnel closure planned');
    expect(s.summary).toBe(OTHER_TEXT); expect(s.summaryKind).toBe('excerpt'); expect(s.summary).not.toContain('Loud Blog'); // before the fix: Loud Blog's excerpt under General's headline
  });

  it('REGRESSION: when the remaining publisher gave no excerpt the card is headline-only, not the muted publisher\'s text', () => {
    const c = art(loud, 'Loud Blog: tunnel closes', MUTED_TEXT); art(general, 'General: tunnel closure planned', null, { cluster: c }); makePrimary(c, 'Loud Blog');
    mute('Loud Blog'); const s = card();
    expect(s.primary!.publisher).toBe('General'); expect(s.summary).toBeNull(); expect(s.summaryKind).toBe('headline');
  });

  it('REGRESSION: a consolidated AI summary written from the muted publisher\'s text is not shown while it is muted, and not mislabelled as an excerpt', () => {
    const c = art(general, 'General: tunnel closure planned', OTHER_TEXT); art(loud, 'Loud Blog: tunnel closes', MUTED_TEXT, { cluster: c });
    db.prepare("UPDATE story_clusters SET summary = ?, summary_kind = 'ai', differences = 'Loud Blog claims it is permanent.' WHERE id = ?").run('Both outlets report the tunnel closing; Loud Blog says it will close for repairs.', c);
    expect(card()).toMatchObject({ summaryKind: 'ai', differences: 'Loud Blog claims it is permanent.' }); // unmuted: the consolidated summary is shown and labelled as AI
    mute('Loud Blog'); const s = card();
    expect(s.summary).toBe(OTHER_TEXT); expect(s.summaryKind).toBe('excerpt'); expect(s.differences).toBeNull(); expect(JSON.stringify(s.summary)).not.toMatch(/Loud/);
  });

  it('prefers an unmuted publisher that has an excerpt over one that does not, keeping headline, link and excerpt together', () => {
    const c = art(loud, 'Loud Blog: tunnel closes', MUTED_TEXT, { ageMin: 120 }); art(general, 'General: no text', null, { cluster: c, ageMin: 100 }); art(quiet, 'Quiet Wire: tunnel closure', OTHER_TEXT, { cluster: c, ageMin: 80 });
    makePrimary(c, 'Loud Blog'); mute('Loud Blog'); const s = card();
    expect(s).toMatchObject({ title: 'Quiet Wire: tunnel closure', summary: OTHER_TEXT, primary: { publisher: 'Quiet Wire' } }); expect(s.sourceCount).toBe(2);
  });

  it('unmuting restores the original attribution immediately, and neither direction rewrites the stored cluster (so no Gemini work is triggered)', () => {
    const c = art(loud, 'Loud Blog: tunnel closes', MUTED_TEXT, { ageMin: 90 }); art(general, 'General: tunnel closure planned', OTHER_TEXT, { cluster: c }); makePrimary(c, 'Loud Blog');
    const stored = () => JSON.stringify(db.prepare('SELECT * FROM story_clusters WHERE id = ?').get(c));
    const before = stored(); const initial = card();
    mute('Loud Blog'); expect(card().summary).toBe(OTHER_TEXT);
    mute(); expect(card()).toEqual(initial); expect(stored()).toBe(before);
  });

  it('stories with no muted publisher are untouched (including AI summaries and differences)', () => {
    const c = art(general, 'General: tunnel closure planned', OTHER_TEXT); art(quiet, 'Quiet Wire: closure', OTHER_TEXT + ' More.', { cluster: c });
    db.prepare("UPDATE story_clusters SET summary = 'Consolidated.  Two outlets agree the tunnel closes.', summary_kind = 'ai', differences = 'Timing differs.' WHERE id = ?").run(c);
    mute('Loud Blog'); expect(card()).toMatchObject({ summary: 'Consolidated.  Two outlets agree the tunnel closes.', summaryKind: 'ai', differences: 'Timing differs.' });
  });

  it('Saved and search still reach a muted-only story with its own text, labelled muted', () => {
    const c = art(loud, 'Loud Blog: harbor tunnel closes', MUTED_TEXT); db.prepare('INSERT INTO bookmarks VALUES (?,1)').run(c); mute('Loud Blog');
    expect(queryFeed(db, { tab: 'latest' }).items).toEqual([]);
    for (const s of [card('saved'), card('latest', { q: 'harbor' })]) expect(s).toMatchObject({ summary: MUTED_TEXT, primary: { publisher: 'Loud Blog' } }); // nothing unmuted to prefer: unchanged policy
    expect(card('saved').articles[0].muted).toBe(true);
  });

  it('a saved multi-source story follows the same rule, and bookmark, read state and source relationships are preserved', () => {
    const c = art(loud, 'Loud Blog: tunnel closes', MUTED_TEXT, { ageMin: 90 }); art(general, 'General: tunnel closure planned', OTHER_TEXT, { cluster: c }); makePrimary(c, 'Loud Blog');
    db.prepare('INSERT INTO bookmarks VALUES (?,1)').run(c); db.prepare('INSERT INTO reading_state (cluster_id, read_at) VALUES (?,?)').run(c, Date.now()); mute('Loud Blog');
    const s = card('saved'); expect(s).toMatchObject({ summary: OTHER_TEXT, primary: { publisher: 'General' }, bookmarked: true, isRead: true });
    expect(s.articles.map((a) => a.publisher).sort()).toEqual(['General', 'Loud Blog']);
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { memDb } from './helpers.js';
import { articleSimilarity, canonicalText, clusterArticles, headlineSimilarity, MERGE_THRESHOLD, UNCERTAIN_THRESHOLD, MAX_CANDIDATES } from '../server/news/cluster.js';
import { contradicts } from '../server/news/contradiction.js';
import type { DB } from '../server/db.js';

type Side = { title: string; excerpt: string };
const evalSet = JSON.parse(readFileSync(new URL('./fixtures/clustering-eval.json', import.meta.url), 'utf8')).pairs as { label: 'same_event' | 'update' | 'related' | 'different'; a: Side; b: Side }[];
const mergesToday = (a: Side, b: Side) => headlineSimilarity(a.title, b.title) >= MERGE_THRESHOLD && !contradicts(a.title, b.title);
const mergesNow = (a: Side, b: Side) => articleSimilarity(a, b) >= MERGE_THRESHOLD && !contradicts(a.title, b.title);
/** Incorrect merges (separate stories grouped) and missed matches (same story left apart) are counted separately. */
const score = (merges: (a: Side, b: Side) => boolean) => ({
  wrongMerges: evalSet.filter((p) => (p.label === 'related' || p.label === 'different') && merges(p.a, p.b)).map((p) => p.a.title + ' / ' + p.b.title),
  missed: evalSet.filter((p) => (p.label === 'same_event' || p.label === 'update') && !merges(p.a, p.b)).map((p) => p.a.title + ' / ' + p.b.title),
});

describe('labelled evaluation set', () => {
  it('REGRESSION: excerpt-aware scoring finds more same-event pairs than headlines alone, with no incorrect merges', () => {
    const before = score(mergesToday), after = score(mergesNow);
    console.log(`clustering eval (${evalSet.length} pairs) wrong merges ${before.wrongMerges.length} -> ${after.wrongMerges.length}; missed ${before.missed.length} -> ${after.missed.length}`);
    expect(after.wrongMerges).toEqual([]);
    expect(after.missed.length).toBeLessThan(before.missed.length);
    expect(after.missed.length).toBeLessThanOrEqual(4); // current level on the seed set; lower it as scoring improves (borderline pairs still reach the model, they are not lost)
  });
  it('has examples of every label so neither error type goes unmeasured', () => {
    for (const l of ['same_event', 'update', 'related', 'different']) expect(evalSet.some((p) => p.label === l)).toBe(true);
  });
});

describe('event signals', () => {
  it('normalises aliases so "Fed" and "Federal Reserve" read the same', () => {
    expect(canonicalText('Fed holds rates')).toBe(canonicalText('Federal Reserve holds rates'));
    expect(canonicalText('Q3 results')).toBe(canonicalText('third quarter results'));
  });
  it('headlines about different kinds of development are never merged locally, even with heavy word overlap', () => {
    const s = articleSimilarity({ title: 'Boeing reports earnings as 737 output stays low', excerpt: null }, { title: 'Boeing unveils 737 output plan as production stays low', excerpt: null });
    expect(s).toBeLessThan(MERGE_THRESHOLD);
  });
  it('feed boilerplate repeated on every excerpt does not count as agreement', () => {
    const tail = ' The post appeared first on Daily Wire. Continue reading';
    const mk = (title: string, excerpt: string, t = '') => ({ title, excerpt: excerpt + t });
    const [x, y] = ['The mayor toured an elementary school on Tuesday morning with parents.', 'Crews closed the bridge deck on Wednesday evening for emergency repairs.'];
    expect(articleSimilarity(mk('Mayor tours school in Tacoma', x, tail), mk('Mayor tours bridge in Tacoma', y, tail))).toBe(articleSimilarity(mk('Mayor tours school in Tacoma', x), mk('Mayor tours bridge in Tacoma', y)));
  });
  it('an excerpt cannot join two headlines that share nothing', () => {
    const e = 'The council met on Tuesday evening to discuss several items on the agenda, including budget and transit.';
    expect(articleSimilarity({ title: 'Mayor visits school', excerpt: e }, { title: 'Bridge repairs begin downtown', excerpt: e })).toBeLessThan(UNCERTAIN_THRESHOLD);
  });
});

describe('candidate stories and whole-story checks', () => {
  let db: DB; let n = 0; const HOUR = 3_600_000;
  const src = (name: string) => Number(db.prepare('INSERT INTO sources (name, site_url, created_at) VALUES (?,?,0)').run(name, `https://${name}${++n}.example`).lastInsertRowid);
  const art = (s: number, title: string, excerpt: string | null, ageH = 3) => {
    n++; const at = Date.now() - ageH * HOUR; const pub = (db.prepare('SELECT name FROM sources WHERE id = ?').get(s) as any).name;
    const id = Number(db.prepare(`INSERT INTO articles (source_id,url,canonical_url,canonical_hash,publisher,title,title_norm,excerpt,published_at,fetched_at,content_hash,availability,summary,summary_kind)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(s, `https://e.example/${n}`, `https://e.example/${n}`, `h${n}`, pub, title, title.toLowerCase(), excerpt, at, at, `c${n}`, excerpt ? 'excerpt' : 'headline_only', excerpt, excerpt ? 'excerpt' : 'headline').lastInsertRowid);
    db.prepare('INSERT INTO article_sources VALUES (?,?,?)').run(id, s, at); return id;
  };
  const clusterOf = (id: number) => (db.prepare('SELECT cluster_id c FROM articles WHERE id = ?').get(id) as any).c as number;
  beforeEach(() => { db = memDb(); });

  it('REGRESSION: differently worded coverage of one event now groups when the excerpts agree', async () => {
    const [a, b] = [src('Alpha'), src('Beta')]; const [A, B] = evalSet[0] ? [evalSet[0].a, evalSet[0].b] : [];
    const x = art(a, A!.title, A!.excerpt, 3), y = art(b, B!.title, B!.excerpt, 2); const p = evalSet[1];
    const x2 = art(a, p.a.title, p.a.excerpt, 3), y2 = art(b, p.b.title, p.b.excerpt, 2);
    await clusterArticles(db, null, [x, y, x2, y2]);
    expect(clusterOf(x)).toBe(clusterOf(y)); expect(clusterOf(x2)).toBe(clusterOf(y2)); expect(clusterOf(x)).not.toBe(clusterOf(x2));
  });

  it('REGRESSION: a valid second-best story is used when the strongest candidate holds a contradicting report', async () => {
    const [a, b, c] = [src('Alpha'), src('Beta'), src('Gamma')];
    const strong = art(a, 'City council passes downtown parking plan', null, 8);
    const contra = art(b, 'City council fails downtown parking plan', null, 7); // separate story (opposite claim)
    const runnerUp = art(c, 'City council approves downtown parking proposal', null, 6);
    await clusterArticles(db, null, [strong, contra, runnerUp]);
    const incoming = art(a, 'City council passes downtown parking plan after debate', null, 1);
    await clusterArticles(db, null, [incoming]);
    expect(clusterOf(incoming)).toBe(clusterOf(strong)); // the sibling story is never joined
    expect(clusterOf(incoming)).not.toBe(clusterOf(contra));
    expect(MAX_CANDIDATES).toBe(3);
  });

  it('REGRESSION: an article that matches only one member of a story does not chain onto it', async () => {
    const s = src('Alpha');
    const A = art(s, 'Port of Seattle names new director for airport operations', null, 10);
    const B = art(s, 'Port of Seattle director for airport operations expands security staffing plan', null, 9);
    await clusterArticles(db, null, [A, B]); expect(clusterOf(A)).toBe(clusterOf(B)); // premise: A~B
    const C = art(s, 'Seattle airport security staffing plan expands with overnight shifts', null, 8);
    const sim = (x: number, y: number) => { const g = (i: number) => db.prepare('SELECT title, excerpt FROM articles WHERE id = ?').get(i) as Side; return articleSimilarity(g(x), g(y)); };
    expect(sim(C, B)).toBeGreaterThanOrEqual(UNCERTAIN_THRESHOLD); expect(sim(C, A)).toBeLessThan(UNCERTAIN_THRESHOLD); // premise: C~B but not C~A
    await clusterArticles(db, null, [C]);
    expect(clusterOf(C)).not.toBe(clusterOf(A)); // before: merged through B alone
  });

  it('a borderline article that fits only part of a story is offered to the model, which decides', async () => {
    const s = src('Alpha'); const asked: number[] = [];
    const ai = { canCall: () => true, enabled: true, verifyPairs: async (pairs: any[]) => { asked.push(pairs.length); return new Map(pairs.map((p: any) => [p.id, true])); } } as any;
    const A = art(s, 'Port of Seattle names new director for airport operations', null, 10), B = art(s, 'Port of Seattle director for airport operations expands security staffing plan', null, 9);
    await clusterArticles(db, null, [A, B]);
    const C = art(s, 'Seattle airport security staffing plan expands with overnight shifts', null, 8);
    await clusterArticles(db, ai, [C]);
    expect(asked).toEqual([1]); expect(clusterOf(C)).toBe(clusterOf(A)); // joined only on the model's confirmation
  });
});

import { describe, it, expect, beforeEach } from 'vitest';
import { memDb } from './helpers.js';
import { clusterArticles, createSingleton } from '../server/news/cluster.js';
import { assessNovelty, BASELINE_MAX, type Coverage } from '../server/news/novelty.js';
import { queryFeed } from '../server/news/query.js';
import { Ai, type AiTransport } from '../server/ai/gemini.js';
import type { DB } from '../server/db.js';

const c = (title: string, excerpt = ''): Coverage => ({ title, excerpt });
const kind = (article: Coverage, ...baseline: Coverage[]) => assessNovelty(article, baseline).kind;
const FRESH = ['duplicate', 'minor'];

describe('local novelty detection', () => {
  it.each([
    ['proposal -> approved', c('Seattle council proposes new housing plan downtown', 'The proposal would add 400 units.'), c('Seattle council approves new housing plan downtown', 'Members voted 7-2 on Monday.')],
    ['investigation -> arrest', c('Police investigate fatal crash on Pacific Highway', 'Detectives are seeking witnesses.'), c('Driver arrested after fatal crash on Pacific Highway', 'Police said the 34-year-old was booked.')],
    ['product announced -> recall', c('Acme unveils new Roadster electric car with 400-mile range', 'The Roadster starts at $48,000.'), c('Acme recalls Roadster electric car over battery fire risk', 'The recall covers 20,000 vehicles.')],
    ['earnings -> guidance revised', c('Acme reports third-quarter earnings above forecasts', 'Revenue rose 8%.'), c('Acme cuts full-year guidance after weak orders', 'The company lowered its outlook.')],
    ['resignation', c('Acme board reviews chief executive performance'), c('Acme chief executive resigns after board review')],
    ['conviction', c('Jury hears closing arguments in Tacoma fraud trial'), c('Tacoma fraud defendant convicted on all counts')],
  ])('SUBSTANTIVE: %s', (_n, base, art) => { expect(kind(art, base)).toBe('substantive'); });

  it.each([
    ['proposal repeated by another publisher', c('Seattle council proposes new housing plan downtown', 'The proposal would add 400 units.'), c('Council housing plan: what Seattle residents should know', 'A new proposal would add 400 units downtown.')],
    ['product specs repeated', c('Acme unveils new Roadster electric car with 400-mile range', 'The Roadster starts at $48,000.'), c('Acme Roadster: price, range and specs of the new electric car', 'It starts at $48,000 with a 400-mile range.')],
    ['earnings commentary', c('Acme reports third-quarter earnings above forecasts', 'Revenue rose 8%.'), c('What Acme’s earnings beat means for investors', 'Analysts said the 8% revenue rise surprised many.')],
    ['same crash, new detail', c('Police investigate fatal crash on Pacific Highway'), c('Fatal Pacific Highway crash: neighbors remember victim', 'Friends described the driver as careful.')],
    ['ALL-CAPS headline style', c('Seattle council approves new housing plan'), c('SEATTLE COUNCIL APPROVES NEW HOUSING PLAN!', 'Members approved the plan.')],
    ['question-style headline', c('Seattle council approves new housing plan'), c('Did Seattle’s council just fix housing? The plan it approved', 'The approved plan adds units.')],
    ['a new publisher, same words', c('Acme recalls Roadster electric car over battery fire risk'), c('Acme recalls Roadster electric car over battery fire risk')],
  ])('NOT substantive: %s', (_n, base, art) => { expect(FRESH).toContain(kind(art, base)); });

  it('a milestone the story already reported is not new', () => {
    expect(kind(c('Council approves plan, mayor says it will take effect in May'), c('Seattle council approves new housing plan', 'It passed 7-2.'))).not.toBe('substantive');
  });
  it('REGRESSION: a negated mention is not a development ("has not approved")', () => {
    expect(kind(c('Council has not approved the housing plan, mayor says'), c('Seattle council proposes new housing plan'))).not.toBe('substantive');
  });
  it('a milestone only in the body text is ambiguous (background or news?), never decided locally', () => {
    expect(kind(c('Seattle housing plan: what happens next', 'The council approved the plan on Monday after a long debate.'), c('Seattle council proposes new housing plan downtown'))).toBe('ambiguous');
  });
  it('a headline that reverses an earlier report is ambiguous', () => {
    expect(kind(c('Seattle council rejects housing proposal'), c('Seattle council approves housing proposal'))).toBe('ambiguous');
  });
  it('new figures count only together with revision wording; figures alone are added detail', () => {
    expect(kind(c('Wildfire grows, now 900 homes under evacuation notices', 'Up from 400 homes on Saturday.'), c('Wildfire near Wenatchee forces evacuation notices', 'About 400 homes were told to leave.'))).toBe('ambiguous');
    expect(FRESH).toContain(kind(c('Wenatchee wildfire: crews from 12 agencies respond', 'Seven helicopters are working the blaze.'), c('Wildfire near Wenatchee forces evacuation notices', 'About 400 homes were told to leave.')));
  });
  it('is bounded: only the newest few baseline articles are read', () => {
    const many = Array.from({ length: 50 }, (_, i) => c(`Filler story ${i}`)); expect(() => assessNovelty(c('Anything'), many)).not.toThrow();
    expect(kind(c('Seattle council approves plan'), ...Array.from({ length: BASELINE_MAX }, () => c('Unrelated')), c('Seattle council approves plan earlier'))).toBe('substantive'); // coverage beyond the newest few is not compared
  });
});

describe('what happens to a story you have already read', () => {
  let db: DB; let n = 0; const HOUR = 3_600_000;
  const source = (name: string) => Number(db.prepare('INSERT INTO sources (name, site_url, created_at) VALUES (?,?,0)').run(name, `https://${name}${++n}.example`).lastInsertRowid);
  function article(src: number, title: string, ageH: number, excerpt = '') {
    n++; const at = Date.now() - ageH * HOUR; const pub = (db.prepare('SELECT name FROM sources WHERE id = ?').get(src) as any).name;
    const id = Number(db.prepare(`INSERT INTO articles (source_id,url,canonical_url,canonical_hash,publisher,title,title_norm,excerpt,published_at,fetched_at,content_hash,availability,summary,summary_kind)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,'excerpt',?,'excerpt')`).run(src, `https://e.example/${n}`, `https://e.example/${n}`, `h${n}`, pub, title, title.toLowerCase(), excerpt || null, at, at, `c${n}`, excerpt || null).lastInsertRowid);
    db.prepare('INSERT INTO article_sources VALUES (?,?,?)').run(id, src, at); return id;
  }
  const clusterOf = (a: number) => (db.prepare('SELECT cluster_id c FROM articles WHERE id = ?').get(a) as any).c as number;
  const markRead = (cl: number, at = Date.now()) => db.prepare('INSERT INTO reading_state (cluster_id, read_at) VALUES (?,?) ON CONFLICT(cluster_id) DO UPDATE SET read_at = excluded.read_at').run(cl, at);
  const readAt = (cl: number) => (db.prepare('SELECT read_at FROM reading_state WHERE cluster_id = ?').get(cl) as any)?.read_at as number | null;
  const subst = (cl: number) => (db.prepare('SELECT substantive_at s FROM story_clusters WHERE id = ?').get(cl) as any).s as number | null;
  const feed = (extra: Record<string, string> = {}) => queryFeed(db, { tab: 'latest', limit: 50, ...extra }).items;
  const sameEvent = (answer = true) => ({ canCall: () => true, enabled: true, verifyPairs: async (pairs: any[]) => new Map(pairs.map((p: any) => [p.id, answer])) } as any);
  /** A story read an hour ago, then one more article joins (forced into it via the pair-confirmation path). */
  async function scenario(first: string, firstExcerpt: string, next: string, nextExcerpt: string, ai: any = null) {
    const a = source('Alpha'), b = source('Beta'); const x = article(a, first, 6, firstExcerpt); const cl = createSingleton(db, x); markRead(cl, Date.now() - 2 * HOUR);
    const read0 = readAt(cl); const y = article(b, next, 1, nextExcerpt); await clusterArticles(db, ai ?? sameEvent(), [y]); return { cl, x, y, read0 };
  }
  beforeEach(() => { db = memDb(); });

  it('REGRESSION: a proposal that is then APPROVED reopens the story once, labelled Updated; the read time is untouched; reading it again hides it', async () => {
    const { cl, y, read0 } = await scenario('Seattle council proposes new housing plan downtown', 'The proposal would add 400 units.', 'Seattle council approves new housing plan downtown', 'Members voted 7-2 on Monday.');
    expect(clusterOf(y)).toBe(cl); expect(readAt(cl)).toBe(read0); expect(subst(cl)).toBeGreaterThan(read0!);
    expect(feed()[0]).toMatchObject({ id: cl, isRead: true, isUpdated: true, sourceCount: 2 });
    await new Promise((r) => setTimeout(r, 15)); markRead(cl); expect(feed()).toEqual([]); expect(subst(cl)).toBeLessThan(readAt(cl)!);
  });
  it('REGRESSION: repeating the same information keeps it read', async () => {
    const { cl, y, read0 } = await scenario('Seattle council proposes new housing plan downtown', 'The proposal would add 400 units.', 'Seattle council housing plan downtown: what residents should know', 'A new proposal would add 400 units downtown.');
    expect(clusterOf(y)).toBe(cl); expect(subst(cl)).toBeNull(); expect(readAt(cl)).toBe(read0); expect(feed()).toEqual([]);
  });
  it.each([
    ['investigation -> arrest', 'Police investigate fatal crash on Pacific Highway', 'Detectives are seeking witnesses.', 'Driver arrested after fatal crash on Pacific Highway', 'Police said the 34-year-old was booked.', true],
    ['product -> recall', 'Acme Roadster electric car owners report battery fire risk', 'Owners posted videos.', 'Acme recalls Roadster electric car over battery fire risk', 'The recall covers 20,000 vehicles.', true],
    ['product specs repeated', 'Acme unveils Roadster electric car with 400-mile range', 'It starts at $48,000.', 'Acme Roadster electric car: price and range of the new model', 'It starts at $48,000 with 400 miles.', false],
    ['earnings -> commentary', 'Acme reports third-quarter earnings above forecasts', 'Revenue rose 8%.', 'What Acme third-quarter earnings above forecasts mean for investors', 'The 8% revenue rise surprised analysts.', false],
    ['guidance revised', 'Acme reports third-quarter earnings and full-year guidance', 'Revenue rose 8%.', 'Acme cuts full-year guidance after third-quarter earnings', 'The company lowered its outlook.', true],
  ])('%s', async (_n, f, fe, nx, ne, reopens) => {
    const { cl, y, read0 } = await scenario(f, fe, nx, ne); expect(clusterOf(y)).toBe(cl); /* it really joined the read story */ expect(readAt(cl)).toBe(read0); expect(subst(cl) !== null).toBe(reopens); expect(feed().length).toBe(reopens ? 1 : 0);
  });
  it('an unread story is not examined at all', async () => {
    const a = source('Alpha'), b = source('Beta'); const x = article(a, 'Seattle council proposes new housing plan downtown', 6); const cl = createSingleton(db, x);
    await clusterArticles(db, sameEvent(), [article(b, 'Seattle council approves new housing plan downtown', 1)]); expect(subst(cl)).toBeNull(); expect(feed()[0]).toMatchObject({ id: cl, isRead: false, isUpdated: false });
  });
  it('coverage published before you read the story is not news since', async () => {
    const a = source('Alpha'), b = source('Beta'); const x = article(a, 'Seattle council proposes new housing plan downtown', 9); const cl = createSingleton(db, x); markRead(cl, Date.now() - HOUR);
    await clusterArticles(db, sameEvent(), [article(b, 'Seattle council approves new housing plan downtown', 3)]); expect(subst(cl)).toBeNull();
  });
  it('after you read an Updated story, a further development reopens it again; repeated coverage in between does not', async () => {
    const { cl } = await scenario('Seattle council proposes new housing plan downtown', '', 'Seattle council approves new housing plan downtown', '');
    markRead(cl); await new Promise((r) => setTimeout(r, 15)); const b = source('Gamma'); await clusterArticles(db, sameEvent(), [article(b, 'Seattle council housing plan downtown: what approval means for residents', -0.001)]); expect(feed()).toEqual([]);
    await clusterArticles(db, sameEvent(), [article(b, 'Seattle council housing plan downtown: lead sponsor resigns after approval', -0.002)]); // a later milestone (a resignation) not yet reported
    expect(feed()[0]).toMatchObject({ id: cl, isUpdated: true });
  });
  it('bookmarks, feedback, membership and sources survive a reopening', async () => {
    const a = source('Alpha'), b = source('Beta'); const x = article(a, 'Seattle council proposes new housing plan downtown', 6); const cl = createSingleton(db, x); markRead(cl, Date.now() - 2 * HOUR);
    db.prepare('INSERT INTO bookmarks VALUES (?,5)').run(cl); db.prepare('INSERT INTO feedback (cluster_id, rating, reason, category, created_at, updated_at) VALUES (?,1,NULL,NULL,1,1)').run(cl);
    const y = article(b, 'Seattle council approves new housing plan downtown', 1); await clusterArticles(db, sameEvent(), [y]);
    expect(clusterOf(x)).toBe(cl); expect(clusterOf(y)).toBe(cl); expect(db.prepare('SELECT COUNT(*) n FROM cluster_articles WHERE cluster_id = ?').get(cl)).toEqual({ n: 2 });
    expect(db.prepare('SELECT created_at FROM bookmarks WHERE cluster_id = ?').get(cl)).toEqual({ created_at: 5 }); expect(db.prepare('SELECT rating FROM feedback WHERE cluster_id = ?').get(cl)).toEqual({ rating: 1 });
    expect(feed()[0]).toMatchObject({ bookmarked: true, rating: 1, sourceCount: 2 }); expect(db.pragma('foreign_key_check')).toEqual([]);
  });
});

describe('Gemini is used only for the ambiguous remainder', () => {
  let db: DB; let n = 0; const HOUR = 3_600_000; let asked: string[];
  const source = (name: string) => Number(db.prepare('INSERT INTO sources (name, site_url, created_at) VALUES (?,?,0)').run(name, `https://${name}${++n}.example`).lastInsertRowid);
  function article(src: number, title: string, ageH: number, excerpt = '') {
    n++; const at = Date.now() - ageH * HOUR; const pub = (db.prepare('SELECT name FROM sources WHERE id = ?').get(src) as any).name;
    const id = Number(db.prepare(`INSERT INTO articles (source_id,url,canonical_url,canonical_hash,publisher,title,title_norm,excerpt,published_at,fetched_at,content_hash,availability,summary,summary_kind)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,'excerpt',?,'excerpt')`).run(src, `https://e.example/${n}`, `https://e.example/${n}`, `h${n}`, pub, title, title.toLowerCase(), excerpt || null, at, at, `c${n}`, excerpt || null).lastInsertRowid);
    db.prepare('INSERT INTO article_sources VALUES (?,?,?)').run(id, src, at); return id;
  }
  const markRead = (cl: number, at: number) => db.prepare('INSERT INTO reading_state (cluster_id, read_at) VALUES (?,?) ON CONFLICT(cluster_id) DO UPDATE SET read_at = excluded.read_at').run(cl, at);
  const subst = (cl: number) => (db.prepare('SELECT substantive_at s FROM story_clusters WHERE id = ?').get(cl) as any).s as number | null;
  /** answer(prompt) decides each <item>; pair prompts always say "same event". */
  const model = (answer: (item: string) => boolean, budget = 100, during?: () => void) => {
    const transport: AiTransport = { async generateJson({ prompt }) {
      if (prompt.includes('<pair')) return { text: JSON.stringify({ pairs: [...prompt.matchAll(/<pair id="(\d+)"/g)].map((m) => ({ id: Number(m[1]), same_event: true })) }), inputTokens: 1, outputTokens: 1 };
      asked.push(prompt); during?.();
      const items = [...prompt.matchAll(/<item id="(\d+)">([\s\S]*?)<\/item>/g)].map((m) => ({ id: Number(m[1]), new_development: answer(m[2]) }));
      return { text: JSON.stringify({ items }), inputTokens: 1, outputTokens: 1 };
    } };
    return new Ai(db, 'm', transport, budget);
  };
  const run = async (ai: Ai, next: string, nextExcerpt: string) => {
    const a = source('Alpha'), b = source('Beta'); const x = article(a, 'Seattle council proposes new housing plan downtown', 6, 'The proposal would add 400 units.'); const cl = Number((db.prepare('INSERT INTO story_clusters (primary_article_id,title,first_published_at,last_published_at,updated_at,created_at) VALUES (?,?,1,1,1,1)').run(x, 'T').lastInsertRowid));
    db.prepare('UPDATE articles SET cluster_id = ? WHERE id = ?').run(cl, x); db.prepare('INSERT INTO cluster_articles VALUES (?,?,0,?)').run(cl, x, 1); const read = Date.now() - 2 * HOUR; markRead(cl, read);
    const y = article(b, next, 1, nextExcerpt); await clusterArticles(db, ai, [y]); return { cl, read, y };
  };
  beforeEach(() => { db = memDb(); asked = []; });
  const AMBIG = ['Seattle housing plan downtown: what happens next', 'The council approved the plan on Monday after a long debate over 400 units.'] as const;

  it('REGRESSION: an ambiguous article is judged by the model; a "yes" reopens the story once', async () => {
    const { cl, read } = await run(model(() => true), ...AMBIG); expect(asked).toHaveLength(1); expect(asked[0]).toMatch(/Already read/); expect(subst(cl)).toBeGreaterThan(read);
  });
  it('a "no", an unusable answer or a missing model leaves it read (err toward read)', async () => {
    expect(subst((await run(model(() => false), ...AMBIG)).cl)).toBeNull();
    db = memDb(); asked = []; expect(subst((await run(model(() => true, 0), ...AMBIG)).cl)).toBeNull(); // budget exhausted: not asked, stays read
    db = memDb(); asked = []; const pairOnly = { canCall: () => true, enabled: true, verifyPairs: async (p: any[]) => new Map(p.map((x) => [x.id, true])) } as unknown as Ai; expect(subst((await run(pairOnly, ...AMBIG)).cl)).toBeNull();
  });
  it('REGRESSION: the model is not asked about clear cases: duplicates, repeats and plain milestones', async () => {
    await run(model(() => true), 'Seattle council approves new housing plan downtown', 'Members voted 7-2.'); // substantive locally
    await run(model(() => true), 'Council housing plan: what Seattle residents should know', 'A new proposal would add 400 units downtown.'); // repeat locally
    expect(asked).toEqual([]);
  });
  it('is counted against the daily budget and the answer is cached (a repeat of the same question costs nothing)', async () => {
    const ai = model(() => true); const { cl } = await run(ai, ...AMBIG);
    const used = ai.requestsToday(); expect(used).toBeGreaterThanOrEqual(1); // the novelty question was reserved before sending
    const job = { id: 1, articleHash: 'a', baselineHash: 'b', article: { publisher: 'P', title: 'T', excerpt: null }, baseline: [{ publisher: 'Q', title: 'U', excerpt: null }] };
    await ai.assessDevelopments([job]); const afterFirst = ai.requestsToday(); await ai.assessDevelopments([job]); expect(ai.requestsToday()).toBe(afterFirst); expect(cl).toBeGreaterThan(0);
  });
  it('REGRESSION: if you read the story again while the model was thinking, nothing is reopened', async () => {
    const readLater = () => { db.prepare("UPDATE reading_state SET read_at = ? WHERE read_at IS NOT NULL").run(Date.now() + 1000); };
    const { cl } = await run(model(() => true, 100, readLater), ...AMBIG); expect(subst(cl)).toBeNull();
  });
  it('REGRESSION: an article ungrouped (or moved) while the model was thinking does not reopen the story', async () => {
    const ungroup = () => { db.prepare('UPDATE articles SET cluster_id = NULL WHERE id = (SELECT MAX(id) FROM articles)').run(); };
    const { cl } = await run(model(() => true, 100, ungroup), ...AMBIG); expect(subst(cl)).toBeNull();
  });
});

describe('REGRESSION: legal developments are distinct stages', () => {
  const ARREST = c('Man arrested in Tacoma robbery spree', 'Police booked the 31-year-old on Tuesday.');
  it.each([
    ['arrest -> conviction', ARREST, c('Tacoma robbery spree suspect convicted by jury', 'Jurors returned a guilty verdict.')],
    ['charges -> sentencing', c('Prosecutors charged Tacoma fraud suspect with theft'), c('Tacoma fraud suspect sentenced to five years in prison')],
    ['arrest -> charges', ARREST, c('Tacoma robbery suspect charged with six counts')],
    ['charges -> trial', c('Tacoma fraud suspect charged with theft'), c('Trial begins for Tacoma fraud suspect', 'Jury selection started Monday.')],
    ['arrest -> acquittal', ARREST, c('Tacoma robbery suspect acquitted on all counts', 'The jury found him not guilty.')],
    ['sentencing -> appeal', c('Tacoma fraud suspect sentenced to five years'), c('Tacoma fraud defendant appeals sentence', 'His lawyers filed an appeal on Friday.')],
    ['investigation -> sentencing (a stage may be skipped)', c('Police investigate Tacoma robbery spree'), c('Tacoma robbery spree suspect sentenced to ten years')],
  ])('SUBSTANTIVE: %s', (_n, base, art) => { expect(kind(art, base)).toBe('substantive'); });
  it.each([
    ['the same arrest in other words', c('Police arrest man in Tacoma robbery spree'), c('Tacoma robbery spree: suspect arrested Tuesday')],
    ['the same arrest, "booked"', c('Police arrest man in Tacoma robbery spree'), c('Tacoma robbery suspect booked into county jail')],
    ['the same conviction in other words', c('Tacoma fraud defendant convicted by jury'), c('Jury finds Tacoma fraud defendant guilty on all counts')],
    ['an EARLIER stage reported late', c('Tacoma fraud suspect sentenced to five years'), c('Tacoma fraud suspect was arrested in March, records show')],
    ['the same sentencing again', c('Tacoma fraud suspect sentenced to five years'), c('Judge sentences Tacoma fraud suspect to five years in prison')],
  ])('NOT substantive: %s', (_n, base, art) => { expect(kind(art, base)).not.toBe('substantive'); });
  it('conviction and acquittal are different outcomes: moving to either from an arrest is news, switching between them is a reversal for the model', () => {
    expect(kind(c('Tacoma suspect convicted by jury'), ARREST)).toBe('substantive'); expect(kind(c('Tacoma suspect acquitted by jury'), ARREST)).toBe('substantive');
    expect(kind(c('Tacoma suspect acquitted by jury'), c('Tacoma suspect convicted by jury'))).toBe('ambiguous'); expect(kind(c('Tacoma suspect convicted at retrial'), c('Tacoma suspect acquitted by jury'))).toBe('ambiguous');
  });
  it('a legal stage mentioned only in the body text is ambiguous (the model decides), not decided locally', () => {
    expect(kind(c('Tacoma robbery spree: what we know', 'The man was convicted by a jury on Friday.'), ARREST)).toBe('ambiguous');
  });
});

describe('REGRESSION: expectations and questions are not confirmed milestones', () => {
  const BASE = c('Seattle council proposes new housing proposal downtown', 'The proposal would add 400 units.');
  it.each([
    'Council expected to approve housing proposal', 'Could council approve housing proposal?', 'Council may approve housing proposal next week', 'Council set to approve housing proposal',
    'Council plans to approve housing proposal', 'Council likely to approve housing proposal', 'Council considering approval of housing proposal', 'Will council approve housing proposal?',
    'Housing proposal approval expected Tuesday', 'Council might approve housing proposal if amended', 'Council poised to approve housing proposal', 'Council to vote on whether to approve housing proposal',
  ])('not a development: %s', (title) => { expect(['duplicate', 'minor']).toContain(kind(c(title), BASE)); }); // and not "ambiguous": no model request is spent on a forecast
  it('a confirmed decision is substantive', () => { expect(kind(c('Council approves housing proposal'), BASE)).toBe('substantive'); expect(kind(c('Council approved the housing proposal 7-2'), BASE)).toBe('substantive'); });
  it('negation is not a decision', () => { for (const t of ['Council does not approve housing proposal', 'Council has not approved housing proposal', 'Council never approved housing proposal']) expect(kind(c(t), BASE), t).not.toBe('substantive'); });
  it('prediction -> actual decision IS substantive; decision -> later prediction is not', () => {
    expect(kind(c('Council approves housing proposal'), c('Council expected to approve housing proposal'))).toBe('substantive');
    expect(kind(c('Council expected to approve revised housing proposal'), c('Council approves housing proposal'))).not.toBe('substantive');
  });
  it('a speculative headline over a body that says it happened is ambiguous, for the model', () => {
    expect(kind(c('Could council approve the proposal?', 'The council approved the housing proposal on Monday night.'), BASE)).toBe('ambiguous');
  });
  it('speculation applies to every milestone type, not just approvals', () => {
    for (const t of ['Driver expected to be arrested after crash', 'Acme could recall Roadster over battery fire risk', 'Acme may cut full-year guidance', 'Chief executive likely to resign']) expect(kind(c(t), c('Police investigate crash'), c('Acme Roadster owners report fires'), c('Acme reports earnings'), c('Board reviews chief executive')), t).not.toBe('substantive');
  });
});

describe('integration: stage changes and forecasts on a story you have read', () => {
  let db: DB; let n = 0; const HOUR = 3_600_000; let asked: string[];
  const source = (name: string) => Number(db.prepare('INSERT INTO sources (name, site_url, created_at) VALUES (?,?,0)').run(name, `https://${name}${++n}.example`).lastInsertRowid);
  function article(src: number, title: string, ageH: number, excerpt = '') {
    n++; const at = Date.now() - ageH * HOUR; const pub = (db.prepare('SELECT name FROM sources WHERE id = ?').get(src) as any).name;
    const id = Number(db.prepare(`INSERT INTO articles (source_id,url,canonical_url,canonical_hash,publisher,title,title_norm,excerpt,published_at,fetched_at,content_hash,availability,summary,summary_kind)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,'excerpt',?,'excerpt')`).run(src, `https://e.example/${n}`, `https://e.example/${n}`, `h${n}`, pub, title, title.toLowerCase(), excerpt || null, at, at, `c${n}`, excerpt || null).lastInsertRowid);
    db.prepare('INSERT INTO article_sources VALUES (?,?,?)').run(id, src, at); return id;
  }
  const subst = (cl: number) => (db.prepare('SELECT substantive_at s FROM story_clusters WHERE id = ?').get(cl) as any).s as number | null;
  const model = (answer: boolean) => new Ai(db, 'm', { async generateJson({ prompt }) {
    if (prompt.includes('<pair')) return { text: JSON.stringify({ pairs: [...prompt.matchAll(/<pair id="(\d+)"/g)].map((m) => ({ id: Number(m[1]), same_event: true })) }), inputTokens: 1, outputTokens: 1 };
    asked.push(prompt); return { text: JSON.stringify({ items: [...prompt.matchAll(/<item id="(\d+)"/g)].map((m) => ({ id: Number(m[1]), new_development: answer })) }), inputTokens: 1, outputTokens: 1 };
  } } as AiTransport, 100);
  /** A story read two hours ago; each later article is joined in order (forced into the story). */
  async function story(first: [string, string], later: [string, string][], ai: Ai) {
    const a = source('Alpha'); const x = article(a, first[0], 6, first[1]); const cl = createSingleton(db, x); db.prepare('INSERT INTO reading_state (cluster_id, read_at) VALUES (?,?)').run(cl, Date.now() - 2 * HOUR);
    for (const [t, e] of later) { await clusterArticles(db, ai, [article(source('Beta'), t, 1, e)]); }
    return cl;
  }
  beforeEach(() => { db = memDb(); asked = []; });

  it('REGRESSION: arrest -> conviction reopens the story (before: both were "legal", so it stayed hidden)', async () => {
    const cl = await story(['Man arrested in Tacoma robbery spree', 'Police booked the 31-year-old.'], [['Tacoma robbery spree man convicted by jury', 'Jurors returned a guilty verdict.']], model(true));
    expect(subst(cl)).not.toBeNull(); expect(asked).toEqual([]); // decided locally
  });
  it('REGRESSION: the same arrest in other words keeps it read, and the model is not asked', async () => {
    const cl = await story(['Man arrested in Tacoma robbery spree', 'Police booked the 31-year-old.'], [['Police arrest man in Tacoma robbery spree', 'The suspect was booked.']], model(true));
    expect(subst(cl)).toBeNull(); expect(asked).toEqual([]);
  });
  it('REGRESSION: a forecast ("expected to approve") keeps it read with no model request; the real decision then reopens it once', async () => {
    const cl = await story(['Seattle council proposes new housing plan downtown', 'The proposal would add 400 units.'], [['Seattle council expected to approve new housing plan downtown', 'A vote is scheduled Monday.']], model(true));
    expect(subst(cl)).toBeNull(); expect(asked).toEqual([]);
    await clusterArticles(db, model(true), [article(source('Gamma'), 'Seattle council approves new housing plan downtown', -0.001, 'Members voted 7-2.')]); expect(subst(cl)).not.toBeNull();
  });
  it('an ambiguous legal stage goes to the model; "no", or no model, leaves it read', async () => {
    const mk = (ai: Ai) => story(['Man arrested in Tacoma robbery spree', 'Police booked him.'], [['Tacoma robbery spree: what we know', 'The man was convicted by a jury on Friday after a short trial.']], ai);
    expect(subst(await mk(model(false)))).toBeNull(); expect(asked).toHaveLength(1);
    db = memDb(); asked = []; expect(subst(await mk(model(true)))).not.toBeNull();
    db = memDb(); asked = []; expect(subst(await mk(new Ai(db, 'm', null, 100)))).toBeNull(); // no model configured
  });
});

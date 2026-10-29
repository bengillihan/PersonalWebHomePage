import { describe, it, expect } from 'vitest';
import { contradicts } from '../server/news/contradiction.js';
import { headlineSimilarity, MERGE_THRESHOLD } from '../server/news/cluster.js';

describe('contradicts(): opposing claims', () => {
  it.each([
    ['Seattle council approves housing proposal', 'Seattle council rejects housing proposal'],
    ['State senate passes budget bill', 'State senate fails budget bill'],
    ['Seahawks win home opener', 'Seahawks lose home opener'], ['Mariners beat Astros in extras', 'Mariners lose to Astros in extras'],
    ['City raises parking fees downtown', 'City cuts parking fees downtown'], ['Unemployment rises in King County', 'Unemployment falls in King County'],
    ['Stocks rally as Dow climbs', 'Stocks slump as Dow tumbles'], ['Dow up 200 points', 'Dow down 200 points'],
    ['Company confirms layoffs', 'Company denies layoffs'], ['Governor signs housing bill', 'Governor vetoes housing bill'],
    ['Port opens new terminal', 'Port closes new terminal'], ['Judge upholds new state law on rent', 'Judge blocks new state law on rent'],
    ['Jury convicts former mayor', 'Jury acquits former mayor'], ['State allows e-bikes on trails', 'State bans e-bikes on trails'],
    ['Police arrest suspect in robbery', 'Police release suspect in robbery'], ['Firm acquires startup', 'Firm sells startup'],
    ['Player tests positive for virus', 'Player tests negative for virus'], ['Bridge reopens after repairs', 'Bridge closes after repairs'],
    ['Council approves housing proposal', 'Council does not approve housing proposal'], ['Council approves housing proposal', "Council doesn't approve housing proposal"],
    ['Seahawks beat 49ers 27-24', '49ers beat Seahawks 27-24'],
  ])('%s / %s', (a, b) => { expect(contradicts(a, b)).toBe(true); expect(contradicts(b, a)).toBe(true); }); // symmetric

  it('REGRESSION: the reported pair is highly similar by wording alone, which is exactly why it used to merge', () => {
    const a = 'Seattle council approves housing proposal', b = 'Seattle council rejects housing proposal';
    expect(headlineSimilarity(a, b)).toBe(0.8); expect(headlineSimilarity(a, b)).toBeGreaterThan(MERGE_THRESHOLD); expect(contradicts(a, b)).toBe(true);
  });
});

describe('contradicts(): things that must NOT be flagged', () => {
  it.each([
    ['Seattle council approves housing proposal', 'Seattle council approves housing proposal after revisions'], // update
    ['Seattle council approves housing proposal', 'Seattle City Council approves housing plan'], // paraphrase
    ['Seahawks beat 49ers 27-24', 'Seahawks beat 49ers in overtime thriller'], ['Seahawks win home opener', 'Seahawks win home opener over Rams'],
    ['Stocks rally on earnings', 'Stocks rally as earnings beat estimates'], ['Port opens new terminal', 'Port opens new terminal to ships'],
    ['Council approves plan', 'Council housing plan vote tonight'], // the other headline takes no side
    ['Mayor unveils harbor plan', 'Weather: rain returns to Seattle'], // unrelated
    ['City raises fees but cuts taxes', 'City raises fees but cuts taxes again'], // a title that mentions both sides (twice, identically) is not "opposite" to itself
    ['Seahawks beat 49ers', 'Seahawks beat 49ers'],
  ])('%s / %s', (a, b) => { expect(contradicts(a, b)).toBe(false); });

  it('a headline that mentions both sides is ignored for that action (it cannot be "the opposite" of anything)', () => {
    expect(contradicts('Council approves one plan, rejects another', 'Council approves housing plan')).toBe(false);
    expect(contradicts('Council approves one plan, rejects another', 'Council rejects housing plan')).toBe(false);
  });

  it('is cheap: thousands of comparisons take a few milliseconds', () => {
    const t0 = performance.now(); let hits = 0;
    for (let i = 0; i < 5000; i++) if (contradicts(`Seattle council approves housing proposal number ${i}`, `Seattle council rejects housing proposal number ${i}`)) hits++;
    expect(hits).toBe(5000); expect(performance.now() - t0).toBeLessThan(500);
  });
});

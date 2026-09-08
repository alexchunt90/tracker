/*
 * The season, as other people saw it: how records fall into weeks and
 * cohorts, and where a run of counts tops out.
 *
 * The failure worth guarding against is a peak that is an artefact of the
 * binning rather than the fungus — a week that straddles a year end, a record
 * placed on a hillside it was never on because its point was obscured, a
 * "peak" that is one person's Saturday.
 *
 *   node --test test/trends.test.js
 */
const assert = require('node:assert');
const { test } = require('node:test');
const Trends = require('../public/trends.js');

const row = (on, metres, extra = {}) => ({ on, metres, acc: null, obscured: false, ...extra });

test('a week is seven days from the first of January, and every year has fifty-two', () => {
  assert.strictEqual(Trends.weekOf(1), 0);
  assert.strictEqual(Trends.weekOf(7), 0);
  assert.strictEqual(Trends.weekOf(8), 1);
  assert.strictEqual(Trends.weekOf(365), 51);
  assert.strictEqual(Trends.weekOf(366), 51);
  assert.strictEqual(Trends.WEEKS, 52);
});

test('days are counted by hand, in the local calendar, leap years included', () => {
  assert.deepStrictEqual(Trends.dayOfYear('2024-01-01'), { year: 2024, day: 1 });
  assert.deepStrictEqual(Trends.dayOfYear('2024-03-01'), { year: 2024, day: 61 });
  assert.deepStrictEqual(Trends.dayOfYear('2023-03-01'), { year: 2023, day: 60 });
  assert.deepStrictEqual(Trends.dayOfYear('2023-12-31'), { year: 2023, day: 365 });
  assert.strictEqual(Trends.dayOfYear(''), null);
  assert.strictEqual(Trends.dayOfYear(null), null);
  assert.strictEqual(Trends.dayOfYear('2023-13-01'), null);
  assert.strictEqual(Trends.dayLabel(1), 'Jan 1');
  assert.strictEqual(Trends.dayLabel(285), 'Oct 12');
  assert.strictEqual(Trends.weekLabel(40), 'Oct 8');
});

test('cohorts come from the edges, lowest first, and a value lands in exactly one', () => {
  const bands = Trends.bands([300, 700, 1200]);
  assert.deepStrictEqual(bands.map((b) => b.label), ['Below 300 m', '300–700 m', '700–1200 m', 'Above 1200 m']);
  assert.strictEqual(Trends.bandIndex(0), 0);
  assert.strictEqual(Trends.bandIndex(299), 0);
  assert.strictEqual(Trends.bandIndex(300), 1);
  assert.strictEqual(Trends.bandIndex(1200), 3);
  assert.strictEqual(Trends.bandIndex(4000), 3);
  assert.strictEqual(Trends.bandIndex(null), -1);
  // Edges in any order, repeated, or nonsense: still a clean ladder.
  assert.deepStrictEqual(Trends.bands([700, 300, 300, -5, 'x']).map((b) => b.hi), [300, 700, Infinity]);
  assert.strictEqual(Trends.bands([]).length, 1);
});

test('an obscured or loosely placed record is counted but not put on a hillside', () => {
  const rows = [
    row('2023-10-10', 100),
    row('2023-10-10', 100, { obscured: true }),
    row('2023-10-10', 100, { acc: 5000 }),
    row('2023-10-10', 100, { acc: 500 }),
    row('2023-10-10', null),
    row('bad date', 100),
  ];
  const agg = Trends.aggregate(rows);
  assert.strictEqual(agg.dated, 5);
  assert.strictEqual(agg.undated, 1);
  assert.strictEqual(agg.placed, 2);
  assert.strictEqual(agg.unplaced, 3);
  assert.strictEqual(agg.bands[0].total, 2);
  assert.strictEqual(agg.bands[0].counts[Trends.weekOf(283)], 2);
});

test('one year can be pulled out of the pile, and the years are listed newest first', () => {
  const rows = [row('2021-09-01', 50), row('2023-09-01', 50), row('2023-09-02', 50), row('2022-09-01', 50)];
  assert.deepStrictEqual(Trends.yearsOf(rows), [2023, 2022, 2021]);
  assert.strictEqual(Trends.aggregate(rows, { year: 2023 }).placed, 2);
  assert.strictEqual(Trends.aggregate(rows).placed, 4);
});

test('the peak is the top of a smoothed run, and too thin a run has none', () => {
  const counts = new Array(52).fill(0);
  // A lone spike of eight in one week, next to a broad hump.
  counts[10] = 8;
  counts[30] = 4; counts[31] = 6; counts[32] = 5;
  assert.strictEqual(Trends.peakWeek(counts), 31);
  assert.strictEqual(Trends.peakWeek(new Array(52).fill(0)), null);
  const thin = new Array(52).fill(0);
  thin[20] = Trends.MIN_PEAK_COUNT - 1;
  assert.strictEqual(Trends.peakWeek(thin), null);
  // A single busy week is named as itself, not as the edge of its smoothed plateau.
  thin[20] = Trends.MIN_PEAK_COUNT;
  assert.strictEqual(Trends.peakWeek(thin), 20);
});

test('smoothing averages what is there at the ends rather than pulling them to zero', () => {
  assert.deepStrictEqual(Trends.smooth([4, 4, 4]), [4, 4, 4]);
  assert.deepStrictEqual(Trends.smooth([0, 3, 0]), [1.5, 1, 1.5]);
});

test('peaks come per year and per cohort, with the median beside each', () => {
  const rows = [];
  // Lowland: a September flush in 2023. Montane: the same year, a month later.
  for (let i = 0; i < 10; i++) rows.push(row(`2023-09-${String(10 + i).padStart(2, '0')}`, 100));
  for (let i = 0; i < 10; i++) rows.push(row(`2023-10-${String(10 + i).padStart(2, '0')}`, 900));
  // 2022: three records only, which is not a season.
  rows.push(row('2022-10-01', 100), row('2022-10-02', 100), row('2022-10-03', 100));
  const out = Trends.peaks(rows);
  assert.deepStrictEqual(out.map((y) => y.year), [2023, 2022]);
  const [y23, y22] = out;
  assert.strictEqual(y23.cohorts[0].count, 10);
  assert.strictEqual(y23.cohorts[2].count, 10);
  assert.ok(y23.cohorts[2].week > y23.cohorts[0].week, 'the montane peak comes later');
  assert.strictEqual(Trends.dayLabel(y23.cohorts[0].median), 'Sep 15');
  assert.strictEqual(y23.cohorts[1].count, 0);
  assert.strictEqual(y23.cohorts[1].week, null);
  assert.strictEqual(y22.cohorts[0].count, 3);
  assert.strictEqual(y22.cohorts[0].week, null);
  assert.strictEqual(y22.cohorts[0].median, null);
});

test('the median day is the middle record, or halfway between the middle two', () => {
  assert.strictEqual(Trends.medianDay([10, 30, 20]), 20);
  assert.strictEqual(Trends.medianDay([10, 20]), 15);
  assert.strictEqual(Trends.medianDay([]), null);
});

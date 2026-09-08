/* ==========================================================================
   The season, as other people saw it. No DOM here.

   The question the Trends view asks is "when does this species peak, and
   does it peak later up the hill". The raw material is a pile of dated,
   placed iNaturalist records with a ground elevation attached. This file
   turns the pile into weekly counts per altitude cohort and finds the week
   each year's flush topped out. It runs in the browser and under node:test,
   which is why it touches nothing but arrays.
   ========================================================================== */

'use strict';

const Trends = (() => {
  // Metres. The edges between cohorts, chosen for the Cascades and the
  // Olympics: the lowland second-growth that fruits first, the foothills,
  // the montane belt, and what is left above it. Overridable from config.
  const DEFAULT_BANDS = [300, 700, 1200];

  // A record whose stated accuracy is wider than this cannot be put on a
  // hillside with any honesty. Two kilometres in the mountains is a whole
  // cohort's worth of elevation. Records that state no accuracy at all are
  // kept: most of the older ones do not, and the point is the year they came
  // from, not the year iNaturalist started asking.
  const MAX_ACCURACY_M = 2000;

  // A week is seven days from the first of January, not the calendar's ISO
  // week: the point is that "week 40" means the same days every year, so
  // years can be laid over one another. The last bin takes the odd day or
  // two, which is why there are 52 and not 53.
  const WEEKS = 52;

  // Fewer records than this in a year and cohort and the "peak" is one
  // person's Saturday. Said as "too few" rather than guessed at.
  const MIN_PEAK_COUNT = 8;

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MONTH_DAYS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  /**
   * The cohorts a list of edges describes, lowest first. Each has a label
   * that says the range in plain metres, so the legend needs no key.
   */
  function bands(edges = DEFAULT_BANDS) {
    const clean = [...new Set((edges || []).map(Number).filter((n) => Number.isFinite(n) && n > 0))]
      .sort((a, b) => a - b);
    if (!clean.length) return [{ id: 'all', label: 'Any elevation', lo: -Infinity, hi: Infinity }];
    const out = [];
    for (let i = 0; i <= clean.length; i++) {
      const lo = i === 0 ? -Infinity : clean[i - 1];
      const hi = i === clean.length ? Infinity : clean[i];
      const label = i === 0 ? `Below ${hi} m`
        : i === clean.length ? `Above ${lo} m`
        : `${lo}–${hi} m`;
      out.push({ id: `band-${i}`, label, lo, hi });
    }
    return out;
  }

  /** Which cohort a ground elevation falls in, or -1 when there is none. */
  function bandIndex(metres, edges = DEFAULT_BANDS) {
    if (!Number.isFinite(metres)) return -1;
    const list = bands(edges);
    for (let i = 0; i < list.length; i++) if (metres < list[i].hi) return i;
    return list.length - 1;
  }

  /**
   * "2024-10-12" → { year, day } where day counts from 1 on the first of
   * January. Parsed by hand for the reason the rest of the app parses dates by
   * hand: `new Date("2024-10-12")` is midnight UTC, which is the day before
   * across most of the world where mushrooms grow.
   */
  function dayOfYear(on) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(on || ''));
    if (!m) return null;
    const year = Number(m[1]), month = Number(m[2]), date = Number(m[3]);
    if (month < 1 || month > 12 || date < 1 || date > 31) return null;
    let day = date;
    for (let i = 0; i < month - 1; i++) day += MONTH_DAYS[i] + (i === 1 && isLeap(year) ? 1 : 0);
    return { year, day };
  }

  const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

  /** The bin a day of the year falls in, 0-based. */
  const weekOf = (day) => Math.min(WEEKS - 1, Math.floor((day - 1) / 7));

  /** "Oct 12", for a day of the year in a non-leap year. Labels, not arithmetic. */
  function dayLabel(day) {
    let left = Math.max(1, Math.min(365, Math.round(day)));
    for (let i = 0; i < 12; i++) {
      if (left <= MONTH_DAYS[i]) return `${MONTHS[i]} ${left}`;
      left -= MONTH_DAYS[i];
    }
    return 'Dec 31';
  }

  /** The label for the first day of a week bin. */
  const weekLabel = (week) => dayLabel(week * 7 + 1);

  /**
   * Whether a record can be placed in a cohort. An obscured record's point is
   * deliberately wrong by up to a couple of tenths of a degree, and a record
   * whose accuracy circle would cover a valley and the ridge above it is not
   * evidence of either.
   */
  function placeable(row, maxAccuracy = MAX_ACCURACY_M) {
    if (!row || row.obscured) return false;
    if (!Number.isFinite(row.metres)) return false;
    if (Number.isFinite(row.acc) && row.acc > maxAccuracy) return false;
    return true;
  }

  /** Every year with at least one dated record, newest first. */
  function yearsOf(rows) {
    const seen = new Set();
    for (const r of rows || []) {
      const d = dayOfYear(r.on);
      if (d) seen.add(d.year);
    }
    return [...seen].sort((a, b) => b - a);
  }

  /**
   * Weekly counts per cohort, for one year or for every year folded together.
   *
   * Returns the cohorts with their counts, plus how many records were left
   * out and why, because a chart that quietly dropped a third of its evidence
   * would be lying by omission.
   */
  function aggregate(rows, { edges = DEFAULT_BANDS, year = null, maxAccuracy = MAX_ACCURACY_M } = {}) {
    const list = bands(edges).map((b) => ({ ...b, counts: new Array(WEEKS).fill(0), total: 0 }));
    let undated = 0, unplaced = 0, dated = 0;
    for (const r of rows || []) {
      const d = dayOfYear(r.on);
      if (!d) { undated++; continue; }
      if (year != null && d.year !== year) continue;
      dated++;
      if (!placeable(r, maxAccuracy)) { unplaced++; continue; }
      const i = bandIndex(r.metres, edges);
      if (i < 0) { unplaced++; continue; }
      list[i].counts[weekOf(d.day)]++;
      list[i].total++;
    }
    return { bands: list, dated, undated, unplaced, placed: dated - unplaced };
  }

  /** A three-week centred moving average; the ends average what is there. */
  function smooth(counts, radius = 1) {
    const out = [];
    for (let i = 0; i < counts.length; i++) {
      let sum = 0, n = 0;
      for (let j = Math.max(0, i - radius); j <= Math.min(counts.length - 1, i + radius); j++) { sum += counts[j]; n++; }
      out.push(sum / n);
    }
    return out;
  }

  /**
   * The week a run of counts tops out, after smoothing, or null when the run
   * is too thin to have a top.
   *
   * A smoothed plateau is broken by the raw count under it, so a single
   * busy week is named as itself rather than as the week before it; a tie
   * that survives that goes to the earlier week.
   */
  function peakWeek(counts, minCount = MIN_PEAK_COUNT) {
    const total = counts.reduce((a, b) => a + b, 0);
    if (total < minCount) return null;
    const s = smooth(counts);
    let best = 0;
    for (let i = 1; i < s.length; i++) {
      const level = Math.abs(s[i] - s[best]) < 1e-9;
      if (s[i] > s[best] + 1e-9 || (level && counts[i] > counts[best])) best = i;
    }
    return best;
  }

  /** The middle of the season: the day by which half the year's records were in. */
  function medianDay(days) {
    if (!days.length) return null;
    const sorted = [...days].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
  }

  /**
   * When each cohort peaked, each year: the week with the most records after
   * smoothing, and the median date, which is the same question asked in a way
   * a single busy weekend cannot swing. Years newest first; a cohort with too
   * little in it that year gets null for both.
   */
  function peaks(rows, { edges = DEFAULT_BANDS, maxAccuracy = MAX_ACCURACY_M, minCount = MIN_PEAK_COUNT } = {}) {
    const list = bands(edges);
    const byYear = new Map();
    for (const r of rows || []) {
      const d = dayOfYear(r.on);
      if (!d || !placeable(r, maxAccuracy)) continue;
      const i = bandIndex(r.metres, edges);
      if (i < 0) continue;
      if (!byYear.has(d.year)) byYear.set(d.year, list.map(() => []));
      byYear.get(d.year)[i].push(d.day);
    }
    return [...byYear.keys()].sort((a, b) => b - a).map((year) => ({
      year,
      cohorts: byYear.get(year).map((days) => {
        const counts = new Array(WEEKS).fill(0);
        for (const day of days) counts[weekOf(day)]++;
        const week = peakWeek(counts, minCount);
        return { count: days.length, week, median: week == null ? null : medianDay(days) };
      }),
    }));
  }

  return {
    DEFAULT_BANDS, MAX_ACCURACY_M, WEEKS, MIN_PEAK_COUNT,
    bands, bandIndex, dayOfYear, weekOf, dayLabel, weekLabel, placeable, yearsOf,
    aggregate, smooth, peakWeek, medianDay, peaks,
  };
})();

if (typeof module !== 'undefined') module.exports = Trends;

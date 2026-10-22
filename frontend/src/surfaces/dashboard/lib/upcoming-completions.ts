import { PLAN_YEAR } from '@/lib/domain-constants';

import type { CompletingWithinYearRow } from '../api/types';
import { outcomeOf } from './outcome';
import { planWeekMonth } from './plan-month';

/**
 * Row SELECTION + GROUPING for the Executive "Upcoming completions" card (owner
 * ask 2026-10-23, replacing "Hubs at a glance"). Everything here reads served
 * fields of the already-fetched `GET /dashboard/completing-within-year` rows —
 * membership is the served outcome (`outcomeOf(row) === 'within_year'`, so On
 * Hold rows are excluded exactly as the KPI tiles exclude them), the week is the
 * served `last_step_end_week`, and the reference week is the served `GET /me`
 * `current_week`. Nothing decides a verdict, a schedule date or a share (I9/I19);
 * the only arithmetic is counting served rows into buckets.
 */

/** The look-ahead window, in weeks, counted from the served current week. */
export const UPCOMING_WINDOW_WEEKS = 8;

/** Rows shown on the card; the rest are reachable through the project register. */
export const UPCOMING_LIST_CAP = 6;

export const QUARTER_LABELS = [
  { key: 'Q1', months: 'Jan–Mar' },
  { key: 'Q2', months: 'Apr–Jun' },
  { key: 'Q3', months: 'Jul–Sep' },
  { key: 'Q4', months: 'Oct–Dec' },
] as const;

export interface WithinYearFinish {
  row: CompletingWithinYearRow;
  /** The served `last_step_end_week` (never null here). */
  week: number;
}

/** Within-year rows carrying a served finish week. */
export function withinYearFinishes(rows: readonly CompletingWithinYearRow[]): WithinYearFinish[] {
  const out: WithinYearFinish[] = [];
  for (const row of rows) {
    if (outcomeOf(row) !== 'within_year' || row.last_step_end_week === null) continue;
    out.push({ row, week: row.last_step_end_week });
  }
  return out;
}

/**
 * Within-year finishes whose served week falls in
 * `[currentWeek, currentWeek + UPCOMING_WINDOW_WEEKS)`, soonest first (ties by
 * name, then id, so the order is stable).
 */
export function selectUpcomingCompletions(
  rows: readonly CompletingWithinYearRow[],
  currentWeek: number,
): WithinYearFinish[] {
  const end = currentWeek + UPCOMING_WINDOW_WEEKS;
  return withinYearFinishes(rows)
    .filter((f) => f.week >= currentWeek && f.week < end)
    .sort(
      (a, b) =>
        a.week - b.week ||
        a.row.project_name.localeCompare(b.row.project_name) ||
        a.row.project_id.localeCompare(b.row.project_id),
    );
}

/** 0-based quarter (0 = Q1) of plan week `week`, via the ISO-Thursday month rule. */
export function planWeekQuarter(week: number, year: number = PLAN_YEAR): number {
  return Math.floor(planWeekMonth(week, year) / 3);
}

/**
 * Within-year rows WITHOUT a served finish week: the run has no remaining stage
 * for them (in the 2026 data, the already-Commercialized projects). Counted so
 * the card reconciles with the served `within_year_count`:
 * `noFinishWeekCount + Σ quarterCounts == within_year_count`.
 */
export function noFinishWeekCount(rows: readonly CompletingWithinYearRow[]): number {
  return rows.filter((row) => outcomeOf(row) === 'within_year' && row.last_step_end_week === null).length;
}

/** Within-year finishes counted per quarter of the plan year (Q1..Q4). */
export function quarterCounts(rows: readonly CompletingWithinYearRow[], year: number = PLAN_YEAR): number[] {
  const counts = [0, 0, 0, 0];
  for (const f of withinYearFinishes(rows)) {
    const q = planWeekQuarter(f.week, year);
    counts[q] = (counts[q] ?? 0) + 1;
  }
  return counts;
}

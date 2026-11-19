import { useSessionStore } from '@/stores/session';

/**
 * P53 (ADR 0063, R53-1 / R53-6): the browser mirror of the backend week-line
 * helpers (`backend/domain_constants.py`). Weeks are ABSOLUTE from
 * `week_base_year` W1 and are never re-based: 2027 W1 = 53, 2028 W1 = 105.
 *
 *   year_of(w)      = base + ⌊(w − 1) / 52⌋
 *   week_of_year(w) = (w − 1) mod 52 + 1
 *   year_start(Y)   = 52 × (Y − base) + 1
 *   year_end(Y)     = 52 × (Y − base + 1)
 *
 * The base year is SERVED (`/me.week_base_year`); the app holds no year
 * constant and no week position (I40). `PLAN_YEAR_WEEKS` is the structural
 * length of a plan year (ISO week 53 folds into 52), mirrored from the backend
 * `PLAN_YEAR_WEEKS`; it is never used as a cut-off or a search limit — those
 * are served per run (`within_year_week`, `horizon_weeks`). Pure label /
 * axis arithmetic; no schedule figure is derived here (I9). Tested against the
 * backend's shared week table (I57: 1, 52, 53, 104, 105, 364, 365).
 */
export const PLAN_YEAR_WEEKS = 52;

/** The served base year, or null before `/me` has resolved (isolated tests). */
export function servedBaseYear(): number | null {
  const me = useSessionStore.getState().me;
  return me?.week_base_year ?? null;
}

export function useBaseYear(): number | null {
  return useSessionStore((s) => s.me?.week_base_year ?? null);
}

/** Year offset of an absolute week from the base year (0 for weeks ≤ 52, and
 *  for 0 / negative weeks, which are shown as they are). */
export function yearIndexOf(week: number): number {
  if (week < 1) return 0;
  return Math.floor((Math.floor(week) - 1) / PLAN_YEAR_WEEKS);
}

/** `year_of(w)` for a served base year. */
export function yearOf(week: number, baseYear: number): number {
  return baseYear + yearIndexOf(week);
}

/** `week_of_year(w)`: 1..52. Weeks < 1 are returned unchanged. */
export function weekOfYearNumber(week: number): number {
  if (week < 1) return week;
  return ((Math.floor(week) - 1) % PLAN_YEAR_WEEKS) + 1;
}

/** `year_start(Y)`: the first absolute week of year `Y`. */
export function yearStart(year: number, baseYear: number): number {
  return PLAN_YEAR_WEEKS * (year - baseYear) + 1;
}

/** `year_end(Y)`: the last absolute week of year `Y`. */
export function yearEnd(year: number, baseYear: number): number {
  return PLAN_YEAR_WEEKS * (year - baseYear + 1);
}

/** The year end at or after an absolute week (`year_end(year_of(w))`): the
 *  Timeline axis rounds the served `last_finish_week` up to this. */
export function roundUpToYearEnd(week: number): number {
  const w = Math.max(1, Math.ceil(week));
  return (yearIndexOf(w) + 1) * PLAN_YEAR_WEEKS;
}

/** `abs_week(iso_year, iso_week)`; ISO week 53 folds into 52. `null` before the base year. */
export function absWeek(isoYear: number, isoWeek: number, baseYear: number): number | null {
  if (isoYear < baseYear) return null;
  return PLAN_YEAR_WEEKS * (isoYear - baseYear) + Math.min(isoWeek, PLAN_YEAR_WEEKS);
}

/** One band of a generated year header row: the years an axis `[first, last]` covers. */
export interface YearSpan {
  /** Year index from the base year (0 = base year). */
  yearIndex: number;
  startWeek: number;
  endWeek: number;
}

/** The year spans an absolute-week range covers, clipped to the range. Generated
 *  from the range (data-driven year row, R53-6); no year is hard-coded. */
export function yearSpans(firstWeek: number, lastWeek: number): YearSpan[] {
  const out: YearSpan[] = [];
  if (lastWeek < firstWeek) return out;
  for (let i = yearIndexOf(firstWeek); i <= yearIndexOf(lastWeek); i += 1) {
    const s = i * PLAN_YEAR_WEEKS + 1;
    const e = (i + 1) * PLAN_YEAR_WEEKS;
    out.push({ yearIndex: i, startWeek: Math.max(s, firstWeek), endWeek: Math.min(e, lastWeek) });
  }
  return out;
}

import type { WhatIfOutcome } from '../../api/whatif-types';
import type { Breakdown, BreakdownYear, ImportResultProject, ImportSimulateResponse } from './import-types';

/**
 * The Results "Year" filter (P32-R05, docs/API_CONTRACT_P32.md C1 / C2). One key selects the
 * served `breakdowns.by_year[key]` block on the Executive tab and filters the Gantt and
 * Projects ROWS by each project's served `finish_week` / `outcome`. Row filtering only:
 * nothing here counts projects; every count shown is a served field.
 */

export const YEAR_ALL = 'all';
export const YEAR_LATER = 'later';
export const YEAR_NOT_PLACED = 'not_placed';

const WEEKS_PER_YEAR = 52;
/** C1: "later" is a finish after the base year + 1 (week > 104). */
const LATER_AFTER_WEEK = 2 * WEEKS_PER_YEAR;

/** C1: `not_placed` = left_out + blocked + data_error. */
export const NOT_PLACED_OUTCOMES: ReadonlySet<WhatIfOutcome> = new Set(['left_out', 'blocked', 'data_error']);

export interface YearOption {
  key: string;
  /** Short segmented-control label ("All", "2026", "After 2027", "Not placed"). */
  short: string;
  /** The served label when served ("Finish in 2026"), else the same words. */
  label: string;
}

function shortLabel(key: string, baseYear: number): string {
  if (key === YEAR_ALL) return 'All';
  if (key === YEAR_LATER) return `After ${String(baseYear + 1)}`;
  if (key === YEAR_NOT_PLACED) return 'Not placed';
  return key;
}

/** The fallback key list when the server does not serve `breakdowns` (C1 order). */
function defaultYears(baseYear: number): BreakdownYear[] {
  return [
    { key: YEAR_ALL, label: 'All projects' },
    { key: String(baseYear), label: `Finish in ${String(baseYear)}` },
    { key: String(baseYear + 1), label: `Finish in ${String(baseYear + 1)}` },
    { key: YEAR_LATER, label: `Finish after ${String(baseYear + 1)}` },
    { key: YEAR_NOT_PLACED, label: 'Not placed' },
  ];
}

export function yearOptions(result: Pick<ImportSimulateResponse, 'base_year' | 'breakdowns'>): YearOption[] {
  const years = result.breakdowns?.years.length ? result.breakdowns.years : defaultYears(result.base_year);
  return years.map((y) => ({ key: y.key, short: shortLabel(y.key, result.base_year), label: y.label }));
}

/** Does the project belong to the year key? (served `finish_week` and `outcome` only) */
export function projectInYear(
  p: Pick<ImportResultProject, 'finish_week' | 'outcome'>,
  key: string,
  baseYear: number,
): boolean {
  if (key === YEAR_ALL) return true;
  if (key === YEAR_NOT_PLACED) return NOT_PLACED_OUTCOMES.has(p.outcome);
  if (p.finish_week === null || NOT_PLACED_OUTCOMES.has(p.outcome)) return false;
  if (key === YEAR_LATER) return p.finish_week > LATER_AFTER_WEEK;
  if (!/^\d{4}$/.test(key)) return false;
  const idx = Number(key) - baseYear;
  return p.finish_week > idx * WEEKS_PER_YEAR && p.finish_week <= (idx + 1) * WEEKS_PER_YEAR;
}

/** The served block for a key, or null (no breakdowns served, or an unknown key). */
export function breakdownFor(
  result: Pick<ImportSimulateResponse, 'breakdowns'>,
  key: string,
): Breakdown | null {
  return result.breakdowns?.by_year[key] ?? null;
}

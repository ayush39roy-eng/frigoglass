import { PLAN_YEAR } from '@/lib/domain-constants';

/**
 * Plan week -> calendar month, for the monthly "completed in" bars on the
 * Completion profile card (owner ask 2026-10-22).
 *
 * A plan week W is the ISO week W of `PLAN_YEAR` (ADR 0035: a date maps to its
 * ISO week while the ISO week-year is the plan year). An ISO week belongs to the
 * month holding its Thursday, the same rule ISO 8601 uses to give a week to a
 * year, so every week lands in exactly one month and the twelve monthly counts
 * sum to the weekly ones.
 */

export const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

/** 0-based month (0 = January) of plan week `week` in `year`. */
export function planWeekMonth(week: number, year: number = PLAN_YEAR): number {
  // 4 January is always in ISO week 1; step back to that week's Thursday.
  const jan4 = Date.UTC(year, 0, 4);
  const isoDow = (new Date(jan4).getUTCDay() + 6) % 7; // Monday = 0
  const week1Thursday = jan4 + (3 - isoDow) * 86_400_000;
  const thursday = new Date(week1Thursday + (week - 1) * 7 * 86_400_000);
  // A Thursday past 31 December (only possible for a week beyond the year's
  // last ISO week) is still shown in December: the axis is one plan year.
  return thursday.getUTCFullYear() > year ? 11 : thursday.getUTCFullYear() < year ? 0 : thursday.getUTCMonth();
}

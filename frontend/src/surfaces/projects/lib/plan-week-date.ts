import { DISPLAY_HORIZON_WEEKS, PLAN_YEAR, SCHEDULER_HORIZON_WEEKS } from '@/lib/domain-constants';

/**
 * P35-T02 (D35-3): the register's actual start / end are picked as dates and
 * stored as plan week numbers. The mapping is the one the seed already uses
 * for workbook dates (ADR 0035 §11, `backend/seed/extract_client_2026.py::
 * plan_week`), not a new calendar:
 *
 * - a date in ISO week-year 2026 → its ISO week (ISO week 53 → 52);
 * - a date in ISO week-year 2027 → 52 + its ISO week, while that is ≤ W78;
 * - anything else has no plan week (`null`): week numbers start at 2026 W1.
 *
 * Shown back as the Monday of that ISO week. Pure formatting / parsing of the
 * value the user types; no schedule figure is derived here (I9).
 */

const DAY_MS = 86_400_000;

function utcDate(year: number, month0: number, day: number): Date {
  return new Date(Date.UTC(year, month0, day));
}

/** ISO weekday 1 (Mon) … 7 (Sun). */
function isoWeekday(d: Date): number {
  const dow = d.getUTCDay();
  return dow === 0 ? 7 : dow;
}

/** `{year, week}` of the ISO week a UTC date falls in. */
export function isoWeekOf(d: Date): { year: number; week: number } {
  // The Thursday of this week decides the ISO week-year.
  const thursday = new Date(d.getTime() + (4 - isoWeekday(d)) * DAY_MS);
  const year = thursday.getUTCFullYear();
  const jan1 = utcDate(year, 0, 1);
  const week = Math.floor((thursday.getTime() - jan1.getTime()) / DAY_MS / 7) + 1;
  return { year, week };
}

/** The Monday of ISO week `week` of ISO week-year `year`. */
function isoWeekMonday(year: number, week: number): Date {
  const jan4 = utcDate(year, 0, 4);
  const week1Monday = jan4.getTime() - (isoWeekday(jan4) - 1) * DAY_MS;
  return new Date(week1Monday + (week - 1) * 7 * DAY_MS);
}

function toInputValue(d: Date): string {
  const y = String(d.getUTCFullYear()).padStart(4, '0');
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** `<input type="date">` value (`YYYY-MM-DD`) for a plan week, or `''` when
 *  the week has no date in the rule above (null, < 1 or past W78). */
export function planWeekToDateInput(week: number | null | undefined): string {
  if (week === null || week === undefined || !Number.isInteger(week) || week < 1) return '';
  if (week <= DISPLAY_HORIZON_WEEKS) return toInputValue(isoWeekMonday(PLAN_YEAR, week));
  if (week <= SCHEDULER_HORIZON_WEEKS) return toInputValue(isoWeekMonday(PLAN_YEAR + 1, week - DISPLAY_HORIZON_WEEKS));
  return '';
}

/**
 * The plan week of a `YYYY-MM-DD` value. `null` for an empty value (clears
 * the week); `undefined` when the date has no plan week (before 2026 W1 or
 * past W78) or does not parse — the cell then shows an error and stages
 * nothing.
 */
export function dateInputToPlanWeek(value: string): number | null | undefined {
  const t = value.trim();
  if (t === '') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (!m) return undefined;
  const d = utcDate(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime()) || toInputValue(d) !== t) return undefined;
  const { year, week } = isoWeekOf(d);
  if (year === PLAN_YEAR) return Math.min(week, DISPLAY_HORIZON_WEEKS);
  if (year === PLAN_YEAR + 1 && DISPLAY_HORIZON_WEEKS + week <= SCHEDULER_HORIZON_WEEKS) {
    return DISPLAY_HORIZON_WEEKS + week;
  }
  return undefined;
}

/** Bounds for the date picker: Monday of 2026 W1 … Sunday of W78. */
export const PLAN_DATE_MIN = planWeekToDateInput(1);
export const PLAN_DATE_MAX = toInputValue(
  new Date(isoWeekMonday(PLAN_YEAR + 1, SCHEDULER_HORIZON_WEEKS - DISPLAY_HORIZON_WEEKS).getTime() + 6 * DAY_MS),
);

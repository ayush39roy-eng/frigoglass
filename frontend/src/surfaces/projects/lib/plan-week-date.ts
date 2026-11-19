import { absWeek, weekOfYearNumber, yearOf } from '@/lib/week-line';

/**
 * P35-T02 (D35-3): the register's actual start / end are picked as dates and
 * stored as plan week numbers. The mapping is the one the seed already uses
 * for workbook dates (ADR 0035 §11, `backend/seed/extract_client_2026.py::
 * plan_week`), not a new calendar:
 *
 * P53 (ADR 0063, R53-1 / R53-6): generic for any year — weeks are absolute
 * from the served `/me.week_base_year` W1:
 *
 * - a date in ISO week-year Y ≥ base → `52 × (Y − base) + ISO week` (ISO week
 *   53 folds into 52), while that is ≤ `maxWeek` (the served search limit H);
 * - anything earlier than base W1, or past `maxWeek`, has no plan week.
 *
 * Week w is shown as the Monday of ISO week `week_of_year(w)` of `year_of(w)`.
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

/** `<input type="date">` value (`YYYY-MM-DD`) for an absolute plan week, or
 *  `''` when the week has no date (null, < 1, or past `maxWeek` when given). */
export function planWeekToDateInput(
  week: number | null | undefined,
  baseYear: number,
  maxWeek: number | null = null,
): string {
  if (week === null || week === undefined || !Number.isInteger(week) || week < 1) return '';
  if (maxWeek !== null && week > maxWeek) return '';
  return toInputValue(isoWeekMonday(yearOf(week, baseYear), weekOfYearNumber(week)));
}

/**
 * The absolute plan week of a `YYYY-MM-DD` value. `null` for an empty value
 * (clears the week); `undefined` when the date has no plan week (before base
 * W1 or past `maxWeek`) or does not parse — the cell then shows an error and
 * stages nothing.
 */
export function dateInputToPlanWeek(
  value: string,
  baseYear: number,
  maxWeek: number | null = null,
): number | null | undefined {
  const t = value.trim();
  if (t === '') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (!m) return undefined;
  const d = utcDate(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime()) || toInputValue(d) !== t) return undefined;
  const { year, week } = isoWeekOf(d);
  const abs = absWeek(year, week, baseYear);
  if (abs === null) return undefined;
  if (maxWeek !== null && abs > maxWeek) return undefined;
  return abs;
}

/** Bounds for the date picker: Monday of base W1 … Sunday of `maxWeek` (the
 *  last day of plan week `maxWeek`; a year-end week 52 runs to the Sunday
 *  before the next ISO W1, so it includes ISO W53). No max without `maxWeek`. */
export function planDateBounds(baseYear: number, maxWeek: number | null = null): { min: string; max: string } {
  const min = planWeekToDateInput(1, baseYear);
  if (maxWeek === null || maxWeek < 1) return { min, max: '' };
  const isYearEnd = weekOfYearNumber(maxWeek) === 52;
  const lastDay = isYearEnd
    ? new Date(isoWeekMonday(yearOf(maxWeek, baseYear) + 1, 1).getTime() - DAY_MS)
    : new Date(isoWeekMonday(yearOf(maxWeek, baseYear), weekOfYearNumber(maxWeek)).getTime() + 6 * DAY_MS);
  return { min, max: toInputValue(lastDay) };
}

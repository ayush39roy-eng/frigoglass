/**
 * Display formatters ONLY. No business math here.
 *
 * Per CLAUDE.md / Invariant I9: every number shown traces to a single API field and
 * the frontend never re-derives scheduling, scores, or currency conversion. Currency
 * conversion happens server-side — the Prioritization Matrix is re-fetched with a
 * `currency` param when the CurrencyToggle changes (see lib/query-keys.ts
 * `priorityMatrix`), and the API returns already-converted amounts. These helpers
 * just format what the API already computed.
 */

import { servedBaseYear, weekOfYearNumber, yearIndexOf, yearOf } from '@/lib/week-line';
import { useSessionStore } from '@/stores/session';
import type { CurrencyCode } from '@/types/enums';

const currencyFormatters = new Map<string, Intl.NumberFormat>();

export function formatCurrency(
  amount: number,
  currency: CurrencyCode,
  opts: { compact?: boolean } = {},
): string {
  const key = `${currency}:${opts.compact ? 'c' : 'f'}`;
  let fmt = currencyFormatters.get(key);
  if (!fmt) {
    fmt = new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency,
      notation: opts.compact ? 'compact' : 'standard',
      // Owner ask 2026-11-13: whole numbers everywhere, compact too.
      maximumFractionDigits: 0,
    });
    currencyFormatters.set(key, fmt);
  }
  return fmt.format(amount);
}

const percentFormatter = new Intl.NumberFormat('en-GB', {
  style: 'percent',
  maximumFractionDigits: 0,
});

/** `value` is a 0–100 percentage as returned by the API (e.g. `normalised_pct`). */
export function formatPercent(value: number): string {
  return percentFormatter.format(value / 100);
}

/** `value` is a 0–1 FRACTION as returned by the API (e.g. the Capacity surface's
 *  `completion_pct` = capacity / load, ADR 0008). Presentation only. */
export function formatFraction(value: number): string {
  return percentFormatter.format(value);
}

const integerFormatter = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });

export function formatInteger(value: number): string {
  return integerFormatter.format(value);
}

/**
 * Format an already-computed figure that the server serves with decimals (the
 * Capacity surface's FTE-scaled `design_capacity_weeks`, demand weeks, gaps,
 * served shares, scores). Presentation only — the value is taken verbatim from
 * the API, never derived here (CLAUDE.md / Invariants I6 / I7).
 *
 * Owner ask 2026-11-13: data is shown as whole numbers, rounded half away from
 * zero for display (265.07 → 265, 23.5 → 24). The served value is unchanged;
 * only its printed form is rounded. Quantities that are fractions by nature
 * (FTE, chamber efficiency, ratios) use `formatFactor` instead.
 */
export function formatDecimal(value: number): string {
  return integerFormatter.format(value);
}

const factorFormatter = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 });

/**
 * A quantity that is a fraction by nature — an engineer's FTE (0.5, 0.63), a
 * chamber's efficiency (0.85), a multiplier — printed to up to 2 dp. Rounding
 * these to a whole number would change their meaning (0.5 FTE is half speed,
 * DOMAIN_RULES "Booking rules"), so they are exempt from the whole-number rule.
 */
export function formatFactor(value: number): string {
  return factorFormatter.format(value);
}

/**
 * A served booked % (ADR 0016: load / capacity × 100, served to 2 dp, I19),
 * printed as a whole number (owner ask 2026-11-13). `null` (capacity 0)
 * prints as "—".
 */
export function formatBookedPct(value: number | null): string {
  return value === null ? '—' : `${integerFormatter.format(value)} %`;
}

/**
 * Owner rule 2026-11-18 (binding): no screen ever shows "week 53" or higher.
 * P53 (ADR 0063, R53-1/R53-6): weeks are ABSOLUTE from the served
 * `/me.week_base_year` W1, never re-based (2027 W1 = 53, 2028 W1 = 105, …),
 * for any year — no year is hard-coded. A week is SHOWN as the week of its own
 * year, always with the year: "W5 '26", "W5 '28" (P62-F1), with
 * "Week 5 of 2028" on hover ({@link formatWeekTitle}). Display only: the week
 * the server serves, and any week the client sends back, stays absolute.
 *
 * `planYear` is the year shown without a tag; it defaults to the served
 * `/me.plan_year`. Before `/me` has resolved (isolated tests only) the base
 * year falls back to `planYear`, and with neither the tag reads "(next year)".
 */
function servedPlanYear(): number | null {
  return useSessionStore.getState().me?.plan_year ?? null;
}

function baseYearFor(planYear: number | null): number | null {
  return servedBaseYear() ?? planYear;
}

/** The calendar year of an absolute week, or null when no base year is known. */
export function calendarYearOf(week: number, planYear: number | null = servedPlanYear()): number | null {
  const base = baseYearFor(planYear);
  return base === null ? null : yearOf(week, base);
}

/** An absolute week as `{ week: 1..52, yearOffset: 0 = plan year, 1 = next year, … }`
 *  (negative for a year before the plan year). Weeks < 1 are returned as they are. */
export function weekOfYear(week: number, planYear: number | null = servedPlanYear()): { week: number; yearOffset: number } {
  const base = baseYearFor(planYear);
  const offset = base !== null && planYear !== null ? yearOf(week, base) - planYear : yearIndexOf(week);
  return { week: weekOfYearNumber(week), yearOffset: week < 1 ? 0 : offset };
}

function shortYear(year: number): string {
  return `'${String(((year % 100) + 100) % 100).padStart(2, '0')}`;
}

/**
 * A served absolute week with its year always named: `W47 '26`, `W5 '28`.
 * Never prints W53+.
 *
 * P62-F1 (owner 2026-11-25, "which year week 40 we are talking about"): the
 * year is shown even inside the plan year — before P62 a plan-year week read
 * a bare `W47`. The year comes from the served week line (`week_base_year`,
 * falling back to the served `plan_year`), never the browser clock. Only
 * before `/me` resolves (isolated tests) does a plan-year week read `W47`.
 */
export function formatWeek(week: number, planYear: number | null = servedPlanYear()): string {
  const n = weekOfYearNumber(week);
  if (week < 1) return `W${String(n)}`;
  const year = calendarYearOf(week, planYear);
  if (year === null) {
    const idx = yearIndexOf(week);
    if (idx === 0) return `W${String(n)}`;
    return `W${String(n)} ${idx === 1 ? '(next year)' : `(+${String(idx)} years)`}`;
  }
  return `W${String(n)} ${shortYear(year)}`;
}

/** A week with its year always named ("W5 '28"), for places with no year row. */
export function formatWeekWithYear(week: number, planYear: number | null = servedPlanYear()): string {
  const year = calendarYearOf(week, planYear);
  const n = weekOfYearNumber(week);
  return year === null || week < 1 ? `W${String(n)}` : `W${String(n)} ${shortYear(year)}`;
}

/**
 * Hover / screen-reader text for an absolute week: "Week 47 of 2026",
 * "Week 5 of 2027". Before `/me` resolves: "Week 5 of next year".
 */
export function formatWeekTitle(week: number, planYear: number | null = servedPlanYear()): string {
  const n = weekOfYearNumber(week);
  const year = calendarYearOf(week, planYear);
  if (year !== null) return `Week ${String(n)} of ${String(year)}`;
  const idx = yearIndexOf(week);
  if (idx === 0) return `Week ${String(n)} of the plan year`;
  return `Week ${String(n)} of ${idx === 1 ? 'next year' : `the plan year +${String(idx)}`}`;
}

/** The hover title for a week only when it is outside the plan year (its year
 *  is not obvious from "W5"), else undefined. */
export function weekTitleIfNextYear(week: number | null | undefined, planYear: number | null = servedPlanYear()): string | undefined {
  if (week == null) return undefined;
  return weekOfYear(week, planYear).yearOffset !== 0 ? formatWeekTitle(week, planYear) : undefined;
}

/**
 * A served week number on the plan-year frame. Same output as {@link formatWeek}
 * (owner rule 2026-11-18 replaced the old "After W52" form): `W47`, `W5 '27`.
 * The spillover verdict stays the server's flag (I9/I16).
 */
export function formatPlanWeek(week: number, planYear: number | null = servedPlanYear()): string {
  return formatWeek(week, planYear);
}

/**
 * P32-R02: a served week with the spillover year named — `W47` inside the plan
 * year, `W5 '27` for absolute week 57 (plan year 2026). Formatting only.
 * P37: `planYear` is the served `/me.plan_year`. Kept as the explicit-year form
 * of {@link formatWeek}.
 */
export function formatYearWeek(week: number, planYear: number): string {
  return formatWeek(week, planYear);
}

/**
 * Absolute date + time display for an ISO timestamp (e.g.
 * `ScenarioApplyRunSummary.created_at`, `NotificationRead.created_at`).
 * Originally local to the Matrix Versions & History panel (P5-T03); promoted
 * here (P5-T09) so every surface that shows a raw timestamp formats it
 * identically rather than each growing its own copy. Returns the raw ISO
 * string unchanged if it fails to parse, rather than throwing or showing
 * "Invalid Date".
 */
export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

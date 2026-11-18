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

import { DISPLAY_HORIZON_WEEKS } from '@/lib/domain-constants';
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
 * Weeks are absolute — 1..52 = the plan year, 53..104 = the next year, and so
 * on — and a week past W52 is SHOWN as the week of its own year: absolute 53 →
 * "W1 '27", 57 → "W5 '27", with "Week 5 of 2027" on hover
 * ({@link formatWeekTitle}). Display only: the week the server serves, and any
 * week the client sends back, stays absolute.
 *
 * `planYear` is the served `/me.plan_year` (P37). It defaults to the session's
 * value so every call site gets the year without plumbing; before `/me` has
 * resolved (isolated tests only) the tag reads "(next year)".
 */
function servedPlanYear(): number | null {
  return useSessionStore.getState().me?.plan_year ?? null;
}

/** An absolute week as `{ week: 1..52, yearOffset: 0 = plan year, 1 = next year, … }`.
 *  Weeks ≤ 52 (including 0 / negatives) are returned as they are, offset 0. */
export function weekOfYear(week: number): { week: number; yearOffset: number } {
  if (week <= DISPLAY_HORIZON_WEEKS) return { week, yearOffset: 0 };
  const zero = Math.floor(week) - 1;
  return { week: (zero % DISPLAY_HORIZON_WEEKS) + 1, yearOffset: Math.floor(zero / DISPLAY_HORIZON_WEEKS) };
}

function yearTag(yearOffset: number, planYear: number | null): string {
  if (planYear === null) return yearOffset === 1 ? '(next year)' : `(+${String(yearOffset)} years)`;
  return `'${String((planYear + yearOffset) % 100).padStart(2, '0')}`;
}

/**
 * A served absolute week: `W47` inside the plan year, `W5 '27` for absolute
 * week 57 (plan year 2026). Never prints W53+.
 */
export function formatWeek(week: number, planYear: number | null = servedPlanYear()): string {
  const yw = weekOfYear(week);
  if (yw.yearOffset === 0) return `W${String(yw.week)}`;
  return `W${String(yw.week)} ${yearTag(yw.yearOffset, planYear)}`;
}

/**
 * Hover / screen-reader text for an absolute week: "Week 47 of 2026",
 * "Week 5 of 2027". Before `/me` resolves: "Week 5 of next year".
 */
export function formatWeekTitle(week: number, planYear: number | null = servedPlanYear()): string {
  const yw = weekOfYear(week);
  if (planYear !== null) return `Week ${String(yw.week)} of ${String(planYear + yw.yearOffset)}`;
  if (yw.yearOffset === 0) return `Week ${String(yw.week)} of the plan year`;
  return `Week ${String(yw.week)} of ${yw.yearOffset === 1 ? 'next year' : `the plan year +${String(yw.yearOffset)}`}`;
}

/** The hover title for a week only when it is past W52 (its year is not obvious), else undefined. */
export function weekTitleIfNextYear(week: number | null | undefined, planYear: number | null = servedPlanYear()): string | undefined {
  return week != null && week > DISPLAY_HORIZON_WEEKS ? formatWeekTitle(week, planYear) : undefined;
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

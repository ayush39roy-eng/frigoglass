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

import { DISPLAY_HORIZON_WEEKS, SPILLOVER_YEAR } from '@/lib/domain-constants';
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

/** Horizon weeks are 1-indexed absolute week numbers (DOMAIN_RULES.md horizon constants). */
export function formatWeek(week: number): string {
  return `W${week}`;
}

/**
 * A served week number framed on the 52-week plan year the UI presents
 * (`DISPLAY_HORIZON_WEEKS`, client ask 2026-10-13). Weeks inside the year print
 * as `W47`; a week past W52 (spillover) prints as "After W52" instead of
 * W53–W78, which the UI never shows. Formatting only — the week itself is the
 * server's field, and the spillover verdict stays the server's flag (I9/I16).
 */
export function formatPlanWeek(week: number): string {
  return week > DISPLAY_HORIZON_WEEKS ? `After ${formatWeek(DISPLAY_HORIZON_WEEKS)}` : formatWeek(week);
}

/**
 * P32-R02: a served week with the spillover year named — `W47` inside the plan
 * year, `W5 '27` for absolute week 57. Used by the Workflow page's per-project
 * waterfall axis and labels. Formatting only.
 */
export function formatYearWeek(week: number): string {
  if (week <= DISPLAY_HORIZON_WEEKS) return formatWeek(week);
  return `W${String(week - DISPLAY_HORIZON_WEEKS)} '${String(SPILLOVER_YEAR % 100).padStart(2, '0')}`;
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

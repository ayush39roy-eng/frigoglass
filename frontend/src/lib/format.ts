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
      maximumFractionDigits: opts.compact ? 1 : 0,
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

const integerFormatter = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });

export function formatInteger(value: number): string {
  return integerFormatter.format(value);
}

const decimalFormatter = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 });

/**
 * Format an already-computed fractional figure for display (e.g. the Capacity
 * surface's FTE-scaled `design_capacity_weeks` / efficiency-scaled
 * `lab_capacity_units`, and the `lab_load_units` = Σ lab-weeks × 0.5 figure).
 * Presentation only — the value is taken verbatim from the API, never derived
 * here (CLAUDE.md / Invariants I6 / I7).
 */
export function formatDecimal(value: number): string {
  return decimalFormatter.format(value);
}

/** Horizon weeks are 1-indexed absolute week numbers (DOMAIN_RULES.md horizon constants). */
export function formatWeek(week: number): string {
  return `W${week}`;
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

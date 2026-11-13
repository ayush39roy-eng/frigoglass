/**
 * P19-T04 display helpers for Capacity Planning. They PICK a served field for
 * the page's basis (YTD = `remaining`, Full year = `year`) and unit (weeks or
 * days) and format it. They never compute a figure (I9/I19): a missing field
 * (an API older than P19-T03) prints "—".
 */
import type { BasisPair, CapacityBasis } from '../api/types';

export type CapacityUnit = 'weeks' | 'days';

export const BASIS_LABEL: Record<CapacityBasis, string> = {
  remaining: 'YTD 2026',
  year: '2026 full year',
};

export const MISSING = '—';

/** The served value of `pair` for `basis`, or `null` when not served. */
export function pick(pair: BasisPair | null | undefined, basis: CapacityBasis): number | null {
  if (!pair || typeof pair !== 'object') return null;
  const v = pair[basis];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** The weeks or days pair for `unit`. */
export function pickUnit<T extends { capacity_weeks?: BasisPair | undefined; capacity_days?: BasisPair | undefined }>(
  row: T | null | undefined,
  unit: CapacityUnit,
  basis: CapacityBasis,
): number | null {
  if (!row) return null;
  return pick(unit === 'weeks' ? row.capacity_weeks : row.capacity_days, basis);
}

// Owner ask 2026-11-13: whole numbers everywhere (display rounding only).
const weeksFmt = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });
const daysFmt = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });
// Served percentages are 2 dp; printed as whole numbers (owner ask 2026-11-13).
const pctFmt = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 0 });
const plainFmt = new Intl.NumberFormat('en-GB', { maximumFractionDigits: 2 });

/** Weeks and days as whole numbers (display rounding only). */
export function formatAmount(value: number | null | undefined, unit: CapacityUnit): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return MISSING;
  return unit === 'weeks' ? weeksFmt.format(value) : daysFmt.format(value);
}

export function unitShort(unit: CapacityUnit): string {
  return unit === 'weeks' ? 'wks' : 'days';
}

/** A served 0-100 percentage, printed whole, e.g. "22%". */
export function formatPct(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return MISSING;
  return `${pctFmt.format(value)}%`;
}

/** A fraction-by-nature figure (FTE, efficiency, platforms): up to 2 dp,
 *  exempt from the whole-number rule because rounding would change its meaning. */
export function formatPlain(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return MISSING;
  return plainFmt.format(value);
}

import { PROJECT_PRIORITIES, type ProjectPriority } from '@/types/enums';

/**
 * P57 (ADR 0067, DOMAIN_RULES "Priority not applicable"): a project whose status
 * is Commercialized or Cancelled has NO effective priority. It shows "Not
 * applicable" wherever a priority pill, cell or select appears, and never
 * counts, groups or filters under P1 / P2 / P3 / P4 / Q.
 *
 * This is a read-time display rule, not a calculation: the stored priority is
 * kept server-side (and applies again if the status returns to a schedulable
 * one). Every by-priority COUNT is served already excluding these projects
 * (P57-T02); this helper only keeps client-side display, grouping and
 * filtering of served rows consistent with that.
 *
 * When the API serves `priority_applicable` on a row, that served value wins;
 * otherwise it is read from the served `status`.
 */

export const PRIORITY_NOT_APPLICABLE_STATUSES = ['Commercialized', 'Cancelled'] as const;
export type PriorityNotApplicableStatus = (typeof PRIORITY_NOT_APPLICABLE_STATUSES)[number];

export const NOT_APPLICABLE_LABEL = 'Not applicable';
/** Tight cells and compact captions (ADR 0067: short "N/A"). */
export const NOT_APPLICABLE_SHORT_LABEL = 'N/A';
export const NOT_APPLICABLE_TOOLTIP = 'Priority does not apply to Commercialized or Cancelled projects';

/** The priority filter value for "Not applicable" — the served `priority=not_applicable`
 *  query value (P57-T02) and the key client-side filters use. */
export const NOT_APPLICABLE_FILTER_VALUE = 'not_applicable' as const;

/** A priority filter selection: a band, or "Not applicable". */
export type PriorityFilterValue = ProjectPriority | typeof NOT_APPLICABLE_FILTER_VALUE;
export const PRIORITY_FILTER_VALUES: readonly PriorityFilterValue[] = [...PROJECT_PRIORITIES, NOT_APPLICABLE_FILTER_VALUE];

/** True when the status takes no priority (Commercialized / Cancelled). A served
 *  `priority_applicable` boolean, when present, decides instead. */
export function isPriorityNotApplicable(
  status: string | null | undefined,
  servedApplicable?: boolean | null,
): boolean {
  if (servedApplicable === true) return false;
  if (servedApplicable === false) return true;
  return status != null && (PRIORITY_NOT_APPLICABLE_STATUSES as readonly string[]).includes(status);
}

/** The effective priority: null for Commercialized / Cancelled, else the served one. */
export function effectivePriority<P extends string>(
  status: string | null | undefined,
  priority: P | null | undefined,
  servedApplicable?: boolean | null,
): P | null {
  if (isPriorityNotApplicable(status, servedApplicable)) return null;
  return priority ?? null;
}

/** Any served row that may carry a status, a priority and (P57-T02) `priority_applicable`. */
export interface PriorityApplicabilityRow<P extends string = string> {
  status?: string | null | undefined;
  priority?: P | null | undefined;
  priority_applicable?: boolean | null | undefined;
}

/** `isPriorityNotApplicable` for a served row. */
export function rowPriorityNotApplicable(row: PriorityApplicabilityRow<string>): boolean {
  return isPriorityNotApplicable(row.status, row.priority_applicable);
}

/** `effectivePriority` for a served row. */
export function rowEffectivePriority<P extends string>(row: PriorityApplicabilityRow<P>): P | null {
  return effectivePriority(row.status, row.priority, row.priority_applicable);
}

/**
 * The key a client-side priority filter / grouping uses: the effective priority,
 * `NOT_APPLICABLE_FILTER_VALUE` for a Commercialized / Cancelled project, or
 * null when no priority is set. A P4 filter therefore never matches a
 * Commercialized P4.
 */
export function priorityFilterKey<P extends string>(
  status: string | null | undefined,
  priority: P | null | undefined,
  servedApplicable?: boolean | null,
): P | typeof NOT_APPLICABLE_FILTER_VALUE | null {
  if (isPriorityNotApplicable(status, servedApplicable)) return NOT_APPLICABLE_FILTER_VALUE;
  return priority ?? null;
}

/**
 * The priority as plain text for lists, search haystacks and string-keyed
 * client-side filters: "Not applicable" for Commercialized / Cancelled, else
 * the served priority (or `empty`).
 */
export function priorityDisplayText(
  status: string | null | undefined,
  priority: string | null | undefined,
  empty = '',
  servedApplicable?: boolean | null,
): string {
  if (isPriorityNotApplicable(status, servedApplicable)) return NOT_APPLICABLE_LABEL;
  return priority ?? empty;
}

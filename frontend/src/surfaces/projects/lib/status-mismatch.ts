import type { ProjectStatus } from '@/types/enums';

import type { ProjectFilterRow } from '@/surfaces/dashboard/api/types';

/**
 * P35-T08b (OQ #84 assumption): the status-vs-current-step warning. Display
 * only — never a scheduler input, never written back.
 *
 * The browser does NOT hold the step → status rule: the backend serves
 * `expected_status` and `status_mismatch` (`services/expected_status.py`).
 * For the served status the served flag is used as is. For a status edited in
 * Edit mode the warning is the edited status compared with the served
 * `expected_status` — a comparison against a served value, not a re-derivation.
 */

/** Statuses that never carry the warning (they are not tied to a step). */
export const STATUS_MISMATCH_EXEMPT: readonly ProjectStatus[] = ['On Hold', 'Cancelled', 'In Buyoff', 'Draft'];

/**
 * The expected status to warn about for `row` shown with `status` (the served
 * status, or the Edit-mode draft), or null when there is no warning.
 */
export function statusMismatchExpected(
  row: Pick<ProjectFilterRow, 'status' | 'expected_status' | 'status_mismatch'>,
  status: ProjectStatus,
): ProjectStatus | null {
  // `?? null` / `=== true`: tolerate a pre-P35-T08b API that omits the fields.
  const expected = row.expected_status ?? null;
  if (expected === null) return null;
  if (status === row.status) return row.status_mismatch === true ? expected : null;
  if (STATUS_MISMATCH_EXEMPT.includes(status)) return null;
  return status !== expected ? expected : null;
}

export function statusMismatchText(expected: ProjectStatus): string {
  return `Status differs from the current step (expected: ${expected})`;
}

/**
 * P53 (ADR 0063, R53-2 / R53-9): served LEFT_OUT reasons and the tail-warning
 * copy. The reason is the server's (`left_out_reason`, derived from the stored
 * row); the browser only words it. `beyond_horizon` = no placement within the
 * run's search limit (N years, the Admin setting).
 */
export type LeftOutReason = 'no_leader' | 'no_chamber' | 'data_error' | 'beyond_horizon';

export const LEFT_OUT_REASONS: readonly LeftOutReason[] = ['no_leader', 'no_chamber', 'data_error', 'beyond_horizon'];

/** "Cannot be scheduled within {N} years — check resources" (R53-2 copy). */
export function beyondHorizonText(horizonYears: number | null | undefined): string {
  if (horizonYears == null) return 'Cannot be scheduled within the search limit — check resources';
  return `Cannot be scheduled within ${String(horizonYears)} ${horizonYears === 1 ? 'year' : 'years'} — check resources`;
}

export function leftOutReasonText(reason: LeftOutReason | null | undefined, horizonYears: number | null | undefined): string {
  switch (reason) {
    case 'no_leader':
      return 'No leader assigned';
    case 'no_chamber':
      return 'No lab chamber can run a lab step';
    case 'data_error':
      return 'Data error — check the project setup';
    case 'beyond_horizon':
      return beyondHorizonText(horizonYears);
    default:
      return 'Not placed';
  }
}

/** Short reason label for a reason-split line ("No leader: 1"). */
export const LEFT_OUT_REASON_SHORT: Record<LeftOutReason, string> = {
  no_leader: 'No leader',
  no_chamber: 'No chamber',
  data_error: 'Data error',
  beyond_horizon: 'Beyond the search limit',
};

/** R53-9: "Finishes {year} — check leader load". */
export function farFinishText(year: number | null | undefined): string {
  return year == null ? 'Finishes late — check leader load' : `Finishes ${String(year)} — check leader load`;
}

/** Text for the two completion lines (P9). The slip SIGN comes from the API's
 *  `slip_weeks`; nothing here subtracts week numbers. */
export const GANTT_MARKER_TEST_IDS = {
  expected: 'gantt-marker-expected',
  projected: 'gantt-marker-projected',
  slip: 'gantt-slip-bracket',
} as const;

export function expectedLabel(targetEndWeek: number | null): string {
  return targetEndWeek === null ? 'Expected (process-derived)' : 'Expected (target)';
}

export function slipLabel(slipWeeks: number): string {
  if (slipWeeks > 0) return `+${String(slipWeeks)} wk`;
  if (slipWeeks < 0) return `−${String(Math.abs(slipWeeks))} wk`;
  return '0 wk';
}

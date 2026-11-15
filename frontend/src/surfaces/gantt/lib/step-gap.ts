/**
 * P33-T15 (ADR 0048 §1, contract Part G / I): the read-only gap chip on a
 * Timeline step row. The text is the served signed `gap_weeks` (the project's
 * copy of the category template gap), rendered verbatim — the sign only picks
 * the word. Nothing here schedules: where the step really starts is the active
 * run's planned weeks.
 */

/** "parallel 3 wk" (negative), "wait 2 wk" (positive), `null` for 0. */
export function gapChipText(gapWeeks: number): string | null {
  if (gapWeeks < 0) return `parallel ${String(-gapWeeks)} wk`;
  if (gapWeeks > 0) return `wait ${String(gapWeeks)} wk`;
  return null;
}

/** The chip's hover / accessible text. */
export function gapChipTitle(gapWeeks: number): string {
  return gapWeeks < 0
    ? `Runs in parallel with the work it waits for (${String(-gapWeeks)} wk overlap), from the category template`
    : `Waits ${String(gapWeeks)} wk after the work it waits for, from the category template`;
}

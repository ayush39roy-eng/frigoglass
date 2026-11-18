import * as React from 'react';
import { CalendarRange } from 'lucide-react';

import type { ImportSimulateResponse } from '../import-types';

/**
 * P50 (ADR 0061 R49-12 / R49-18): the result's plan window, in the server's words.
 * "File projects start from W1 2027 (4 Jan 2027)" when f ≠ the simulated week, and the
 * served `plan_window_label` when the request set a "Plan until". Nothing is shown for the
 * default window (the plan-year wording is unchanged).
 */
export function PlanWindowNotice({
  result,
}: {
  result: Pick<ImportSimulateResponse, 'current_week' | 'plan_from_week' | 'plan_from_label' | 'plan_window_label'>;
}): React.JSX.Element | null {
  const later =
    result.plan_from_week != null && result.plan_from_week !== result.current_week && result.plan_from_label
      ? result.plan_from_label
      : null;
  const windowLabel = result.plan_window_label ?? null;
  if (later === null && windowLabel === null) return null;
  return (
    <p
      className="flex flex-wrap items-center gap-x-s2 gap-y-0.5 text-2xs text-text-muted"
      role="note"
      data-testid="import-plan-window-notice"
    >
      <CalendarRange className="size-3.5 shrink-0" aria-hidden="true" />
      {later !== null ? (
        <span data-testid="import-plan-from-line">
          File projects start from <span className="font-medium text-text">{later}</span>; live plan projects are
          unchanged.
        </span>
      ) : null}
      {windowLabel !== null ? (
        <span data-testid="import-plan-window-line">
          Plan window <span className="font-medium text-text">{windowLabel}</span>: “within” counts projects finishing in it.
        </span>
      ) : null}
    </p>
  );
}

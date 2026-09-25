import * as React from 'react';
import { Clock, Snowflake } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { ScheduleOutcomeBadge } from '@/components/shared/schedule-outcome-badge';

import type { GanttProjectRow, GanttStepRow } from '../api/types';

/**
 * The outcome / conflict chips for the fixed badge column to the right of the bar
 * area (`dataviz-gantt` SKILL — stacked vertically so they never overlap the bar
 * or each other at narrow zoom).
 *
 * Every chip is a server flag rendered verbatim:
 * - `LEFT_OUT` / `SPILLOVER` / `CAT_NOT_ALLOWED` ← `row.left_out` / `row.spillover`
 *   / `row.cat_not_allowed` (the active run's outcome snapshot).
 * - `ENG_CONFLICT` / `OVERLAP` ← `step.eng_conflict` / `step.chamber_overlap`
 *   (the active run's step snapshot).
 * The `frozen` pill and the `+Nw` delay pill read `row.frozen` / `row.delay_weeks`.
 */

export function ProjectRowBadges({ project }: { project: GanttProjectRow }): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center justify-end gap-1">
      {project.frozen ? (
        <Badge tone="primary" title="Frozen — dates locked, excluded from rescheduling">
          <Snowflake className="size-3" aria-hidden="true" />
          Frozen
        </Badge>
      ) : null}
      {project.delay_weeks > 0 ? (
        <Badge
          tone="danger"
          title={`Delay applied: ${String(project.delay_weeks)} week(s)`}
          data-numeric=""
        >
          <Clock className="size-3" aria-hidden="true" />+{project.delay_weeks}w
        </Badge>
      ) : null}
      {project.left_out ? <ScheduleOutcomeBadge flag="LEFT_OUT" /> : null}
      {project.spillover ? <ScheduleOutcomeBadge flag="SPILLOVER" /> : null}
      {project.cat_not_allowed ? <ScheduleOutcomeBadge flag="CAT_NOT_ALLOWED" iconOnly /> : null}
    </div>
  );
}

export function StepRowBadges({ step }: { step: GanttStepRow }): React.JSX.Element | null {
  if (!step.eng_conflict && !step.chamber_overlap) return null;
  return (
    <div className="flex flex-wrap items-center justify-end gap-1">
      {step.eng_conflict ? <ScheduleOutcomeBadge flag="ENG_CONFLICT" iconOnly /> : null}
      {step.chamber_overlap ? <ScheduleOutcomeBadge flag="OVERLAP" iconOnly /> : null}
    </div>
  );
}

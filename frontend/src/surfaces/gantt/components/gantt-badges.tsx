import * as React from 'react';
import { Clock, History, OctagonAlert, Snowflake } from 'lucide-react';

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
 * - `Blocked` ← `row.blocked` (a stage is Blocked, ADR 0006); `Stale` ←
 *   `row.schedule_stale` (progress or settings changed since this run, P9).
 * - `n/a` on a step row ← `step.skipped` (ADR 0007).
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
      {project.blocked ? (
        <Badge tone="danger" title="A stage is blocked — the project is held at its earliest feasible frontier until the block clears">
          <OctagonAlert className="size-3" aria-hidden="true" />
          Blocked
        </Badge>
      ) : null}
      {project.schedule_stale ? (
        <Badge
          tone="outline"
          className="border-dashed text-text-muted"
          title="Progress or settings changed since this run"
          data-testid="stale-chip"
        >
          <History className="size-3" aria-hidden="true" />
          Stale
        </Badge>
      ) : null}
    </div>
  );
}

export function StepRowBadges({ step }: { step: GanttStepRow }): React.JSX.Element | null {
  if (step.skipped) {
    return (
      <div className="flex flex-wrap items-center justify-end gap-1">
        <Badge
          tone="outline"
          className="border-dashed text-text-subtle"
          title="Not applicable — this step has no lead time for the project's category (or is a lab step on a project without certification testing) and occupies no weeks"
          data-testid="skipped-chip"
        >
          n/a
        </Badge>
      </div>
    );
  }
  if (!step.eng_conflict && !step.chamber_overlap && step.status !== 'Blocked') return null;
  return (
    <div className="flex flex-wrap items-center justify-end gap-1">
      {step.status === 'Blocked' ? (
        <Badge tone="danger" title="Stage is blocked">
          <OctagonAlert className="size-3" aria-hidden="true" />
          Blocked
        </Badge>
      ) : null}
      {step.eng_conflict ? <ScheduleOutcomeBadge flag="ENG_CONFLICT" iconOnly /> : null}
      {step.chamber_overlap ? <ScheduleOutcomeBadge flag="OVERLAP" iconOnly /> : null}
    </div>
  );
}

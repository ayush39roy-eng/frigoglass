import * as React from 'react';
import { Clock, History, OctagonAlert, Pin, Snowflake, TimerReset, Waypoints } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { BandOutcomeChip } from '@/components/shared/project-outcome-chips';
import { ScheduleOutcomeBadge } from '@/components/shared/schedule-outcome-badge';
import { nonCountingOutcome } from '@/components/shared/schedule-outcome-meta';

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
 * - "On Hold" ← `row.blocked` (a stage is Blocked, ADR 0006; shown as On Hold,
 *   ADR 0017); `Stale` ←
 *   `row.schedule_stale` (progress or settings changed since this run, P9).
 * - `n/a` on a step row ← `step.skipped` (ADR 0007).
 * - P42 (ADR 0056): "Queued — …" / "Not scheduled (P4)" ← the served
 *   `row.outcome` + `row.outcome_label`, shown verbatim (replaces the left-out chip).
 * - P40-T03c (ADR 0054): "Pinned" ← `step.pinned` (the run placed the step on
 *   its typed weeks); "Manual overlap" ← `step.manual_overlap` /
 *   `row.manual_overlap` (R40-7, a warning only); "Pin lapsed" ←
 *   `row.pin_lapsed` (R40-5).
 */

const MANUAL_OVERLAP_TITLE =
  'Manual overlap: typed weeks start before the work this step waits for is released. A warning only; the plan keeps the typed weeks.';
const PIN_LAPSED_TITLE =
  "Pin lapsed: a typed start week had already passed, so the step was placed from the run's week, keeping its length.";

function ManualOverlapBadge({ iconOnly = false }: { iconOnly?: boolean }): React.JSX.Element {
  return (
    <Badge tone="warning" title={MANUAL_OVERLAP_TITLE} data-testid="manual-overlap-chip">
      <Waypoints aria-hidden="true" />
      {iconOnly ? <span className="sr-only">Manual overlap</span> : 'Manual overlap'}
    </Badge>
  );
}

export function ProjectRowBadges({ project }: { project: GanttProjectRow }): React.JSX.Element {
  // P42 (ADR 0056): the served bucket; a queued / not-scheduled project shows
  // the served `outcome_label` instead of the left-out chip (not counted this year).
  const band = nonCountingOutcome(project.outcome);
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
      {band ? <BandOutcomeChip outcome={band} label={project.outcome_label} projectedEndWeek={project.projected_end_week} /> : null}
      {project.left_out && !band ? <ScheduleOutcomeBadge flag="LEFT_OUT" /> : null}
      {project.spillover ? <ScheduleOutcomeBadge flag="SPILLOVER" /> : null}
      {project.cat_not_allowed ? <ScheduleOutcomeBadge flag="CAT_NOT_ALLOWED" iconOnly /> : null}
      {project.blocked ? (
        <Badge tone="danger" title="A stage is on hold — the project stays in the plan, held at its earliest feasible frontier until the hold is lifted">
          <OctagonAlert className="size-3" aria-hidden="true" />
          On Hold
        </Badge>
      ) : null}
      {project.manual_overlap ? <ManualOverlapBadge /> : null}
      {project.pin_lapsed ? (
        <Badge tone="warning" title={PIN_LAPSED_TITLE} data-testid="pin-lapsed-chip">
          <TimerReset aria-hidden="true" />
          Pin lapsed
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
  if (!step.eng_conflict && !step.chamber_overlap && step.status !== 'Blocked' && !step.pinned && !step.manual_overlap) {
    return null;
  }
  return (
    <div className="flex flex-wrap items-center justify-end gap-1">
      {step.pinned ? (
        <Badge
          tone="primary"
          title="Pinned: the active run placed this step on its typed Start / End weeks"
          data-testid="pinned-chip"
        >
          <Pin aria-hidden="true" />
          Pinned
        </Badge>
      ) : null}
      {step.manual_overlap ? <ManualOverlapBadge iconOnly /> : null}
      {step.status === 'Blocked' ? (
        <Badge tone="danger" title="Stage is on hold">
          <OctagonAlert className="size-3" aria-hidden="true" />
          On Hold
        </Badge>
      ) : null}
      {step.eng_conflict ? <ScheduleOutcomeBadge flag="ENG_CONFLICT" iconOnly /> : null}
      {step.chamber_overlap ? <ScheduleOutcomeBadge flag="OVERLAP" iconOnly /> : null}
    </div>
  );
}

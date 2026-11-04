import * as React from 'react';
import { PencilLine, SlidersHorizontal, TriangleAlert } from 'lucide-react';

import { cn } from '@/lib/utils';
import { formatPlanWeek } from '@/lib/format';
import { StepKindBadge } from '@/components/shared/step-kind-badge';

import { stepStatusLabels } from '../lib/gantt-status-labels';
import { editBaselineText, isEffortZeroed } from '../lib/step-duration-source';
import type { GanttProjectRow, GanttStepRow } from '../api/types';
import { hasTimingEdit, stepTimingTarget, useStepTimingHost } from './step-timing/step-timing-context';

/**
 * A Timeline step row's left cell (moved out of `gantt-chart.tsx` in P32-R02).
 * Every value is a served field.
 */

export function StepLeftCell({
  project,
  step,
  compact = false,
  narrow = false,
  timingEdits = false,
}: {
  project: GanttProjectRow;
  step: GanttStepRow;
  compact?: boolean;
  /** P19-R02: phone layout — no status column, so flags show as a compact icon. */
  narrow?: boolean;
  /**
   * Offer the keyboard "Edit timing" button (with a step-timing host mounted
   * and the served `timing_editable` allowing it). The Execution Timeline
   * passes `true`.
   */
  timingEdits?: boolean;
}): React.JSX.Element {
  const { step_name: name, kind, skipped, sequence_order: sequenceOrder } = step;
  // An elapsed step books nobody (ADR 0007) — there is no resource to name.
  const resource =
    kind === 'lab' ? step.assigned_chamber_code : kind === 'design' ? step.assigned_engineer_name : null;
  const host = useStepTimingHost();
  const editable = timingEdits && host !== null && step.timing_editable !== 'none' && !skipped;
  // P30 (ADR 0041 R4): only the user's two fields are a "timing edit"; an
  // effort value is the client's figure, named in the hint but never "edited".
  const edited = hasTimingEdit(step);
  const overlap = step.overlap_weeks ?? null;
  const editedTitle = edited
    ? [
        step.duration_override_weeks !== null
          ? `${kind === 'design' ? 'work' : 'duration'} ${String(step.duration_override_weeks)} wks (${editBaselineText(step)})`
          : null,
        step.start_not_before_week !== null ? `earliest start ${formatPlanWeek(step.start_not_before_week)}` : null,
        overlap !== null ? `parallel with the previous step, ${String(overlap)} wk overlap` : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : '';
  const flags = narrow && !skipped ? stepStatusLabels(step) : [];
  // QA-P19-1: a skipped row is NOT dimmed with opacity (that dimmed the kind
  // badge below AA). Only the name is muted — a full-strength token that still
  // clears AA — with a strikethrough and a "skipped" word; the badge stays at
  // full contrast.
  return (
    <div className={cn('flex min-w-0 flex-1 items-center', narrow ? 'gap-1 pl-1' : 'gap-1.5 pl-4')} data-skipped={skipped || undefined}>
      <StepKindBadge kind={kind} compact />
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            'block truncate text-2xs',
            skipped ? 'text-text-muted line-through decoration-text-subtle' : 'text-text',
          )}
          title={
            skipped
              ? isEffortZeroed(step)
                ? `${name} — skipped: its share of the project's client effort figure is 0 weeks`
                : `${name} — not applicable for this project (skipped)`
              : name
          }
          data-testid="gantt-step-name"
        >
          {sequenceOrder}. {name}
          {skipped ? <span className="sr-only"> (skipped)</span> : null}
        </span>
        {skipped && narrow ? (
          <span
            className="block whitespace-nowrap text-[0.625rem] leading-3 text-text-muted"
            title="Skipped — not applicable for this project"
            data-testid="gantt-step-skipped"
          >
            n/a
          </span>
        ) : null}
        {resource && !compact && !(skipped && narrow) ? (
          <span className="block truncate text-[0.625rem] text-text-muted" title={resource}>
            {resource}
          </span>
        ) : null}
      </span>
      {flags.length > 0 ? (
        <span
          role="img"
          className="inline-flex shrink-0 text-danger"
          aria-label={`Status: ${flags.join(', ')}`}
          title={flags.join(', ')}
          data-testid="gantt-step-flag"
        >
          <TriangleAlert className="size-3" aria-hidden="true" />
        </span>
      ) : null}
      {/* P32-R02: a stored overlap, readable at a glance (served value). */}
      {overlap !== null && !narrow && !skipped ? (
        <span
          className="inline-flex shrink-0 items-center rounded-sm border border-primary/40 px-1 text-[0.625rem] font-semibold leading-4 text-primary-subtle-fg tabular-nums"
          title={`Runs in parallel with the previous step (${String(overlap)} wk overlap)`}
          data-testid="step-parallel-marker"
        >
          parallel {overlap} wk
        </span>
      ) : null}
      {/* P12 (ADR 0019): a planner override or start floor is set on this step. */}
      {edited ? (
        <span
          className="inline-flex shrink-0 items-center gap-0.5 rounded-sm bg-primary-subtle px-1 text-[0.625rem] font-semibold leading-4 text-primary-subtle-fg"
          title={`Timing edited: ${editedTitle}`}
          data-testid="step-timing-edited"
        >
          <PencilLine className="size-2.5" aria-hidden="true" />
          {narrow ? <span className="sr-only">edited</span> : 'edited'}
          <span className="sr-only">{`: ${editedTitle}`}</span>
        </span>
      ) : null}
      {/* The keyboard alternative to dragging the bar. */}
      {editable ? (
        <button
          type="button"
          className="shrink-0 rounded-sm p-0.5 text-text-muted hover:bg-surface-sunken hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Edit timing for ${name} (${project.project_name})`}
          title="Edit timing"
          onClick={() => host.openDialog(stepTimingTarget(project, step))}
        >
          <SlidersHorizontal className="size-3" aria-hidden="true" />
        </button>
      ) : null}
    </div>
  );
}

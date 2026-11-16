import * as React from 'react';
import { TriangleAlert } from 'lucide-react';

import { cn } from '@/lib/utils';
import { formatPlanWeek } from '@/lib/format';
import { usePlanYearLabels } from '@/lib/plan-clock';
import { StepKindBadge } from '@/components/shared/step-kind-badge';

import { stepStatusLabels } from '../lib/gantt-status-labels';
import { isEffortZeroed } from '../lib/step-duration-source';
import { gapChipText, gapChipTitle } from '../lib/step-gap';
import { isPastScaleEnd, lastScaleWeek, type WeekScale } from '../lib/gantt-coordinates';
import { stepBarTitle } from '../lib/step-row-text';
import { stepColor } from '../lib/step-colors';
import type { GanttProjectRow, GanttStepRow } from '../api/types';
import { GanttBarGroup, GanttSpilloverMarker } from './gantt-bars';
import { PinnedSegmentMarker } from './pinned-marker';

/**
 * One step's bar (planned + actual, served weeks verbatim) and, when it runs
 * past the axis end, the chevron spillover marker. SVG content: the caller
 * provides the `<svg>` and `GanttHatchDefs`. Moved out of `gantt-chart.tsx`
 * in P32-R04 so the Timeline and the Workflow page's per-project waterfall
 * draw the same bar. `fmt` formats weeks in the hover text (default
 * `formatPlanWeek`, the Timeline's "After W52").
 */
export function StepBarGraphic({
  project,
  step: s,
  scale,
  height,
  fmt = formatPlanWeek,
}: {
  project: GanttProjectRow;
  step: GanttStepRow;
  scale: WeekScale;
  height: number;
  fmt?: ((week: number) => string) | undefined;
}): React.JSX.Element {
  const years = usePlanYearLabels();
  const planned =
    s.planned_start_week != null && s.planned_end_week != null
      ? { startWeek: s.planned_start_week, endWeek: s.planned_end_week }
      : null;
  const actual =
    s.actual_start_week != null && s.actual_end_week != null
      ? { startWeek: s.actual_start_week, endWeek: s.actual_end_week }
      : null;
  const runsPast = !s.skipped && (isPastScaleEnd(planned?.endWeek, scale) || isPastScaleEnd(actual?.endWeek, scale));
  return (
    <>
      <GanttBarGroup
        scale={scale}
        y={0}
        rowHeight={height}
        planned={planned}
        actual={actual}
        plannedEndWeek={s.planned_end_week}
        delayedEndWeek={s.actual_end_week}
        frozen={project.frozen}
        title={stepBarTitle(s, planned, actual, fmt)}
        compact
        kind={s.kind}
        skipped={s.skipped}
        color={stepColor(s.step_id, s.sequence_order)}
      />
      {/* P40-T03c: the run placed this step on its typed weeks (served flag). */}
      {s.pinned && !s.skipped ? (
        <PinnedSegmentMarker
          startWeek={s.planned_start_week}
          endWeek={s.planned_end_week}
          scale={scale}
          cy={height / 2}
          fmt={fmt}
        />
      ) : null}
      {runsPast ? (
        <GanttSpilloverMarker
          scale={scale}
          rowHeight={height}
          variant="chevron"
          title={`${s.step_name} continues past ${fmt(lastScaleWeek(scale))} — spillover to ${years.spilloverYear}`}
        />
      ) : null}
    </>
  );
}

/**
 * A Timeline step row's left cell (moved out of `gantt-chart.tsx` in P32-R02).
 * Every value is a served field. Read-only since P33-T15 (ADR 0048): timing
 * is shaped per category on Workflow templates, so there is no edit control
 * and no "edited" marker; the template gap shows as a read-only chip.
 */

export function StepLeftCell({
  step,
  compact = false,
  narrow = false,
}: {
  step: GanttStepRow;
  compact?: boolean;
  /** P19-R02: phone layout — no status column, so flags show as a compact icon. */
  narrow?: boolean;
}): React.JSX.Element {
  const { step_name: name, kind, skipped, sequence_order: sequenceOrder } = step;
  // An elapsed step books nobody (ADR 0007) — there is no resource to name.
  const resource =
    kind === 'lab' ? step.assigned_chamber_code : kind === 'design' ? step.assigned_engineer_name : null;
  const gap = gapChipText(step.gap_weeks);
  const flags = narrow && !skipped ? stepStatusLabels(step) : [];
  const color = stepColor(step.step_id, sequenceOrder);
  // QA-P19-1: a skipped row is NOT dimmed with opacity (that dimmed the kind
  // badge below AA). Only the name is muted — a full-strength token that still
  // clears AA — with a strikethrough and a "skipped" word; the badge stays at
  // full contrast.
  return (
    <div className={cn('flex min-w-0 flex-1 items-center', narrow ? 'gap-1 pl-1' : 'gap-1.5 pl-4')} data-skipped={skipped || undefined}>
      {/* P40-T01: the step's bar colour, so the row and its bar pair up. */}
      <span
        aria-hidden="true"
        className="size-2 shrink-0 rounded-sm"
        style={{ background: color.fill }}
        data-testid="gantt-step-swatch"
        data-step-slot={color.slot}
      />
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
      {/* P33-T15 (ADR 0048 §1): the template gap copied to the project, read-only (served value). */}
      {gap !== null && !narrow && !skipped ? (
        <span
          className="inline-flex shrink-0 items-center rounded-sm border border-primary/40 px-1 text-[0.625rem] font-semibold leading-4 text-primary-subtle-fg tabular-nums"
          title={gapChipTitle(step.gap_weeks)}
          data-testid="step-gap-chip"
          data-gap-weeks={step.gap_weeks}
        >
          {gap}
          <span className="sr-only">{`: ${gapChipTitle(step.gap_weeks)}`}</span>
        </span>
      ) : null}
    </div>
  );
}

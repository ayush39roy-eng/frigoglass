import * as React from 'react';

import { cn } from '@/lib/utils';
import { formatYearWeek } from '@/lib/format';
import { stageStatusLabel } from '@/types/enums';

import { lastScaleWeek, projectWaterfallScale } from '../lib/gantt-coordinates';
import { useElementWidth, useNarrowGantt } from '../lib/gantt-layout';
import type { GanttProjectRow } from '../api/types';
import { GanttHatchDefs } from './gantt-bars';
import { StepRowBadges } from './gantt-badges';
import { StepBarGraphic, StepLeftCell } from './gantt-step-row';
import { AXIS_HEIGHT, GanttGridLines, GanttWeekAxis } from './gantt-time-axis';
import { StepDragOverlay } from './step-timing/step-drag-overlay';
import { stepTimingTarget } from './step-timing/step-timing-context';

/**
 * P32-R04 (owner 2026-11-04: "mainly we will do it in Workflow"): one
 * project's steps one below another on a week axis, with exactly the
 * Timeline's step editing — the shared `StepDragOverlay` (move, right-edge
 * resize, drop onto the step above = parallel overlap), the row's "Edit
 * timing" button (keyboard path) and the step-timing host's dialog, Reset and
 * run-follow. Mount it inside a `StepTimingProvider`; without one it is read
 * only. What is editable is the served `timing_editable`, never decided here.
 *
 * The axis (`projectWaterfallScale`) runs from just before the earlier of the
 * project's first start and the current week to just after the later of W52
 * and its latest served week, capped at W78; weeks past W52 are labelled as
 * next year ("W5 '27"). Every bar is a served week pair (I9). At most 14 rows,
 * so no virtualization is needed.
 *
 * Width: `weekWidthPx` is the MINIMUM week width; the weeks grow so the axis
 * fills the card (status column at the right edge), and the chart scrolls
 * horizontally only when the minimum does not fit. A step the run did not
 * place (no served weeks) gets a "Not placed" note instead of a bar; its
 * keyboard "Edit timing" stays as served.
 */

export const WATERFALL_WEEK_PX = 24;
const ROW_HEIGHT = 40;
const LEFT_WIDTH = 300;
const LEFT_WIDTH_NARROW = 150;
const STATUS_WIDTH = 132;

export function ProjectStepWaterfall({
  project,
  weekWidthPx = WATERFALL_WEEK_PX,
}: {
  project: GanttProjectRow;
  weekWidthPx?: number;
}): React.JSX.Element {
  const narrow = useNarrowGantt();
  const leftWidth = narrow ? LEFT_WIDTH_NARROW : LEFT_WIDTH;
  const statusWidth = narrow ? 0 : STATUS_WIDTH;
  const steps = React.useMemo(
    () => [...project.steps].sort((a, b) => a.sequence_order - b.sequence_order),
    [project.steps],
  );
  const boxRef = React.useRef<HTMLDivElement>(null);
  const boxWidth = useElementWidth(boxRef);
  const scale = React.useMemo(() => {
    const min = projectWaterfallScale(steps, weekWidthPx);
    // The card's inner width minus both columns (and the 1.5 px borders).
    const available = boxWidth - leftWidth - statusWidth - 3;
    return available > min.totalWidthPx ? projectWaterfallScale(steps, available / min.horizonWeeks) : min;
  }, [steps, weekWidthPx, boxWidth, leftWidth, statusWidth]);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  // The visible timeline in client px (minus the sticky columns), so the drag
  // label stays inside it — as on the Timeline.
  const viewport = React.useCallback(() => {
    const el = scrollRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left + leftWidth, right: r.left + el.clientWidth - statusWidth };
  }, [leftWidth, statusWidth]);

  const contentWidth = leftWidth + scale.totalWidthPx + statusWidth;
  const bodyHeight = steps.length * ROW_HEIGHT;
  const first = scale.originWeek;
  const last = lastScaleWeek(scale);

  return (
    <div
      ref={boxRef}
      className="overflow-hidden rounded-dash border-[1.5px] border-border bg-surface"
      data-testid="project-step-waterfall"
      data-week-px={scale.weekWidthPx}
    >
      <div
        ref={scrollRef}
        className="overflow-x-auto scrollbar-thin focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        role="region"
        aria-label={`Steps of ${project.project_name}, ${formatYearWeek(first)} to ${formatYearWeek(last)} (scrolls horizontally)`}
        tabIndex={0}
        data-testid="waterfall-scroll"
        data-origin-week={first}
        data-last-week={last}
      >
        <div style={{ width: contentWidth, position: 'relative' }}>
          <div className="flex border-b border-border bg-surface-sunken" style={{ height: AXIS_HEIGHT }}>
            <div
              className="sticky left-0 z-10 flex shrink-0 items-center border-r border-border bg-surface-sunken px-3 text-2xs font-bold uppercase tracking-wider text-text-subtle"
              style={{ width: leftWidth }}
            >
              Step
            </div>
            <div style={{ width: scale.totalWidthPx }} className="shrink-0" data-testid="waterfall-axis">
              <GanttWeekAxis
                scale={scale}
                weekLabel={formatYearWeek}
                ariaLabel={`Week axis, ${formatYearWeek(first)} to ${formatYearWeek(last)}`}
              />
            </div>
            {statusWidth > 0 ? (
              <div
                className="sticky right-0 z-10 flex shrink-0 items-center justify-end border-l border-border bg-surface-sunken px-3 text-2xs font-bold uppercase tracking-wider text-text-subtle"
                style={{ width: statusWidth }}
              >
                Status
              </div>
            ) : null}
          </div>

          <div style={{ height: bodyHeight, position: 'relative' }}>
            <div
              className="pointer-events-none absolute top-0"
              style={{ left: leftWidth, width: scale.totalWidthPx, height: bodyHeight }}
            >
              <GanttGridLines scale={scale} height={bodyHeight} />
            </div>
            {steps.map((step, index) => (
              <div
                key={step.step_id}
                className="group/row absolute left-0 flex has-[[data-dragging=true]]:z-20"
                style={{ top: index * ROW_HEIGHT, height: ROW_HEIGHT, width: contentWidth }}
                data-testid="waterfall-step-row"
                data-step-id={step.step_id}
              >
                <div
                  className={cn(
                    'sticky left-0 z-10 flex shrink-0 items-center border-r border-b border-border bg-surface-raised',
                    narrow ? 'px-1' : 'px-2',
                  )}
                  style={{ width: leftWidth }}
                >
                  <StepLeftCell project={project} step={step} narrow={narrow} timingEdits />
                </div>
                <div
                  className="relative shrink-0 border-b border-border/70 transition-colors group-hover/row:bg-primary-subtle/30"
                  style={{ width: scale.totalWidthPx }}
                >
                  <svg width={scale.totalWidthPx} height={ROW_HEIGHT} className="block">
                    <GanttHatchDefs />
                    <StepBarGraphic project={project} step={step} scale={scale} height={ROW_HEIGHT} fmt={formatYearWeek} />
                  </svg>
                  {!step.skipped && step.planned_start_week == null && step.actual_start_week == null ? (
                    <span
                      className="absolute left-2 top-1/2 -translate-y-1/2 whitespace-nowrap rounded-sm border border-dashed border-warning/60 bg-surface px-1.5 text-[0.625rem] font-semibold leading-4 text-warning-subtle-fg"
                      data-testid="waterfall-step-unplaced"
                    >
                      Not placed in the active run
                    </span>
                  ) : null}
                  {!step.skipped ? (
                    <StepDragOverlay
                      target={stepTimingTarget(project, step)}
                      scale={scale}
                      rowHeight={ROW_HEIGHT}
                      viewport={viewport}
                      touch={narrow}
                    />
                  ) : null}
                </div>
                {statusWidth > 0 ? (
                  <div
                    className="sticky right-0 z-10 flex shrink-0 items-center justify-end gap-1 border-l border-b border-border bg-surface px-2"
                    style={{ width: statusWidth }}
                    data-testid="waterfall-step-status"
                  >
                    {/* "On Hold" is already a StepRowBadges chip. */}
                    {step.skipped || step.status === 'Blocked' ? null : (
                      <span className="whitespace-nowrap text-2xs text-text-muted">{stageStatusLabel(step.status)}</span>
                    )}
                    <StepRowBadges step={step} />
                  </div>
                ) : null}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

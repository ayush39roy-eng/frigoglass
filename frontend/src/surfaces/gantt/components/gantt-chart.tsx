import * as React from 'react';
import { Link } from 'react-router-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import { LayoutGroup, motion } from 'framer-motion';
import { ArrowUpRight, ChevronRight, PencilLine, SlidersHorizontal, Snowflake } from 'lucide-react';

import { cn } from '@/lib/utils';
import { formatPlanWeek } from '@/lib/format';
import { SPILLOVER_YEAR } from '@/lib/domain-constants';
import { usePrefersReducedMotion } from '@/lib/use-prefers-reduced-motion';
import { PriorityMoveControl } from '@/components/shared/priority-move/priority-move-control';
import { StepKindBadge } from '@/components/shared/step-kind-badge';
import { TrackingStatusChip } from '@/components/shared/tracking-status-chip';
import { VipBadge } from '@/components/shared/vip-badge';

import {
  isPastScaleEnd,
  makeWeekScale,
  plannedSpan,
  actualSpan,
  type GanttZoom,
} from '../lib/gantt-coordinates';
import { buildVisualRows, visualRowHeight } from '../lib/gantt-rows';
import type { GanttProjectRow, GanttStepRow } from '../api/types';
import { ActivityLoadStrip } from './activity-load-strip';
import { GanttBarGroup, GanttHatchDefs, GanttSpilloverMarker } from './gantt-bars';
import { ProjectRowBadges, StepRowBadges } from './gantt-badges';
import { GanttCompletionMarkers } from './gantt-completion-markers';
import { AXIS_HEIGHT, GanttGridLines, GanttWeekAxis } from './gantt-time-axis';
import { StepDragOverlay } from './step-timing/step-drag-overlay';
import { hasTimingEdit, stepTimingTarget, useStepTimingHost } from './step-timing/step-timing-context';

/**
 * The hand-built virtualized Gantt renderer (`dataviz-gantt` SKILL + Standing
 * Decisions — NO commercial Gantt library). SVG bars, week-bucket coordinates,
 * TanStack Virtual on the row axis. One `overflow-auto` scroll container with a
 * `position: sticky` header (week axis), left column (names) and right column
 * (badges) — so header and body share one scroll position by construction (no
 * drifting JS scroll-sync).
 *
 * Every bar's x / width is a pure render of server week numbers through the
 * week→pixel scale (`gantt-bars.tsx` / `gantt-coordinates.ts`); every badge is a
 * server flag rendered verbatim (`gantt-badges.tsx`). Nothing here recomputes a
 * schedule, a week, or an outcome.
 */

const LEFT_COL_WIDTH = 248;
const BADGE_COL_WIDTH = 148;
const SPRING = { type: 'spring', stiffness: 300, damping: 30 } as const;

export interface GanttChartProps {
  rows: GanttProjectRow[];
  zoom: GanttZoom;
  expandedIds: ReadonlySet<string>;
  onToggleExpand: (projectId: string) => void;
  onFreezeClick: (project: GanttProjectRow) => void;
  canWrite: boolean;
  maxHeight?: number;
}

export function GanttChart({
  rows,
  zoom,
  expandedIds,
  onToggleExpand,
  onFreezeClick,
  canWrite,
  maxHeight = 560,
}: GanttChartProps): React.JSX.Element {
  const animate = !usePrefersReducedMotion();

  const scrollRef = React.useRef<HTMLDivElement>(null);
  const scale = React.useMemo(() => makeWeekScale(zoom), [zoom]);
  const visualRows = React.useMemo(
    () => buildVisualRows(rows, expandedIds),
    [rows, expandedIds],
  );

  // Cumulative pixel offsets — deterministic from fixed row heights.
  const offsets = React.useMemo(() => {
    const acc: number[] = [];
    let sum = 0;
    for (const vr of visualRows) {
      acc.push(sum);
      sum += visualRowHeight(vr);
    }
    return { acc, total: sum };
  }, [visualRows]);

  const virtualizer = useVirtualizer({
    count: visualRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => visualRowHeight(visualRows[index]),
    overscan: 10,
  });

  // Focus accent: the most-recently-expanded project. A single element with a
  // shared `layoutId` slides to it — the one place a shared-element transition
  // earns its cost (`frontend-builder` SKILL). Gated behind reduced-motion.
  const prevExpanded = React.useRef<ReadonlySet<string>>(expandedIds);
  const [focusedId, setFocusedId] = React.useState<string | null>(null);
  React.useEffect(() => {
    let next: string | null = null;
    for (const id of expandedIds) if (!prevExpanded.current.has(id)) next = id;
    setFocusedId((cur) => {
      if (next) return next;
      if (cur && !expandedIds.has(cur)) return null;
      return cur;
    });
    prevExpanded.current = expandedIds;
  }, [expandedIds]);

  const items = virtualizer.getVirtualItems();
  const contentWidth = LEFT_COL_WIDTH + scale.totalWidthPx + BADGE_COL_WIDTH;

  return (
    <div className="overflow-hidden rounded-dash border-[1.5px] border-border bg-surface">
      <div
        ref={scrollRef}
        className="overflow-auto scrollbar-thin"
        style={{ maxHeight }}
        data-testid="gantt-scroll"
      >
        <div style={{ width: contentWidth, position: 'relative' }}>
          {/* sticky header: corner + week axis + status label */}
          <div
            className="sticky top-0 z-30 flex border-b border-border bg-surface-sunken"
            style={{ height: AXIS_HEIGHT }}
          >
            <div
              className="sticky left-0 z-10 flex shrink-0 items-center border-r border-border bg-surface-sunken px-4 text-2xs font-bold uppercase tracking-wider text-text-subtle"
              style={{ width: LEFT_COL_WIDTH }}
            >
              Project / step
            </div>
            <div style={{ width: scale.totalWidthPx }} className="shrink-0">
              <GanttWeekAxis scale={scale} />
            </div>
            <div
              className="sticky right-0 z-10 flex shrink-0 items-center justify-end border-l border-border bg-surface-sunken px-4 text-2xs font-bold uppercase tracking-wider text-text-subtle"
              style={{ width: BADGE_COL_WIDTH }}
            >
              Status
            </div>
          </div>

          {/* body */}
          <div style={{ height: offsets.total, position: 'relative' }}>
            {/* grid + markers behind the rows, timeline region only */}
            <div
              className="pointer-events-none absolute top-0"
              style={{ left: LEFT_COL_WIDTH, width: scale.totalWidthPx, height: offsets.total }}
            >
              <GanttGridLines scale={scale} height={offsets.total} />
            </div>

            <LayoutGroup>
              {items.map((item) => {
                const vr = visualRows[item.index];
                if (!vr) return null;
                const top = item.start;
                const height = item.size;

                return (
                  <div
                    key={vr.key}
                    className="group/row absolute left-0 flex"
                    style={{ top, height, width: contentWidth }}
                    data-testid={vr.kind === 'project' ? 'gantt-project-row' : 'gantt-step-row'}
                    data-project-id={vr.project.project_id}
                  >
                    {/* left column (sticky) */}
                    <div
                      className={cn(
                        'sticky left-0 z-10 flex shrink-0 items-center gap-1 border-r border-b border-border bg-surface px-2',
                        vr.kind === 'step' && 'bg-surface-raised',
                      )}
                      style={{ width: LEFT_COL_WIDTH }}
                    >
                      {vr.kind === 'project' ? (
                        <ProjectLeftCell
                          project={vr.project}
                          expanded={expandedIds.has(vr.project.project_id)}
                          focused={focusedId === vr.project.project_id}
                          animate={animate}
                          canWrite={canWrite}
                          onToggleExpand={onToggleExpand}
                          onFreezeClick={onFreezeClick}
                        />
                      ) : (
                        <StepLeftCell project={vr.project} step={vr.step} />
                      )}
                    </div>

                    {/* timeline column */}
                    <div
                      className="relative shrink-0 border-b border-border/70 transition-colors group-hover/row:bg-primary-subtle/30"
                      style={{ width: scale.totalWidthPx }}
                    >
                      <BarLayer row={vr} scale={scale} height={height} animate={animate} />
                      {/* P12 (ADR 0019): drag handles, only where the server says
                          `timing_editable` allows it (none → nothing rendered). */}
                      {vr.kind === 'step' && !vr.step.skipped ? (
                        <StepDragOverlay target={stepTimingTarget(vr.project, vr.step)} scale={scale} rowHeight={height} />
                      ) : null}
                    </div>

                    {/* badge column (sticky) */}
                    <div
                      className="sticky right-0 z-10 flex shrink-0 items-center justify-end border-l border-b border-border bg-surface px-2"
                      style={{ width: BADGE_COL_WIDTH }}
                    >
                      {vr.kind === 'project' ? (
                        <ProjectRowBadges project={vr.project} />
                      ) : (
                        <StepRowBadges step={vr.step} />
                      )}
                    </div>
                  </div>
                );
              })}
            </LayoutGroup>
          </div>

          {/* sticky load strip */}
          <div
            className="sticky bottom-0 z-20 flex border-t border-border bg-surface-sunken"
            style={{ height: 30 }}
          >
            <div
              className="sticky left-0 z-10 flex shrink-0 items-center border-r border-border bg-surface-sunken px-3 text-2xs text-text-muted"
              style={{ width: LEFT_COL_WIDTH }}
            >
              Step density in view
            </div>
            <div style={{ width: scale.totalWidthPx }} className="shrink-0 self-end">
              <ActivityLoadStrip scale={scale} rows={rows} />
            </div>
            <div
              className="sticky right-0 z-10 shrink-0 border-l border-border bg-surface-sunken"
              style={{ width: BADGE_COL_WIDTH }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

function BarLayer({
  row,
  scale,
  height,
  animate,
}: {
  row: ReturnType<typeof buildVisualRows>[number];
  scale: ReturnType<typeof makeWeekScale>;
  height: number;
  animate: boolean;
}): React.JSX.Element {
  let group: React.ReactNode;
  // ADR 0024: the axis ends at W52. A row whose work runs past it (clipped
  // geometry), or that the server flags spillover / left out, gets the
  // "Spillover → 2027" marker at the right edge instead of W53+ columns.
  let spilloverMarker: React.ReactNode = null;
  if (row.kind === 'project') {
    const planned = plannedSpan(row.project.steps);
    const actual = actualSpan(row.project.steps);
    const plannedEndWeek = planned ? planned.endWeek : null;
    const delayedEndWeek =
      plannedEndWeek != null && row.project.delay_weeks > 0
        ? plannedEndWeek + row.project.delay_weeks
        : actual
          ? actual.endWeek
          : null;
    group = (
      <GanttBarGroup
        scale={scale}
        y={0}
        rowHeight={height}
        planned={planned}
        actual={actual}
        plannedEndWeek={plannedEndWeek}
        delayedEndWeek={delayedEndWeek}
        frozen={row.project.frozen}
        title={barTitle(row.project.project_name, planned, actual)}
      />
    );
    const p = row.project;
    const runsPastAxis =
      isPastScaleEnd(planned?.endWeek, scale) ||
      isPastScaleEnd(actual?.endWeek, scale) ||
      isPastScaleEnd(delayedEndWeek, scale) ||
      isPastScaleEnd(p.projected_end_week, scale);
    if (p.spillover || p.left_out || runsPastAxis) {
      spilloverMarker = (
        <GanttSpilloverMarker
          scale={scale}
          rowHeight={height}
          variant="label"
          title={
            p.left_out
              ? `${p.project_name}: not done by W52 — no slot found yet, spills over to ${String(SPILLOVER_YEAR)} unscheduled`
              : `${p.project_name}: not done by W52 — spillover to ${String(SPILLOVER_YEAR)}`
          }
        />
      );
    }
  } else {
    const s = row.step;
    const planned =
      s.planned_start_week != null && s.planned_end_week != null
        ? { startWeek: s.planned_start_week, endWeek: s.planned_end_week }
        : null;
    const actual =
      s.actual_start_week != null && s.actual_end_week != null
        ? { startWeek: s.actual_start_week, endWeek: s.actual_end_week }
        : null;
    group = (
      <GanttBarGroup
        scale={scale}
        y={0}
        rowHeight={height}
        planned={planned}
        actual={actual}
        plannedEndWeek={s.planned_end_week}
        delayedEndWeek={s.actual_end_week}
        frozen={row.project.frozen}
        title={barTitle(`${s.step_name}`, planned, actual)}
        compact
        kind={s.kind}
        skipped={s.skipped}
      />
    );
    if (!s.skipped && (isPastScaleEnd(planned?.endWeek, scale) || isPastScaleEnd(actual?.endWeek, scale))) {
      spilloverMarker = (
        <GanttSpilloverMarker
          scale={scale}
          rowHeight={height}
          variant="chevron"
          title={`${s.step_name} continues past W52 — spillover to ${String(SPILLOVER_YEAR)}`}
        />
      );
    }
  }

  // The two completion lines are per PROJECT row (DOMAIN_RULES "Expected vs
  // projected completion"); drawn after the bars so they sit on top.
  const markers =
    row.kind === 'project' ? (
      <GanttCompletionMarkers
        scale={scale}
        rowHeight={height}
        projectName={row.project.project_name}
        targetEndWeek={row.project.target_end_week}
        expectedEndWeek={row.project.expected_end_week}
        projectedEndWeek={row.project.projected_end_week}
        slipWeeks={row.project.slip_weeks}
      />
    ) : null;

  const svg = (
    <svg width={scale.totalWidthPx} height={height} className="block">
      <GanttHatchDefs />
      {group}
      {markers}
      {spilloverMarker}
    </svg>
  );

  if (row.kind === 'step' && animate) {
    return (
      <motion.div
        initial={{ opacity: 0, x: -6 }}
        animate={{ opacity: 1, x: 0 }}
        transition={SPRING}
        data-motion="true"
      >
        {svg}
      </motion.div>
    );
  }
  return <div data-motion="false">{svg}</div>;
}

function barTitle(
  label: string,
  planned: { startWeek: number; endWeek: number } | null,
  actual: { startWeek: number; endWeek: number } | null,
): string {
  const parts = [label];
  if (planned) parts.push(`planned ${formatPlanWeek(planned.startWeek)}–${formatPlanWeek(planned.endWeek)}`);
  if (actual) parts.push(`actual ${formatPlanWeek(actual.startWeek)}–${formatPlanWeek(actual.endWeek)}`);
  return parts.join(' · ');
}

function ProjectLeftCell({
  project,
  expanded,
  focused,
  animate,
  canWrite,
  onToggleExpand,
  onFreezeClick,
}: {
  project: GanttProjectRow;
  expanded: boolean;
  focused: boolean;
  animate: boolean;
  canWrite: boolean;
  onToggleExpand: (id: string) => void;
  onFreezeClick: (project: GanttProjectRow) => void;
}): React.JSX.Element {
  return (
    <>
      {focused ? (
        animate ? (
          <motion.span
            layoutId="gantt-focus-accent"
            transition={SPRING}
            className="absolute left-0 top-0 h-full w-[3px] bg-primary"
            data-testid="gantt-focus-accent"
            data-motion="true"
            aria-hidden="true"
          />
        ) : (
          <span
            className="absolute left-0 top-0 h-full w-[3px] bg-primary"
            data-testid="gantt-focus-accent"
            data-motion="false"
            aria-hidden="true"
          />
        )
      ) : null}
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-1 rounded-sm py-1 text-left hover:bg-surface-raised"
        aria-expanded={expanded}
        aria-label={`${expanded ? 'Collapse' : 'Expand'} steps for ${project.project_name}`}
        onClick={() => onToggleExpand(project.project_id)}
      >
        {animate ? (
          <motion.span
            animate={{ rotate: expanded ? 90 : 0 }}
            transition={SPRING}
            className="shrink-0 text-text-muted"
          >
            <ChevronRight className="size-3.5" aria-hidden="true" />
          </motion.span>
        ) : (
          <span
            className="shrink-0 text-text-muted"
            style={{ transform: expanded ? 'rotate(90deg)' : undefined }}
          >
            <ChevronRight className="size-3.5" aria-hidden="true" />
          </span>
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-xs font-bold text-text" title={project.project_name}>
            {project.project_name}
          </span>
          {/* P12: VIP pin (ADR 0022) and the served tracking status (ADR 0021). */}
          <span className="flex min-w-0 items-center gap-1 text-2xs text-text-muted">
            <span className="truncate">{project.hub}</span>
            {project.is_vip ? <VipBadge className="px-1 py-px" /> : null}
            <TrackingStatusChip status={project.tracking_status} className="px-1 py-px" />
          </span>
        </span>
      </button>
      {/* P11 (ADR 0015): with Registration write this is a dropdown that moves the
          priority and recalculates; otherwise the read-only pill. It sits outside
          the expand button because a menu trigger cannot nest in a button. The
          flow itself is hosted by GanttPage's <PriorityMoveProvider>, so scrolling
          this virtualized row away never cancels a run being followed. */}
      <PriorityMoveControl projectId={project.project_id} projectName={project.project_name} priority={project.priority} />
      {/* Click-through to the Project Workspace (Surface #7) — a real link, so
          it works with middle-click / bookmarks. */}
      <Link
        to={`/projects/${project.project_id}`}
        className="shrink-0 rounded-sm p-1 text-text-muted hover:bg-surface-raised hover:text-primary"
        aria-label={`Open ${project.project_name} in the Project Workspace`}
        title="Open in Project Workspace"
      >
        <ArrowUpRight className="size-3.5" aria-hidden="true" />
      </Link>
      {canWrite ? (
        <button
          type="button"
          className="shrink-0 rounded-sm p-1 text-text-muted hover:bg-surface-raised hover:text-text"
          aria-label={project.frozen ? `Unfreeze ${project.project_name}` : `Freeze ${project.project_name}`}
          title={project.frozen ? 'Unfreeze project' : 'Freeze project'}
          onClick={() => onFreezeClick(project)}
        >
          <Snowflake className="size-3.5" aria-hidden="true" />
        </button>
      ) : null}
    </>
  );
}

function StepLeftCell({
  project,
  step,
}: {
  project: GanttProjectRow;
  step: GanttStepRow;
}): React.JSX.Element {
  const { step_name: name, kind, skipped, sequence_order: sequenceOrder } = step;
  // An elapsed step books nobody (ADR 0007) — there is no resource to name.
  const resource =
    kind === 'lab' ? step.assigned_chamber_code : kind === 'design' ? step.assigned_engineer_name : null;
  const host = useStepTimingHost();
  const editable = host !== null && step.timing_editable !== 'none' && !skipped;
  const edited = hasTimingEdit(step);
  const editedTitle = edited
    ? [
        step.duration_override_weeks !== null
          ? `duration ${String(step.duration_override_weeks)} wks (table ${String(step.lead_time_weeks)})`
          : null,
        step.start_not_before_week !== null ? `earliest start ${formatPlanWeek(step.start_not_before_week)}` : null,
      ]
        .filter(Boolean)
        .join(' · ')
    : '';
  return (
    <div className={cn('flex min-w-0 flex-1 items-center gap-1.5 pl-4', skipped && 'opacity-60')}>
      <StepKindBadge kind={kind} compact />
      <span className="min-w-0 flex-1">
        <span
          className={cn('block truncate text-2xs text-text', skipped && 'line-through decoration-border-strong')}
          title={skipped ? `${name} — not applicable for this project (skipped)` : name}
        >
          {sequenceOrder}. {name}
        </span>
        {resource ? (
          <span className="block truncate text-[0.625rem] text-text-muted" title={resource}>
            {resource}
          </span>
        ) : null}
      </span>
      {/* P12 (ADR 0019): a planner override or start floor is set on this step. */}
      {edited ? (
        <span
          className="inline-flex shrink-0 items-center gap-0.5 rounded-sm bg-primary-subtle px-1 text-[0.625rem] font-semibold leading-4 text-primary-subtle-fg"
          title={`Timing edited: ${editedTitle}`}
          data-testid="step-timing-edited"
        >
          <PencilLine className="size-2.5" aria-hidden="true" />
          edited
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

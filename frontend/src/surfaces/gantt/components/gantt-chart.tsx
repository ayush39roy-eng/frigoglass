import * as React from 'react';
import { Link } from 'react-router-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import { LayoutGroup, motion } from 'framer-motion';
import { ArrowUpRight, ChevronRight, Info, PencilLine, SlidersHorizontal, Snowflake, TriangleAlert } from 'lucide-react';

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
  type GanttDensity,
  type GanttZoom,
} from '../lib/gantt-coordinates';
import { ganttColumnWidths, useElementWidth, useNarrowGantt } from '../lib/gantt-layout';
import { projectStatusLabels, stepStatusLabels } from '../lib/gantt-status-labels';
import { buildVisualRows, visualRowHeight } from '../lib/gantt-rows';
import { calendarRangePhrase, workWeeksPhrase } from '../lib/step-weeks-copy';
import type { GanttProjectRow, GanttStepRow, GanttWeeklyActiveCount } from '../api/types';
import { ActivityLoadStrip, COUNT_ROW_HEIGHT, LOAD_STRIP_HEIGHT, WeeklyCountRow } from './activity-load-strip';
import { GanttBarGroup, GanttHatchDefs, GanttSpilloverMarker } from './gantt-bars';
import { ProjectRowBadges, StepRowBadges } from './gantt-badges';
import { GanttCompletionMarkers } from './gantt-completion-markers';
import { GanttProjectDetailsDialog } from './gantt-project-details';
import { ProjectMetaLine, RowWeeks } from './gantt-row-meta';
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
 * P19-R02 (QA-P19-2): below 768 px the two fixed columns collapse to one slim
 * name column (`gantt-layout.ts`); the status chips move into a compact row
 * icon and the project details dialog, so the timeline keeps most of the width
 * and stays draggable on touch. 1280+ layouts are unchanged.
 *
 * Every bar's x / width is a pure render of server week numbers through the
 * week→pixel scale (`gantt-bars.tsx` / `gantt-coordinates.ts`); every badge is a
 * server flag rendered verbatim (`gantt-badges.tsx`). Nothing here recomputes a
 * schedule, a week, or an outcome.
 */

const SPRING = { type: 'spring', stiffness: 300, damping: 30 } as const;

export interface GanttChartProps {
  rows: GanttProjectRow[];
  /** A named level or (P13-T13) px per week, 16–48. */
  zoom: GanttZoom | number;
  /** P13-T13: `forest` is the compact view (one line per project, no meta);
   *  `comfortable` (default) has room for the row meta. */
  density?: GanttDensity;
  /** P13-T13: served `weekly_active_counts` — the PDD / OEM count rows and the
   *  activity strip. Omitted or `showStats=false` hides them. */
  weeklyCounts?: readonly GanttWeeklyActiveCount[];
  showStats?: boolean;
  expandedIds: ReadonlySet<string>;
  onToggleExpand: (projectId: string) => void;
  onFreezeClick: (project: GanttProjectRow) => void;
  canWrite: boolean;
  maxHeight?: number;
}

export function GanttChart({
  rows,
  zoom,
  density = 'comfortable',
  weeklyCounts,
  showStats = true,
  expandedIds,
  onToggleExpand,
  onFreezeClick,
  canWrite,
  maxHeight = 560,
}: GanttChartProps): React.JSX.Element {
  const compact = density === 'forest';
  const stats = showStats && weeklyCounts !== undefined;
  const animate = !usePrefersReducedMotion();

  const scrollRef = React.useRef<HTMLDivElement>(null);
  const boxRef = React.useRef<HTMLDivElement>(null);
  const narrow = useNarrowGantt();
  const boxWidth = useElementWidth(boxRef);
  const { left: LEFT_COL_WIDTH, status: BADGE_COL_WIDTH } = ganttColumnWidths(narrow, boxWidth);
  const hasStatusCol = BADGE_COL_WIDTH > 0;
  const [detailsId, setDetailsId] = React.useState<string | null>(null);
  const detailsProject = detailsId === null ? null : (rows.find((r) => r.project_id === detailsId) ?? null);

  // The visible timeline in client px — the scroll viewport minus both sticky
  // columns — so the drag label can stay inside it (gate observation O1).
  const timelineViewport = React.useCallback(() => {
    const el = scrollRef.current;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { left: r.left + LEFT_COL_WIDTH, right: r.left + el.clientWidth - BADGE_COL_WIDTH };
  }, [LEFT_COL_WIDTH, BADGE_COL_WIDTH]);
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
      sum += visualRowHeight(vr, density);
    }
    return { acc, total: sum };
  }, [visualRows, density]);

  const virtualizer = useVirtualizer({
    count: visualRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => visualRowHeight(visualRows[index], density),
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
    <div ref={boxRef} className="overflow-hidden rounded-dash border-[1.5px] border-border bg-surface">
      <div
        ref={scrollRef}
        className="overflow-auto scrollbar-thin focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        style={{ maxHeight }}
        role="region"
        aria-label="Project timeline (scrolls horizontally through the weeks)"
        tabIndex={0}
        data-testid="gantt-scroll"
        data-layout={narrow ? 'narrow' : 'wide'}
      >
        <div style={{ width: contentWidth, position: 'relative' }}>
          {/* sticky header: corner + week axis + status label, then (P13-T13)
              the served weekly PDD / OEM counts and the activity strip */}
          <div className="sticky top-0 z-30 border-b border-border bg-surface-sunken">
            <div className="flex" style={{ height: AXIS_HEIGHT }}>
              <div
                className={cn(
                  'sticky left-0 z-10 flex shrink-0 items-center border-r border-border bg-surface-sunken text-2xs font-bold uppercase tracking-wider text-text-subtle',
                  narrow ? 'px-2' : 'px-4',
                )}
                style={{ width: LEFT_COL_WIDTH }}
                data-testid="gantt-left-header"
              >
                {narrow ? 'Project' : 'Project / step'}
              </div>
              <div style={{ width: scale.totalWidthPx }} className="shrink-0">
                <GanttWeekAxis scale={scale} />
              </div>
              {hasStatusCol ? (
                <div
                  className="sticky right-0 z-10 flex shrink-0 items-center justify-end border-l border-border bg-surface-sunken px-4 text-2xs font-bold uppercase tracking-wider text-text-subtle"
                  style={{ width: BADGE_COL_WIDTH }}
                  data-testid="gantt-status-header"
                >
                  Status
                </div>
              ) : null}
            </div>
            {stats ? (
              <div className="flex border-t border-border/70" data-testid="gantt-weekly-stats">
                <div
                  className={cn(
                    'sticky left-0 z-10 flex shrink-0 flex-col justify-center border-r border-border bg-surface-sunken text-2xs text-text-muted',
                    narrow ? 'px-2' : 'px-4',
                  )}
                  style={{ width: LEFT_COL_WIDTH }}
                >
                  <span className="flex items-center gap-1.5 whitespace-nowrap" style={{ height: COUNT_ROW_HEIGHT }}>
                    <span aria-hidden="true" className="size-1.5 rounded-full bg-gantt-planned" />
                    <span className="font-semibold text-text">PDD</span> {narrow ? 'steps / wk' : 'active steps / week'}
                  </span>
                  <span className="flex items-center gap-1.5 whitespace-nowrap" style={{ height: COUNT_ROW_HEIGHT }}>
                    <span aria-hidden="true" className="size-1.5 rounded-full bg-warning" />
                    <span className="font-semibold text-text">OEM</span> {narrow ? 'steps / wk' : 'active steps / week'}
                  </span>
                  <span className="flex items-center whitespace-nowrap" style={{ height: LOAD_STRIP_HEIGHT }}>
                    {narrow ? 'Activity load' : 'Activity load (served)'}
                  </span>
                </div>
                <div style={{ width: scale.totalWidthPx }} className="shrink-0">
                  <WeeklyCountRow scale={scale} counts={weeklyCounts} workflow="pdd" />
                  <WeeklyCountRow scale={scale} counts={weeklyCounts} workflow="oem" />
                  <ActivityLoadStrip scale={scale} counts={weeklyCounts} />
                </div>
                {hasStatusCol ? (
                  <div
                    className="sticky right-0 z-10 shrink-0 border-l border-border bg-surface-sunken"
                    style={{ width: BADGE_COL_WIDTH }}
                  />
                ) : null}
              </div>
            ) : null}
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
                    className="group/row absolute left-0 flex has-[[data-dragging=true]]:z-20"
                    style={{ top, height, width: contentWidth }}
                    data-testid={vr.kind === 'project' ? 'gantt-project-row' : 'gantt-step-row'}
                    data-project-id={vr.project.project_id}
                  >
                    {/* left column (sticky) */}
                    <div
                      className={cn(
                        'sticky left-0 z-10 flex shrink-0 items-center gap-1 border-r border-b border-border bg-surface',
                        narrow ? 'px-1' : 'px-2',
                        vr.kind === 'step' && 'bg-surface-raised',
                      )}
                      style={{ width: LEFT_COL_WIDTH }}
                      data-testid="gantt-left-cell"
                    >
                      {vr.kind === 'project' ? (
                        <ProjectLeftCell
                          project={vr.project}
                          compact={compact}
                          expanded={expandedIds.has(vr.project.project_id)}
                          focused={focusedId === vr.project.project_id}
                          animate={animate}
                          canWrite={canWrite}
                          onToggleExpand={onToggleExpand}
                          onFreezeClick={onFreezeClick}
                          narrow={narrow}
                          onOpenDetails={setDetailsId}
                        />
                      ) : (
                        <StepLeftCell project={vr.project} step={vr.step} compact={compact} narrow={narrow} />
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
                        <StepDragOverlay
                          target={stepTimingTarget(vr.project, vr.step)}
                          scale={scale}
                          rowHeight={height}
                          viewport={timelineViewport}
                          touch={narrow}
                        />
                      ) : null}
                    </div>

                    {/* badge column (sticky) — wide layout only; on the narrow
                        layout the flags are a row icon + the details dialog */}
                    {hasStatusCol ? (
                      <div
                        className="sticky right-0 z-10 flex shrink-0 items-center justify-end border-l border-b border-border bg-surface px-2"
                        style={{ width: BADGE_COL_WIDTH }}
                        data-testid="gantt-status-cell"
                      >
                        {vr.kind === 'project' ? (
                          <ProjectRowBadges project={vr.project} />
                        ) : (
                          <StepRowBadges step={vr.step} />
                        )}
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </LayoutGroup>
          </div>

        </div>
      </div>
      <GanttProjectDetailsDialog
        project={detailsProject}
        open={detailsProject !== null}
        onOpenChange={(open) => {
          if (!open) setDetailsId(null);
        }}
        canWrite={canWrite}
        onFreezeClick={onFreezeClick}
      />
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
        title={stepBarTitle(s, planned, actual)}
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

/**
 * P20 (ADR 0032): the step bar's hover text names both figures — the bar is
 * CALENDAR weeks (served planned weeks, verbatim) and `duration_weeks` is WORK
 * weeks — e.g. "Prototype build · planned W10–W17 on the calendar · 4 wks of
 * work at 0.5 FTE". The suffix needs the served `span_fte`, which is null
 * for unstretched steps and for callers who may not edit the step (OQ #8).
 */
function stepBarTitle(
  s: GanttStepRow,
  planned: { startWeek: number; endWeek: number } | null,
  actual: { startWeek: number; endWeek: number } | null,
): string {
  const parts = [s.step_name];
  if (planned) parts.push(`planned ${calendarRangePhrase(planned.startWeek, planned.endWeek)}`);
  if (s.duration_weeks !== null && !s.skipped) parts.push(workWeeksPhrase(s.kind, s.duration_weeks, s.span_fte ?? null));
  if (actual) parts.push(`actual ${formatPlanWeek(actual.startWeek)}–${formatPlanWeek(actual.endWeek)}`);
  return parts.join(' · ');
}

function ProjectLeftCell({
  project,
  compact,
  expanded,
  focused,
  animate,
  canWrite,
  onToggleExpand,
  onFreezeClick,
  narrow = false,
  onOpenDetails,
}: {
  project: GanttProjectRow;
  compact: boolean;
  expanded: boolean;
  focused: boolean;
  animate: boolean;
  canWrite: boolean;
  onToggleExpand: (id: string) => void;
  onFreezeClick: (project: GanttProjectRow) => void;
  /** P19-R02: phone layout — name only; everything else is in the details dialog. */
  narrow?: boolean;
  onOpenDetails?: (projectId: string) => void;
}): React.JSX.Element {
  const statuses = narrow ? projectStatusLabels(project) : [];
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
          <span
            className={cn(
              'font-bold text-text',
              narrow ? 'line-clamp-2 break-words text-2xs leading-tight' : 'block truncate',
              !narrow && (compact ? 'text-2xs' : 'text-xs'),
            )}
            title={project.project_name}
          >
            {project.project_name}
          </span>
          {compact || narrow ? null : (
            <>
              {/* P13-T13: row meta — leader, external code, type, hub. */}
              <ProjectMetaLine project={project} />
              {/* P13-T13: served weeks, then the P12 VIP pin (ADR 0022) and the
                  served tracking status (ADR 0021). */}
              <span className="flex min-w-0 items-center gap-1 text-2xs text-text-muted">
                <RowWeeks project={project} />
                {project.is_vip ? <VipBadge className="px-1 py-px" /> : null}
                <TrackingStatusChip status={project.tracking_status} className="px-1 py-px" />
              </span>
            </>
          )}
        </span>
      </button>
      {narrow ? (
        <button
          type="button"
          className="relative shrink-0 rounded-sm p-0.5 text-text-muted hover:bg-surface-raised hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Details for ${project.project_name}${statuses.length > 0 ? ` (status: ${statuses.join(', ')})` : ''}`}
          title={statuses.length > 0 ? `Details · ${statuses.join(', ')}` : 'Details'}
          onClick={() => onOpenDetails?.(project.project_id)}
          data-testid="gantt-row-details"
          data-flags={statuses.length}
        >
          <Info className="size-3.5" aria-hidden="true" />
          {statuses.length > 0 ? (
            <span
              aria-hidden="true"
              className="absolute right-0 top-0 size-1.5 rounded-full bg-warning ring-1 ring-surface"
              data-testid="gantt-row-flag-dot"
            />
          ) : null}
        </button>
      ) : (
        <>
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
      )}
    </>
  );
}

function StepLeftCell({
  project,
  step,
  compact = false,
  narrow = false,
}: {
  project: GanttProjectRow;
  step: GanttStepRow;
  compact?: boolean;
  /** P19-R02: phone layout — no status column, so flags show as a compact icon. */
  narrow?: boolean;
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
          ? `${kind === 'design' ? 'work' : 'duration'} ${String(step.duration_override_weeks)} wks (table ${String(step.lead_time_weeks)})`
          : null,
        step.start_not_before_week !== null ? `earliest start ${formatPlanWeek(step.start_not_before_week)}` : null,
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
          title={skipped ? `${name} — not applicable for this project (skipped)` : name}
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

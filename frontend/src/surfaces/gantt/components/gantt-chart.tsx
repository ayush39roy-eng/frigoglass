import * as React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { LayoutGroup, motion } from 'framer-motion';
import { ChevronRight, Snowflake } from 'lucide-react';

import { cn } from '@/lib/utils';
import { formatWeek } from '@/lib/format';
import { usePrefersReducedMotion } from '@/lib/use-prefers-reduced-motion';
import { PriorityBandPill } from '@/components/shared/priority-band-pill';

import {
  makeWeekScale,
  plannedSpan,
  actualSpan,
  type GanttZoom,
} from '../lib/gantt-coordinates';
import { buildVisualRows, visualRowHeight } from '../lib/gantt-rows';
import type { GanttProjectRow } from '../api/types';
import { ActivityLoadStrip } from './activity-load-strip';
import { GanttBarGroup, GanttHatchDefs } from './gantt-bars';
import { ProjectRowBadges, StepRowBadges } from './gantt-badges';
import { AXIS_HEIGHT, GanttGridLines, GanttWeekAxis } from './gantt-time-axis';

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
    <div className="overflow-hidden rounded-lg border border-border bg-surface">
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
              className="sticky left-0 z-10 flex shrink-0 items-center border-r border-border bg-surface-sunken px-3 text-2xs font-semibold text-text-muted"
              style={{ width: LEFT_COL_WIDTH }}
            >
              Project / step
            </div>
            <div style={{ width: scale.totalWidthPx }} className="shrink-0">
              <GanttWeekAxis scale={scale} />
            </div>
            <div
              className="sticky right-0 z-10 flex shrink-0 items-center justify-end border-l border-border bg-surface-sunken px-3 text-2xs font-semibold text-text-muted"
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
                    className="absolute left-0 flex"
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
                        <StepLeftCell
                          name={vr.step.step_name}
                          kind={vr.step.kind}
                          sequenceOrder={vr.step.sequence_order}
                          engineer={vr.step.assigned_engineer_name}
                          chamber={vr.step.assigned_chamber_code}
                        />
                      )}
                    </div>

                    {/* timeline column */}
                    <div className="relative shrink-0 border-b border-border" style={{ width: scale.totalWidthPx }}>
                      <BarLayer row={vr} scale={scale} height={height} animate={animate} />
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
      />
    );
  }

  const svg = (
    <svg width={scale.totalWidthPx} height={height} className="block">
      <GanttHatchDefs />
      {group}
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
  if (planned) parts.push(`planned ${formatWeek(planned.startWeek)}–${formatWeek(planned.endWeek)}`);
  if (actual) parts.push(`actual ${formatWeek(actual.startWeek)}–${formatWeek(actual.endWeek)}`);
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
          <span className="block truncate text-xs font-medium text-text" title={project.project_name}>
            {project.project_name}
          </span>
          <span className="block truncate text-2xs text-text-muted">{project.hub}</span>
        </span>
        {project.priority ? <PriorityBandPill priority={project.priority} /> : null}
      </button>
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
  name,
  kind,
  sequenceOrder,
  engineer,
  chamber,
}: {
  name: string;
  kind: 'design' | 'lab';
  sequenceOrder: number;
  engineer: string | null;
  chamber: string | null;
}): React.JSX.Element {
  const resource = kind === 'lab' ? chamber : engineer;
  return (
    <div className="flex min-w-0 flex-1 items-center gap-1.5 pl-4">
      <span
        className={cn(
          'shrink-0 rounded-sm px-1 text-[0.625rem] font-semibold uppercase',
          kind === 'lab' ? 'bg-accent/15 text-accent-subtle-fg' : 'bg-primary/10 text-primary-subtle-fg',
        )}
        title={kind === 'lab' ? 'Lab step' : 'Design step'}
      >
        {kind === 'lab' ? 'Lab' : 'Des'}
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-2xs text-text" title={name}>
          {sequenceOrder}. {name}
        </span>
        {resource ? (
          <span className="block truncate text-[0.625rem] text-text-muted" title={resource}>
            {resource}
          </span>
        ) : null}
      </span>
    </div>
  );
}

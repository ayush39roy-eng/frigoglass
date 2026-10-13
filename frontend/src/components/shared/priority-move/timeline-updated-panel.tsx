import * as React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowRight, EyeOff } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import type { ScheduleRunChangeRow, ScheduleRunChanges } from '@/lib/api/priority-move';
import { formatPlanWeek } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { ProjectPriority } from '@/types/enums';

import { PriorityBandPill } from '../priority-band-pill';
import { MOVE_COPY } from './move-copy';

/**
 * "Timeline updated" (ADR 0015 §4, P11 contract §3): what moved between the
 * baseline run and the run the priority move created. Every figure is a served
 * field of `GET /schedule-runs/{run}/changes`. Weeks, `delta_weeks` and the
 * before/after flags are printed as served; nothing is diffed in the browser
 * (I20). Rows outside the caller's hub scope arrive only as `hidden_count`.
 */

/** Above this many rows the list is virtualized (CLAUDE.md: any list over 100). */
const VIRTUALIZE_OVER = 100;
const ROW_HEIGHT = 60;

/** Framed on the 52-week year: a finish past W52 prints "After W52" (client ask
 *  2026-10-13), never W53+. */
function week(value: number | null): string {
  return value === null ? '—' : formatPlanWeek(value);
}

function DeltaChip({ delta }: { delta: number | null }): React.JSX.Element | null {
  if (delta === null || delta === 0) return null;
  const later = delta > 0;
  return (
    <Badge
      tone={later ? 'warning' : 'success'}
      className="shrink-0 rounded-pill font-semibold"
      data-numeric=""
      title={later ? `Finishes ${String(delta)} weeks later` : `Finishes ${String(Math.abs(delta))} weeks earlier`}
    >
      {later ? `+${String(delta)}` : `−${String(Math.abs(delta))}`} wk
    </Badge>
  );
}

/** One served before/after flag pair, printed only when the server's two
 *  values differ ("Within year → Past W52"). */
function FlagFlip({ before, after, yes, no }: { before: boolean; after: boolean; yes: string; no: string }): React.JSX.Element | null {
  if (before === after) return null;
  return (
    <Badge tone={after ? 'neutral' : 'outline'} className="rounded-pill">
      {before ? yes : no}
      <ArrowRight aria-hidden="true" />
      {after ? yes : no}
      <span className="sr-only">{` (was ${before ? yes : no}, now ${after ? yes : no})`}</span>
    </Badge>
  );
}

function Flips({ row }: { row: ScheduleRunChangeRow }): React.JSX.Element {
  return (
    <span className="flex flex-wrap items-center gap-1">
      {row.is_new ? <Badge tone="primary" className="rounded-pill">New in this run</Badge> : null}
      {row.is_removed ? <Badge tone="neutral" className="rounded-pill">Not in this run</Badge> : null}
      <FlagFlip before={row.before_within_year} after={row.after_within_year} yes="Within year" no="Past W52" />
      <FlagFlip before={row.before_left_out} after={row.after_left_out} yes="Spillover · unplaced" no="In the plan" />
      <FlagFlip before={row.before_blocked} after={row.after_blocked} yes="On hold at a stage" no="Not on hold" />
    </span>
  );
}

function WeekMove({ row }: { row: ScheduleRunChangeRow }): React.JSX.Element {
  return (
    <span className="inline-flex shrink-0 items-center gap-1 font-mono text-xs font-semibold tabular-nums text-text" data-numeric="">
      {week(row.before_projected_end_week)}
      <ArrowRight className="size-3 text-text-muted" aria-hidden="true" />
      <span className="sr-only">to</span>
      {week(row.after_projected_end_week)}
    </span>
  );
}

function ChangeRowItem({ row }: { row: ScheduleRunChangeRow }): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1 border-b border-border/60 py-2 last:border-b-0" data-testid="timeline-change-row">
      <div className="flex items-center justify-between gap-2">
        <span className="min-w-0 truncate text-xs font-bold text-text" title={row.project_name}>
          {row.project_name}
        </span>
        <span className="flex items-center gap-1.5">
          <WeekMove row={row} />
          <DeltaChip delta={row.delta_weeks} />
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-1.5 text-2xs text-text-muted">
        <span>{row.hub}</span>
        {row.priority ? <PriorityBandPill priority={row.priority} /> : null}
        <Flips row={row} />
      </div>
    </div>
  );
}

function VirtualChangeList({ rows }: { rows: ScheduleRunChangeRow[] }): React.JSX.Element {
  const scrollRef = React.useRef<HTMLDivElement>(null);
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual is the mandated virtualizer (see eslint.config.js).
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });
  return (
    <div ref={scrollRef} className="max-h-72 overflow-y-auto pr-1" data-testid="timeline-change-list" data-virtualized="true">
      <div role="list" aria-label="Other projects that moved" style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((item) => {
          const row = rows[item.index];
          if (!row) return null;
          return (
            <div
              key={row.project_id}
              role="listitem"
              style={{ position: 'absolute', top: 0, left: 0, right: 0, height: ROW_HEIGHT, transform: `translateY(${String(item.start)}px)` }}
            >
              <ChangeRowItem row={row} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

export interface TimelineUpdatedPanelProps {
  changes: ScheduleRunChanges;
  /** The moved project. Its own row, if served, is shown first. */
  projectId: string;
  projectName: string;
  priorityBefore?: ProjectPriority | null;
  priorityAfter?: ProjectPriority | null;
  /** P12 (ADR 0019): replaces the priority before → after line, for a change
   *  that was not a priority move (a Gantt step timing drag). */
  summary?: React.ReactNode;
}

export function TimelineUpdatedPanel({
  changes,
  projectId,
  projectName,
  priorityBefore = null,
  priorityAfter = null,
  summary,
}: TimelineUpdatedPanelProps): React.JSX.Element {
  const own = changes.rows.find((r) => r.project_id === projectId) ?? null;
  const others = changes.rows.filter((r) => r.project_id !== projectId);

  return (
    <div className="space-y-3" data-testid="timeline-updated">
      <p className="flex flex-wrap items-center gap-1.5 text-2xs text-text-muted">
        <span className="font-semibold text-text">{projectName}</span>
        {summary ?? (
          <>
            {priorityBefore ? <PriorityBandPill priority={priorityBefore} /> : <span>no priority</span>}
            <ArrowRight className="size-3" aria-hidden="true" />
            <span className="sr-only">to</span>
            {priorityAfter ? <PriorityBandPill priority={priorityAfter} /> : <span>no priority</span>}
          </>
        )}
        <span aria-hidden="true">·</span>
        <span data-numeric="">
          Run v{changes.run_version} compared with v{changes.against_run_version}
        </span>
      </p>

      <section aria-label="This project" className="rounded-dash border border-dash-hairline bg-dash-alt px-3 py-2" data-testid="timeline-own-change">
        <h3 className="label-caps text-text-subtle">This project&rsquo;s finish</h3>
        {own ? (
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <WeekMove row={own} />
            <DeltaChip delta={own.delta_weeks} />
            <Flips row={own} />
          </div>
        ) : (
          <p className="mt-1 text-xs text-text">{MOVE_COPY.unchangedOwn}</p>
        )}
      </section>

      <section aria-label="Other projects that moved" className="space-y-1">
        <h3 className="label-caps text-text-subtle">
          Other projects that moved <span className="normal-case tracking-normal">({others.length})</span>
        </h3>
        {others.length === 0 ? (
          <p className="text-xs text-text-muted">{MOVE_COPY.noOtherMoves}</p>
        ) : others.length > VIRTUALIZE_OVER ? (
          <VirtualChangeList rows={others} />
        ) : (
          <div className="max-h-72 overflow-y-auto pr-1" data-testid="timeline-change-list" data-virtualized="false">
            <ul aria-label="Other projects that moved">
              {others.map((row) => (
                <li key={row.project_id}>
                  <ChangeRowItem row={row} />
                </li>
              ))}
            </ul>
          </div>
        )}
        {changes.hidden_count > 0 ? (
          <p className={cn('flex items-center gap-1.5 text-2xs font-semibold text-text-muted')} data-testid="timeline-hidden-count">
            <EyeOff className="size-3.5" aria-hidden="true" />+{changes.hidden_count} more in hubs outside your scope
          </p>
        ) : null}
      </section>
    </div>
  );
}

/**
 * The served change list on its own, with no "this project" section — for a
 * recalculation that was not caused by one project (the P12 weekly check-in
 * batch, ADR 0023). Same rows, same rendering, same virtualization rule.
 */
export function ChangedProjectsList({ changes }: { changes: ScheduleRunChanges }): React.JSX.Element {
  const rows = changes.rows;
  return (
    <section aria-label="Projects that moved" className="space-y-1" data-testid="changed-projects-list">
      <p className="text-2xs text-text-muted" data-numeric="">
        Run v{changes.run_version} compared with v{changes.against_run_version}
      </p>
      <h3 className="label-caps text-text-subtle">
        Projects that moved <span className="normal-case tracking-normal">({rows.length})</span>
      </h3>
      {rows.length === 0 ? (
        <p className="text-xs text-text-muted">No project you can see moved.</p>
      ) : rows.length > VIRTUALIZE_OVER ? (
        <VirtualChangeList rows={rows} />
      ) : (
        <div className="max-h-72 overflow-y-auto pr-1" data-testid="timeline-change-list" data-virtualized="false">
          <ul aria-label="Projects that moved">
            {rows.map((row) => (
              <li key={row.project_id}>
                <ChangeRowItem row={row} />
              </li>
            ))}
          </ul>
        </div>
      )}
      {changes.hidden_count > 0 ? (
        <p className="flex items-center gap-1.5 text-2xs font-semibold text-text-muted" data-testid="timeline-hidden-count">
          <EyeOff className="size-3.5" aria-hidden="true" />+{changes.hidden_count} more in hubs outside your scope
        </p>
      ) : null}
    </section>
  );
}

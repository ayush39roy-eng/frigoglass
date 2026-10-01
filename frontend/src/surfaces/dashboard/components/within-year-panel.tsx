import * as React from 'react';
import {
  CalendarCheck,
  CircleOff,
  CirclePause,
  Clock,
  FolderOpen,
  GanttChartSquare,
  type LucideIcon,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/shared/empty-state';
import { PriorityBandPill } from '@/components/shared/priority-band-pill';
import { ScheduleOutcomeBadge } from '@/components/shared/schedule-outcome-badge';
import { formatWeek } from '@/lib/format';
import { HORIZON_WEEKS } from '@/lib/domain-constants';
import { EntityCell, ProgressCell, RowActions } from '@/components/ui/table-cells';
import { outcomeOf, OUTCOME_STYLE, type OutcomeBucket } from '../lib/outcome';

import type { CompletingWithinYear, CompletingWithinYearRow, ScheduleRunSummary } from '../api/types';
import { CategoryTag } from '@/components/ui/category-tag';
import { ScheduleRunProvenance } from './schedule-run-provenance';
import { StatCard } from './stat-card';
import { VirtualDataTable, type VirtualColumn } from './virtual-data-table';

/**
 * The Invariant I9 surface region. Every figure here comes from a single field on
 * the `GET /dashboard/completing-within-year` response (which the backend sources
 * only from the active `ScheduleRun` snapshot) — nothing is recomputed here.
 */

function OutcomeCell({ row }: { row: CompletingWithinYearRow }): React.JSX.Element {
  return (
    <span className="flex flex-wrap items-center gap-1">
      {/* Blocked (P9-F02) is not one of the five ScheduleOutcomeFlag booking-rule
       * outcomes — it is the Project Workspace health-badge concept (ruling 5),
       * surfaced here on the same row. Same warning tone + icon as `HealthBadge`'s
       * `blocked` entry, rendered inline like the `within_year` badge below rather
       * than through `ScheduleOutcomeBadge`, since it isn't in that enum. */}
      {row.blocked ? (
        <Badge tone="warning">
          <CirclePause className="size-3" aria-hidden="true" />
          Blocked
        </Badge>
      ) : null}
      {row.within_year ? (
        <Badge tone="success">
          <CalendarCheck className="size-3" aria-hidden="true" />
          Within year
        </Badge>
      ) : null}
      {row.spillover ? <ScheduleOutcomeBadge flag="SPILLOVER" /> : null}
      {row.left_out ? <ScheduleOutcomeBadge flag="LEFT_OUT" /> : null}
      {row.cat_not_allowed ? <ScheduleOutcomeBadge flag="CAT_NOT_ALLOWED" iconOnly /> : null}
    </span>
  );
}

/** Icon disc per outcome — the coloured circle the reference table leads each row with. */
const OUTCOME_DISC: Record<OutcomeBucket, string> = {
  within_year: 'bg-success-subtle text-success-subtle-fg',
  spillover: 'bg-warning-subtle text-warning-subtle-fg',
  left_out: 'bg-danger-subtle text-danger-subtle-fg',
  blocked: 'bg-surface-sunken text-text',
  unresolved: 'bg-surface-sunken text-text-muted',
};

const OUTCOME_FILL: Record<OutcomeBucket, string> = {
  within_year: 'bg-success',
  spillover: 'bg-warning',
  left_out: 'bg-danger',
  blocked: 'bg-text-muted',
  unresolved: 'bg-border-strong',
};

const COLUMNS: VirtualColumn<CompletingWithinYearRow>[] = [
  {
    id: 'project',
    header: 'Project',
    width: 'minmax(11rem, 2fr)',
    cell: (row) => {
      const bucket = outcomeOf(row);
      return (
        <EntityCell
          icon={OUTCOME_STYLE[bucket].Icon as LucideIcon}
          iconClassName={OUTCOME_DISC[bucket]}
          title={row.project_name}
          titleAttr={row.project_name}
          to={`/projects/${row.project_id}`}
          subtitle={row.hub}
        />
      );
    },
  },
  {
    id: 'category',
    header: 'Cat.',
    width: '3.5rem',
    align: 'center',
    cell: (row) =>
      row.category ? (
        <CategoryTag category={row.category} />
      ) : (
        <span className="text-text-subtle">—</span>
      ),
  },
  {
    id: 'priority',
    header: 'Priority',
    width: '4rem',
    align: 'center',
    cell: (row) =>
      row.priority ? (
        <PriorityBandPill priority={row.priority} />
      ) : (
        <span className="text-text-subtle">—</span>
      ),
  },
  {
    id: 'end',
    header: 'Last step ends',
    width: 'minmax(7rem, 1.2fr)',
    cell: (row) =>
      row.last_step_end_week === null ? (
        <span className="text-text-subtle">—</span>
      ) : (
        <ProgressCell
          value={(row.last_step_end_week / HORIZON_WEEKS) * 100}
          fillClassName={OUTCOME_FILL[outcomeOf(row)]}
          label={formatWeek(row.last_step_end_week)}
          ariaLabel={`Last step ends ${formatWeek(row.last_step_end_week)} of ${formatWeek(HORIZON_WEEKS)}`}
        />
      ),
  },
  {
    id: 'outcome',
    header: 'Outcome',
    width: 'minmax(6.5rem, 1fr)',
    cell: (row) => <OutcomeCell row={row} />,
  },
  {
    id: 'actions',
    header: <span className="sr-only">Actions</span>,
    width: '2.5rem',
    align: 'right',
    cell: (row) => (
      <RowActions
        label={`Actions for ${row.project_name}`}
        actions={[
          { label: 'Open workspace', icon: FolderOpen, to: `/projects/${row.project_id}` },
          { label: 'View on timeline', icon: GanttChartSquare, to: '/timeline' },
        ]}
      />
    ),
  },
];

export interface WithinYearPanelProps {
  data: CompletingWithinYear;
  activeRun: ScheduleRunSummary | null | undefined;
}

/** Share of the run's four outcome buckets, as a display label ("29%"). */
function shareLabel(count: number, data: CompletingWithinYear): string {
  const total = data.within_year_count + data.spillover_count + data.left_out_count + data.blocked_count;
  if (total === 0) return '0%';
  return `${String(Math.round((count / total) * 100))}%`;
}

/**
 * Section heading + provenance chips + the four outcome KPI cards. Exported on
 * its own so the Dashboard can lay the KPI row and the outcome table out as two
 * separate boxes (Bold Blocks, 2026-10-01); `WithinYearPanel` below still
 * composes both for any caller that wants the original single block.
 */
export function WithinYearKpis({ data, activeRun }: WithinYearPanelProps): React.JSX.Element {
  return (
    <section className="space-y-s4">
      <div className="flex flex-wrap items-end justify-between gap-s3">
        <div>
          <h2 className="font-display text-h1 font-extrabold tracking-tight text-text">
            Completing within the year
          </h2>
          <p className="text-sm font-medium text-text-muted">
            Outcome of every project in the active schedule run
          </p>
        </div>
        {data.has_active_schedule_run ? (
          <ScheduleRunProvenance scheduleRunVersion={data.schedule_run_version} activeRun={activeRun} />
        ) : null}
      </div>

      {!data.has_active_schedule_run ? (
        <EmptyState
          title="No schedule computed yet"
          description="Counts appear here once the schedule is calculated."
        />
      ) : (
        <div className="grid gap-gutter sm:grid-cols-2 xl:grid-cols-4">
          {/* The one blue tile. "Within year" earns it: it is the number the whole
              application exists to produce. */}
          <StatCard
            variant="feature"
            label="Within year"
            value={data.within_year_count}
            icon={CalendarCheck}
            badge={{ label: `${shareLabel(data.within_year_count, data)} of run`, tone: 'pop' }}
            caption={`Complete by ${formatWeek(52)}`}
          />
          <StatCard
            label="Spillover"
            value={data.spillover_count}
            tone="warning"
            icon={Clock}
            badge={{ label: shareLabel(data.spillover_count, data), tone: 'neutral' }}
            caption={`Scheduled, finishing after ${formatWeek(52)}`}
          />
          <StatCard
            label="Left out"
            value={data.left_out_count}
            tone="danger"
            icon={CircleOff}
            badge={
              data.left_out_count > 0
                ? { label: shareLabel(data.left_out_count, data), tone: 'drop' }
                : null
            }
            caption="No feasible window in the 78-week horizon"
          />
          {/* P9-F02: mutually exclusive with the three counts above — Blocked
              wins outright, so a project is never double-counted across tiles.
              The ink tile is the contrasting second accent of the row. */}
          <StatCard
            variant="ink"
            label="Blocked"
            value={data.blocked_count}
            icon={CirclePause}
            badge={{ label: shareLabel(data.blocked_count, data), tone: data.blocked_count > 0 ? 'drop' : 'pop' }}
            caption="Held at a Blocked stage until it clears"
          />
        </div>
      )}
    </section>
  );
}

/** The per-project outcome table, in its own card. */
export function WithinYearTable({ data }: { data: CompletingWithinYear }): React.JSX.Element | null {
  if (!data.has_active_schedule_run) return null;
  if (data.rows.length === 0) {
    return (
      <EmptyState title="No projects in this run" description="No project outcomes in your hub scope." />
    );
  }
  return (
    <div className="flex h-full flex-col overflow-hidden rounded-dash border-[1.5px] border-dash-hairline bg-surface shadow-dashCard">
      <div className="flex items-center justify-between gap-s3 border-b-[1.5px] border-dash-hairline px-card py-s4">
        <div>
          <h3 className="font-display text-h2 font-bold tracking-tight text-text">Project outcomes</h3>
          <p className="text-xs font-medium text-text-subtle">Per-project result from the active run</p>
        </div>
        <span className="rounded-pill bg-text px-2.5 py-1 text-2xs font-bold text-text-inverse" data-numeric="">
          {data.rows.length} projects
        </span>
      </div>
      <div className="min-h-0 flex-1">
        <VirtualDataTable
          rows={data.rows}
          columns={COLUMNS}
          rowKey={(row) => row.project_id}
          caption="Per-project outcome from the active schedule run"
          estimateRowHeight={64}
          maxHeight={660}
          className="rounded-none border-0"
        />
      </div>
    </div>
  );
}

export function WithinYearPanel({ data, activeRun }: WithinYearPanelProps): React.JSX.Element {
  return (
    <div className="space-y-s4">
      <WithinYearKpis data={data} activeRun={activeRun} />
      <WithinYearTable data={data} />
    </div>
  );
}

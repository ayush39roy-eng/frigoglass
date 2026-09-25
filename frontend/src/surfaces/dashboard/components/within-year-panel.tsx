import * as React from 'react';
import { CalendarCheck, CircleOff, Clock } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/shared/empty-state';
import { PriorityBandPill } from '@/components/shared/priority-band-pill';
import { ScheduleOutcomeBadge } from '@/components/shared/schedule-outcome-badge';
import { formatWeek } from '@/lib/format';

import type { CompletingWithinYear, CompletingWithinYearRow, ScheduleRunSummary } from '../api/types';
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

const COLUMNS: VirtualColumn<CompletingWithinYearRow>[] = [
  {
    id: 'project',
    header: 'Project',
    width: 'minmax(12rem, 1.6fr)',
    cell: (row) => (
      <span className="truncate font-medium text-text" title={row.project_name}>
        {row.project_name}
      </span>
    ),
  },
  {
    id: 'hub',
    header: 'Hub',
    width: 'minmax(7rem, 1fr)',
    cell: (row) => <span className="truncate text-text-muted">{row.hub}</span>,
  },
  {
    id: 'category',
    header: 'Cat.',
    width: '4rem',
    align: 'center',
    cell: (row) =>
      row.category ? (
        <Badge tone="outline">{row.category}</Badge>
      ) : (
        <span className="text-text-subtle">—</span>
      ),
  },
  {
    id: 'priority',
    header: 'Priority',
    width: '5rem',
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
    width: '7rem',
    align: 'right',
    cell: (row) => (
      <span className="tnum text-text-muted" data-numeric="">
        {row.last_step_end_week === null ? '—' : formatWeek(row.last_step_end_week)}
      </span>
    ),
  },
  {
    id: 'outcome',
    header: 'Outcome',
    width: 'minmax(9rem, 1.2fr)',
    cell: (row) => <OutcomeCell row={row} />,
  },
];

export interface WithinYearPanelProps {
  data: CompletingWithinYear;
  activeRun: ScheduleRunSummary | null | undefined;
}

export function WithinYearPanel({ data, activeRun }: WithinYearPanelProps): React.JSX.Element {
  const runBadge =
    data.schedule_run_version === null
      ? null
      : `Run v${String(data.schedule_run_version)}`;

  return (
    /* SECTION, not a card.
     *
     * The KPI tiles and the outcome table are each already a card. Wrapping them in
     * a third card put white on white and cost the tiles their lift — the reference
     * dashboards never nest a card inside a card, they let tiles sit directly on the
     * ground. So the section keeps its heading and badge but drops its background,
     * border and shadow, and becomes pure structure. */
    <Card className="border-0 bg-transparent shadow-none">
      <CardHeader className="border-0 px-0">
        <CardTitle className="text-h1">Completing within the year</CardTitle>
        {runBadge ? <Badge tone="neutral">{runBadge}</Badge> : null}
      </CardHeader>
      <CardContent className="space-y-s4 px-0 pb-0">
        {!data.has_active_schedule_run ? (
          <EmptyState
            title="No schedule computed yet"
            description="No active schedule run exists. Once the schedule is calculated, the within-year, spillover and left-out counts will appear here — sourced directly from that run (Invariant I9)."
          />
        ) : (
          <>
            <ScheduleRunProvenance
              scheduleRunVersion={data.schedule_run_version}
              activeRun={activeRun}
            />

            <div className="grid gap-gutter sm:grid-cols-3">
              {/* The one emphasised tile on the Dashboard. "Within year" earns it:
                  it is the number the whole application exists to produce, and the
                  question every portfolio review opens with. */}
              <StatCard
                feature
                label="Within year"
                value={data.within_year_count}
                icon={CalendarCheck}
                caption={`Complete by ${formatWeek(52)}`}
              />
              <StatCard
                label="Spillover"
                value={data.spillover_count}
                tone="warning"
                icon={Clock}
                caption={`Scheduled, finishing after ${formatWeek(52)}`}
              />
              <StatCard
                label="Left out"
                value={data.left_out_count}
                tone="warning"
                icon={CircleOff}
                caption="No feasible window in the 78-week horizon"
              />
            </div>

            {data.rows.length === 0 ? (
              <EmptyState
                title="No projects in this run"
                description="The active schedule run produced no project outcomes in your hub scope."
              />
            ) : (
              /* The table carries its own card now that the section wrapper is
               * transparent. `overflow-hidden` clips the sticky header's top corners
               * to the card radius — without it the header paints square corners over
               * the rounded card and the join is visible on scroll. */
              <div className="overflow-hidden rounded-card border border-border bg-surface shadow-card">
                <VirtualDataTable
                  rows={data.rows}
                  columns={COLUMNS}
                  rowKey={(row) => row.project_id}
                  caption="Per-project outcome from the active schedule run"
                />
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

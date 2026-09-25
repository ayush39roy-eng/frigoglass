import * as React from 'react';
import { CircleCheck, TriangleAlert } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/shared/empty-state';
import { ScheduleRunProvenance } from '@/components/shared/schedule-run-provenance';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { formatDecimal, formatInteger } from '@/lib/format';

import type { HubCapacityRow, HubCapacitySummary, ScheduleRunSummary } from '../api/types';
import { HubLoadChart } from './hub-load-chart';

/**
 * "Load-vs-capacity charts per hub" (`docs/PROJECT_AND_STACK.md` §2).
 *
 * The TABLE is authoritative: every figure is rendered verbatim from
 * `GET /capacity/hub-load` — `design_load_weeks` / `lab_load_units` are the
 * Invariant I6 / I7 quantities sourced from the active schedule run; the
 * `*_capacity_*` columns are the backend's FTE-/efficiency-scaled reporting
 * estimate (ADR 0002 / 0003). Nothing is recomputed here. The charts under the
 * table are a scannability aid only.
 */

function CapacityCompareCell({
  load,
  capacity,
  unitLabel,
}: {
  load: number;
  capacity: number;
  unitLabel: string;
}): React.JSX.Element {
  const over = load > capacity;
  return (
    <span className="inline-flex items-center gap-1">
      {over ? (
        <Badge tone="warning" title={`Scheduled load exceeds the reporting-capacity estimate (${unitLabel})`}>
          <TriangleAlert className="size-3" aria-hidden="true" />
          Load &gt; reporting capacity
        </Badge>
      ) : (
        <Badge tone="neutral" title={`Scheduled load is within the reporting-capacity estimate (${unitLabel})`}>
          <CircleCheck className="size-3" aria-hidden="true" />
          Within reporting capacity
        </Badge>
      )}
    </span>
  );
}

export interface HubLoadPanelProps {
  data: HubCapacitySummary;
  activeRun: ScheduleRunSummary | null | undefined;
}

export function HubLoadPanel({ data, activeRun }: HubLoadPanelProps): React.JSX.Element {
  const runBadge =
    data.schedule_run_version === null ? null : `Run v${String(data.schedule_run_version)}`;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Load vs. capacity per hub</CardTitle>
        {runBadge ? <Badge tone="neutral">{runBadge}</Badge> : null}
      </CardHeader>
      <CardContent className="space-y-4">
        {!data.has_active_schedule_run ? (
          <EmptyState
            title="No schedule computed yet"
            description="No active schedule run exists. Once the schedule is calculated, per-hub design and lab load will appear here — sourced directly from that run (Invariants I6 / I7)."
          />
        ) : (
          <>
            <ScheduleRunProvenance
              scheduleRunVersion={data.schedule_run_version}
              activeRun={activeRun}
              leadIn="Load figures below are read directly from"
              affordanceLabel="How load and capacity are defined"
            >
              <span className="block space-y-1">
                <span className="block">
                  <strong>Design load</strong> = Σ design-step durations for the hub&rsquo;s
                  projects; <strong>lab load</strong> = Σ (lab-step durations &times; 0.5) &mdash;
                  both taken verbatim from the active run&rsquo;s booked steps (Invariants I6 / I7).
                </span>
                <span className="block">
                  <strong>Capacity</strong> is a reporting estimate: engineer-weeks scaled by FTE,
                  chamber-units scaled by efficiency, over the {formatInteger(data.remaining_weeks)}{' '}
                  weeks remaining in the horizon. The scheduler applies neither scaling (ADR&nbsp;0002
                  / 0003).
                </span>
                <span className="block">
                  None of it is recalculated in your browser.
                </span>
              </span>
            </ScheduleRunProvenance>

            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Hub</TableHead>
                    <TableHead className="text-right">Design load (wk)</TableHead>
                    <TableHead className="text-right">Design capacity (wk)</TableHead>
                    <TableHead className="text-right">Lab load (units)</TableHead>
                    <TableHead className="text-right">Lab capacity (units)</TableHead>
                    <TableHead>Design</TableHead>
                    <TableHead>Lab</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.rows.map((row: HubCapacityRow) => (
                    <TableRow key={row.hub}>
                      <TableCell className="font-medium text-text">{row.hub}</TableCell>
                      <TableCell className="text-right tnum text-text" data-numeric="">
                        {formatInteger(row.design_load_weeks)}
                      </TableCell>
                      <TableCell className="text-right tnum text-text-muted" data-numeric="">
                        {formatDecimal(row.design_capacity_weeks)}
                      </TableCell>
                      <TableCell className="text-right tnum text-text" data-numeric="">
                        {formatDecimal(row.lab_load_units)}
                      </TableCell>
                      <TableCell className="text-right tnum text-text-muted" data-numeric="">
                        {formatDecimal(row.lab_capacity_units)}
                      </TableCell>
                      <TableCell>
                        <CapacityCompareCell
                          load={row.design_load_weeks}
                          capacity={row.design_capacity_weeks}
                          unitLabel="engineer-weeks"
                        />
                      </TableCell>
                      <TableCell>
                        <CapacityCompareCell
                          load={row.lab_load_units}
                          capacity={row.lab_capacity_units}
                          unitLabel="chamber-units"
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {data.rows.length === 0 ? (
              <EmptyState
                title="No hubs in scope"
                description="The active schedule run produced no per-hub load in your hub scope."
              />
            ) : (
              <div className="grid gap-4 lg:grid-cols-2">
                <section className="space-y-1">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">
                    Design — engineer-weeks
                  </h3>
                  <HubLoadChart rows={data.rows} metric="design" />
                </section>
                <section className="space-y-1">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">
                    Lab — chamber-units
                  </h3>
                  <HubLoadChart rows={data.rows} metric="lab" />
                </section>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

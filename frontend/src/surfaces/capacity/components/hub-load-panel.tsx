import * as React from 'react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/shared/empty-state';
import { ScheduleRunProvenance } from '@/components/shared/schedule-run-provenance';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { CURRENT_WEEK, WITHIN_YEAR_WEEK } from '@/lib/domain-constants';

import type { HubCapacitySummary, ScheduleRunSummary } from '../api/types';
import { HubLoadChart } from './hub-load-chart';
import { HubSupplyBreakdown, type CapacityHorizon } from './hub-supply-breakdown';

/**
 * "Load-vs-capacity per hub" (`docs/PROJECT_AND_STACK.md` §2), presented the way
 * the client's workbook does (ADR 0008 / `docs/CLIENT_FORMULAS.md` §2): per hub,
 * Design and Lab, each with process-derived load (I6/I7 — the primary figure),
 * estimated load, capacity, gap and completion %, for the full year or the
 * remaining year. Every figure is rendered verbatim from `GET /capacity/hub-load`;
 * nothing is recomputed here (Invariant I17).
 */
export interface HubLoadPanelProps {
  data: HubCapacitySummary;
  activeRun: ScheduleRunSummary | null | undefined;
}

export function HubLoadPanel({ data, activeRun }: HubLoadPanelProps): React.JSX.Element {
  const [horizon, setHorizon] = React.useState<CapacityHorizon>('year');
  const runBadge =
    data.schedule_run_version === null ? null : `Run v${String(data.schedule_run_version)}`;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Load vs. capacity per hub</CardTitle>
        <div className="flex items-center gap-s2">
          {runBadge ? <Badge tone="neutral">{runBadge}</Badge> : null}
          {data.has_active_schedule_run ? (
            <ToggleGroup
              type="single"
              value={horizon}
              onValueChange={(v) => {
                if (v === 'year' || v === 'remaining') setHorizon(v);
              }}
              aria-label="Capacity horizon"
              size="sm"
            >
              <ToggleGroupItem value="year" aria-label="Full year">
                Full year
              </ToggleGroupItem>
              <ToggleGroupItem value="remaining" aria-label="Remaining year">
                Remaining year (W{CURRENT_WEEK}–W{WITHIN_YEAR_WEEK})
              </ToggleGroupItem>
            </ToggleGroup>
          ) : null}
        </div>
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
                  <strong>Design load</strong> = Σ design-step lead times for the hub&rsquo;s
                  projects; <strong>lab load</strong> = Σ lab-step lead times (&times; 1.0) for
                  the hub&rsquo;s lab region &mdash; both taken verbatim from the active
                  run&rsquo;s booked steps (Invariants I6 / I7, ADR&nbsp;0007). The
                  <strong> estimated</strong> load is the projects&rsquo; hand-entered
                  design / lab weeks, shown for comparison only.
                </span>
                <span className="block">
                  <strong>Capacity</strong> is the client&rsquo;s own supply formula
                  (ADR&nbsp;0008): working weeks per engineer &times; Σ FTE for design;
                  Σ (working weeks &times; efficiency &times; platforms) over the region&rsquo;s
                  chambers for lab. &ldquo;Remaining year&rdquo; scales by (52 &minus; current
                  week) / 52. Gap = load &minus; capacity; completion = capacity / load.
                </span>
                <span className="block">
                  All of it is computed server-side and shown to two decimals (Invariant I17);
                  none of it is recalculated in your browser.
                </span>
              </span>
            </ScheduleRunProvenance>

            {data.rows.length === 0 ? (
              <EmptyState
                title="No hubs in scope"
                description="The active schedule run produced no per-hub load in your hub scope."
              />
            ) : (
              <>
                <div className="grid gap-4 lg:grid-cols-2">
                  <section className="space-y-1">
                    <h3 className="label-caps text-text-muted">Design load per hub — engineer-weeks</h3>
                    <HubLoadChart rows={data.rows} metric="design" horizon={horizon} />
                  </section>
                  <section className="space-y-1">
                    <h3 className="label-caps text-text-muted">Lab load per hub — chamber-weeks</h3>
                    <HubLoadChart rows={data.rows} metric="lab" horizon={horizon} />
                  </section>
                </div>
                <HubSupplyBreakdown rows={data.rows} horizon={horizon} />
              </>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

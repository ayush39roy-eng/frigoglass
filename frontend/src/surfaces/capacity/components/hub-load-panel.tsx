import * as React from 'react';

import { BoltCard } from '@/components/ui/bolt-card';
import { CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/shared/empty-state';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { CURRENT_WEEK, WITHIN_YEAR_WEEK } from '@/lib/domain-constants';

import type { HubCapacitySummary, ScheduleRunSummary } from '../api/types';
import { CapacityInfo } from './capacity-info';
import { HubLoadChart } from './hub-load-chart';
import { HubSupplyBreakdown, type CapacityHorizon } from './hub-supply-breakdown';
import { RunProvenanceChips } from './run-provenance-chips';

/**
 * "Load-vs-capacity per hub" (`docs/PROJECT_AND_STACK.md` §2), presented the way
 * the client's workbook does (ADR 0008 / `docs/CLIENT_FORMULAS.md` §2): per hub,
 * Design and Lab, each with process-derived load (I6/I7 — the primary figure),
 * estimated load, capacity, gap and completion %, for the full year or the
 * remaining year. Every figure is rendered verbatim from `GET /capacity/hub-load`;
 * nothing is recomputed here (Invariant I17).
 *
 * The TABLE (`<HubSupplyBreakdown>`) remains authoritative for every figure: the
 * two `<HubLoadChart>` strips above it are a cross-hub ranking aid only, and the
 * load-vs-capacity figures they draw are the process-derived I6/I7 sums, NOT the
 * hand-entered reporting estimate shown beside them. That distinction is why the
 * estimate is rendered as a secondary, muted stat and never charted.
 *
 * TEXT CLEANUP 2026-10-01 (client feedback): the provenance SENTENCE and the
 * "How load and capacity are defined" dotted link that used to sit between this
 * card's header and its first figure are gone from the body. The three facts
 * they carried are now chips in the header (`<RunProvenanceChips>`, which keeps
 * the full sentence as `sr-only` text) and the definitions are in a
 * `<CapacityInfo>` popover under the same accessible name. No copy was deleted.
 */
export interface HubLoadPanelProps {
  data: HubCapacitySummary;
  activeRun: ScheduleRunSummary | null | undefined;
}

export function HubLoadPanel({ data, activeRun }: HubLoadPanelProps): React.JSX.Element {
  const [horizon, setHorizon] = React.useState<CapacityHorizon>('year');

  return (
    <BoltCard>
      <CardHeader className="flex-wrap gap-y-s2">
        <CardTitle>Load vs. capacity per hub</CardTitle>
        <div className="flex flex-wrap items-center gap-s2">
          {/* Provenance: three chips + an sr-only sentence, replacing the
              paragraph that used to sit below this header. Still conditional on
              there being an active run — there is no run to cite otherwise. */}
          {data.has_active_schedule_run ? (
            <RunProvenanceChips
              scheduleRunVersion={data.schedule_run_version}
              activeRun={activeRun}
              leadIn="Load figures in this card are read directly from"
            />
          ) : null}
          <CapacityInfo label="How load and capacity are defined">
            <p>
              <strong className="text-text">Design load</strong> = Σ design-step lead times for
              the hub&rsquo;s projects; <strong className="text-text">lab load</strong> = Σ
              lab-step lead times (&times;&nbsp;1.0) for the hub&rsquo;s lab region &mdash; both
              taken verbatim from the active run&rsquo;s booked steps (Invariants I6 / I7,
              ADR&nbsp;0007). The <strong className="text-text">estimated</strong> load is the
              projects&rsquo; hand-entered design / lab weeks, shown for comparison only.
            </p>
            <p>
              <strong className="text-text">Capacity</strong> is the client&rsquo;s own supply
              formula (ADR&nbsp;0008): working weeks per engineer &times; Σ FTE for design;
              Σ (working weeks &times; efficiency &times; platforms) over the region&rsquo;s
              chambers for lab. &ldquo;Remaining year&rdquo; scales by (52 &minus; current
              week) / 52. Gap = load &minus; capacity; completion = capacity / load.
            </p>
            <p>
              All of it is computed server-side and shown to two decimals (Invariant I17); none of
              it is recalculated in your browser.
            </p>
          </CapacityInfo>
          {data.has_active_schedule_run ? (
            <ToggleGroup
              type="single"
              value={horizon}
              onValueChange={(v) => {
                if (v === 'year' || v === 'remaining') setHorizon(v);
              }}
              aria-label="Capacity horizon"
              size="sm"
              // Boltshift pill geometry (999px radius), applied locally — the
              // shared `<ToggleGroup>` primitive keeps its own square-segmented
              // look for its other consumers (Gantt's zoom control, Workflow
              // Settings' steps tab), out of scope this task.
              className="gap-0.5 divide-x-0 rounded-pill border-dash-hairline bg-dash-alt p-0.5"
            >
              <ToggleGroupItem
                value="year"
                aria-label="Full year"
                className="rounded-pill data-[state=on]:shadow-sm"
              >
                Full year
              </ToggleGroupItem>
              <ToggleGroupItem
                value="remaining"
                aria-label="Remaining year"
                className="rounded-pill data-[state=on]:shadow-sm"
              >
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
            className="rounded-dash border-solid border-dash-hairline bg-dash-alt"
          />
        ) : (
          <>
            {data.rows.length === 0 ? (
              <EmptyState
                title="No hubs in scope"
                description="The active schedule run produced no per-hub load in your hub scope."
                className="rounded-dash border-solid border-dash-hairline bg-dash-alt"
              />
            ) : (
              <>
                <div className="grid gap-4 lg:grid-cols-2">
                  <section className="space-y-2 rounded-dash border border-dash-hairline bg-dash-alt p-card-tight">
                    <h3 className="label-caps text-text-muted">Design load per hub — engineer-weeks</h3>
                    <HubLoadChart rows={data.rows} metric="design" horizon={horizon} />
                  </section>
                  <section className="space-y-2 rounded-dash border border-dash-hairline bg-dash-alt p-card-tight">
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
    </BoltCard>
  );
}

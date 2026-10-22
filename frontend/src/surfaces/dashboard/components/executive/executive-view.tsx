import * as React from 'react';
import type { UseQueryResult } from '@tanstack/react-query';

import { SectionBoundary } from '@/components/shared/section-boundary';
import { PanelSkeleton } from '@/components/ui/panel-skeleton';
import { useVipBoard } from '@/lib/api/vip';
import { toHubFilterParams } from '@/stores/hub-filter';
import { usePermission } from '@/stores/session';
import type { LabRegion } from '@/types/enums';

import type {
  CompletingWithinYear,
  DashboardAnalytics,
  PipelineTotals,
  ScheduleRunSummary,
  StatusOverview,
} from '../../api/types';
import { useDashboardProjects } from '../../hooks/use-dashboard';
import { selectRiskRows } from '../../lib/executive';
import { DeliveryGaugeCard } from '../delivery-gauge-card';
import { ScheduleRunProvenance } from '../schedule-run-provenance';
import { StaggerSection } from '../stagger';
import { ExecKpiStrip } from './exec-kpi-strip';
import { RisksCard } from './risks-card';
import { UpcomingCompletionsCard } from './upcoming-completions-card';

/**
 * The Executive ("helicopter") view (P28, ADR 0039 §3): ONE compact page —
 * a KPI strip, a Portfolio-health row (two donuts + gauge + delivery-by-
 * priority, merged into one row per the owner's one-viewport brief), then
 * Risks beside Upcoming completions, and a provenance footer. Every figure is a served field
 * or one of the Detailed view's established presentation derivations (I9/I19);
 * see each child component's note.
 *
 * The two donuts live in `executive-donuts.tsx` behind `React.lazy`, so
 * Recharts stays OUT of the Dashboard route chunk (the same deferral as the
 * Detailed view's chart panels — see the long note in `DashboardPage.tsx`).
 * The gauge stays eager on purpose (hand-built SVG, same as Detailed).
 *
 * Data the Detailed view does not need — the VIP board and the project rows for
 * overdue check-ins — is fetched by hooks that mount only here, so switching
 * back to Detailed stops them (ADR 0039 §4). Owner ask 2026-10-23: "Hubs at a
 * glance" (and with it the view's `/capacity/hub-load` fetch) was removed and
 * replaced by "Upcoming completions", built from the already-served
 * within-year rows.
 */
const PipelineDonut = React.lazy(async () => ({
  default: (await import('./executive-charts')).PipelineDonut,
}));
const StatusDonut = React.lazy(async () => ({
  default: (await import('./executive-charts')).StatusDonut,
}));
const TypeBars = React.lazy(async () => ({
  default: (await import('./executive-charts')).TypeBars,
}));
const PriorityDeliveryChart = React.lazy(async () => ({
  default: (await import('./executive-charts')).PriorityDeliveryChart,
}));

export interface ExecutiveViewProps {
  withinYear: UseQueryResult<CompletingWithinYear, Error>;
  pipelineTotals: UseQueryResult<PipelineTotals, Error>;
  statusOverview: UseQueryResult<StatusOverview, Error>;
  analytics: UseQueryResult<DashboardAnalytics, Error>;
  activeRun: ScheduleRunSummary | null | undefined;
  hubId: string | null;
  region: LabRegion | null;
}

export function ExecutiveView({
  withinYear,
  pipelineTotals,
  statusOverview,
  analytics,
  activeRun,
  hubId,
  region,
}: ExecutiveViewProps): React.JSX.Element {
  // Executive-only fetches (mount-gated): the VIP board (KPI tile + VIP-at-risk
  // rows) and the register rows (served `tracking_status` for overdue check-ins)
  // — both under the global hub / country filter, no extra filters (ADR 0039 §3).
  const vipBoard = useVipBoard(toHubFilterParams(hubId, region));
  // VIP dialog edit mode follows the VIP card's rule (ADR 0027): MATRIX write.
  const canEditVip = usePermission('matrix').write;
  const projects = useDashboardProjects({
    hub_id: hubId ?? undefined,
    region: region ?? undefined,
  });

  const risks = React.useMemo(
    () =>
      selectRiskRows(
        withinYear.data?.rows ?? [],
        projects.data?.rows ?? [],
        vipBoard.data ?? null,
      ),
    [withinYear.data, projects.data, vipBoard.data],
  );

  const hasRun = withinYear.data?.has_active_schedule_run === true;

  return (
    <div className="flex flex-col gap-s5" data-testid="executive-view">
      {/* Owner reorder (2026-10-22, "move 2nd line to top"): the charts row
          leads the page; the KPI tile strip is the second row. Owner round 3:
          the two donuts are card-less HERO charts dominating the row, with the
          delivery gauge and priority bars stacked in a slimmer third column. */}
      <StaggerSection>
        <section aria-label="Portfolio health" className="grid gap-gutter md:grid-cols-2 xl:grid-cols-12">
          <div className="min-w-0 xl:col-span-4">
            <SectionBoundary
              query={pipelineTotals}
              title="Project pipeline"
              errorDescription="Pipeline totals could not be loaded."
            >
              {(totals) => (
                <React.Suspense fallback={<PanelSkeleton height="h-[16rem]" />}>
                  <PipelineDonut totals={totals} />
                </React.Suspense>
              )}
            </SectionBoundary>
          </div>
          <div className="min-w-0 xl:col-span-4">
            <SectionBoundary
              query={statusOverview}
              title="Status overview"
              errorDescription="Status overview counts could not be loaded."
            >
              {(data) => (
                <React.Suspense fallback={<PanelSkeleton height="h-[16rem]" />}>
                  <StatusDonut data={data} />
                </React.Suspense>
              )}
            </SectionBoundary>
          </div>
          {hasRun && withinYear.data ? (
            <>
              <div className="min-w-0 [&>*]:h-full xl:col-span-2">
                <DeliveryGaugeCard data={withinYear.data} compact />
              </div>
              <div className="min-w-0 [&>*]:h-full xl:col-span-2">
                <React.Suspense fallback={<PanelSkeleton height="h-48" />}>
                  <PriorityDeliveryChart bands={withinYear.data.priority_delivery} />
                </React.Suspense>
              </div>
            </>
          ) : null}
        </section>
      </StaggerSection>

      <StaggerSection>
        <SectionBoundary
          query={withinYear}
          title="Executive summary"
          errorDescription="The executive summary figures could not be loaded from the active schedule run."
        >
          {(data) => (
            <ExecKpiStrip
              data={data}
              pipelineTotal={pipelineTotals.data?.total_count ?? null}
              vipBoard={vipBoard.data ?? null}
              vipProjects={projects.data ? projects.data.rows.filter((r) => r.is_vip) : null}
              canEditVip={canEditVip}
            />
          )}
        </SectionBoundary>
      </StaggerSection>

      {/* Owner polish (2026-10-22): cards in this row size to their OWN content
          (items-start) — a short Risks list must never stretch into a
          half-empty card beside a taller sibling. */}
      <StaggerSection>
        <div className="grid items-start gap-gutter xl:grid-cols-12">
          <div className="min-w-0 xl:col-span-3">
            <RisksCard risks={risks} />
          </div>
          <div className="min-w-0 xl:col-span-6">
            <UpcomingCompletionsCard rows={withinYear.data?.rows ?? []} />
          </div>
          {/* Owner addendum: project types as a compact horizontal bar list. */}
          <div className="min-w-0 xl:col-span-3">
            <SectionBoundary
              query={analytics}
              title="Projects by type"
              errorDescription="The type breakdown could not be loaded."
            >
              {(data) => (
                <React.Suspense fallback={<PanelSkeleton height="h-48" />}>
                  <TypeBars buckets={data.by_type} />
                </React.Suspense>
              )}
            </SectionBoundary>
          </div>
        </div>
      </StaggerSection>

      {hasRun && withinYear.data ? (
        <StaggerSection>
          <footer className="flex justify-end" data-testid="exec-provenance">
            <ScheduleRunProvenance
              scheduleRunVersion={withinYear.data.schedule_run_version}
              activeRun={activeRun}
              showVersionChip
              showSolverChip
              showTimestampChip
            />
          </footer>
        </StaggerSection>
      ) : null}
    </div>
  );
}

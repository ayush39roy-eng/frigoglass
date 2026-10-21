import * as React from 'react';
import { motion } from 'framer-motion';

import { PageHeader } from '@/components/layout/page-header';
import { DownloadButton } from '@/components/shared/download-button';
import { SectionBoundary } from '@/components/shared/section-boundary';
import { SURFACES } from '@/app/nav';
import { ApiError } from '@/lib/api/client';
import { useMotionTokens } from '@/lib/motion';
import { useHubFilter } from '@/stores/hub-filter';
import { HubFilterChip } from '@/components/shared/hub-filter/hub-filter-chip';
import { CountrySegmented } from '@/components/shared/hub-filter/country-segmented';

import { DEFAULT_CAPACITY_VIEW, type CapacityView } from './lib/pick-figures';
import { AccessNotice } from './components/access-notice';
import { CapacityReportingNotice } from './components/capacity-reporting-notice';
import { ChamberUtilizationPanel } from './components/chamber-utilization-panel';
import type { LabRegion } from '@/types/enums';
import { ClassBreakdownPanel, ClassChartSection } from './components/class-breakdown-panel';
import { CapacityKpiRow } from './components/capacity-kpi-row';
import { CapacityToolbar } from './components/capacity-toolbar';
import { CollapsibleSection } from './components/collapsible-section';
import { HubBookingStrip } from './components/hub-booking-strip';
import { HubSummaryTable } from './components/hub-summary-table';
import { HubUtilizationMatrix } from './components/hub-utilization-matrix';
import { EngineerUtilizationPanel } from './components/engineer-utilization-panel';
import { LoadCapacityCharts } from './components/load-capacity-charts';
import { useActiveScheduleRun, useClassBreakdown, useHubLoadVsCapacity, useUtilizationMatrix } from './hooks/use-capacity';

const CAPACITY_SURFACE = SURFACES.find((s) => s.path === '/capacity');

/**
 * Page-mount stagger, same pattern as the Dashboard's own
 * (`surfaces/dashboard/DashboardPage.tsx`, 2026-09-30/2026-10-01): each
 * top-level panel fades/rises in shortly after the one before it, gated by
 * `useMotionTokens()`. Applied at the PAGE level wrapping each section from
 * the outside, so none of the panel components themselves needed any internal
 * change — their existing unit tests are untouched by this.
 */
const SECTION_VARIANTS = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0 },
} as const;

function StaggerSection({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { reduced, transition } = useMotionTokens();
  if (reduced) return <>{children}</>;
  return (
    <motion.div variants={SECTION_VARIANTS} transition={transition}>
      {children}
    </motion.div>
  );
}

function authKind(errors: unknown[]): 'forbidden' | 'unauthorized' | null {
  for (const err of errors) {
    if (err instanceof ApiError && err.isForbidden) return 'forbidden';
  }
  for (const err of errors) {
    if (err instanceof ApiError && err.isUnauthorized) return 'unauthorized';
  }
  return null;
}

/**
 * The chamber utilization matrix, behind its disclosure. The query lives HERE, not
 * on the page, so nothing is fetched until the section is opened.
 */
function ChamberSection({
  hubId,
  region,
  activeRun,
}: {
  hubId: string | null;
  region: LabRegion | null;
  activeRun: ReturnType<typeof useActiveScheduleRun>['data'];
}): React.JSX.Element {
  const utilization = useUtilizationMatrix(hubId, region);
  return (
    <SectionBoundary
      query={utilization}
      title="Resource utilization matrix"
      errorDescription="The chamber utilization matrix could not be loaded."
    >
      {(data) => <ChamberUtilizationPanel data={data} activeRun={activeRun} />}
    </SectionBoundary>
  );
}

export default function CapacityPage(): React.JSX.Element {
  // P12 (ADR 0020): the global header hub filter. The server filters hub rows;
  // lab figures stay region-wide (§4). Nothing is re-derived here. (P19-T02: the
  // served `areas[]` Europe / India roll-up is no longer shown, owner ruling.)
  const { hubId, region } = useHubFilter();
  const hubLoad = useHubLoadVsCapacity({ hubId, region });
  const classBreakdown = useClassBreakdown(hubId, region);

  const hasRun =
    hubLoad.data?.has_active_schedule_run === true || classBreakdown.data?.has_active_schedule_run === true;
  const activeRun = useActiveScheduleRun(hasRun);

  const title = CAPACITY_SURFACE?.title ?? 'RPD Capacity';
  const description =
    CAPACITY_SURFACE?.summary ??
    'Design and lab load vs. capacity per hub, reconciled to the week against the active schedule run (Invariants I6 / I7).';

  const denied = authKind([hubLoad.error, classBreakdown.error]);
  const motionTokens = useMotionTokens();

  /** The page's ONE view state (P19-T05): the horizon, YTD 2026 (= remaining
   *  year) / Full year (ADR 0008), and the unit, Weeks / Days. The header toggles
   *  write it; the KPI cards, charts, booked tiles, summary table, Details dialog
   *  and matrix all read it, and each shows the served field for it (I19). */
  const [view, setView] = React.useState<CapacityView>(DEFAULT_CAPACITY_VIEW);

  const hubData = hubLoad.data;
  const showRun = hubData?.has_active_schedule_run === true;

  return (
    <>
      <PageHeader
        title={title}
        description={description}
        actions={
          <>
            {denied ? null : <CapacityToolbar view={view} onViewChange={setView} />}
            <CountrySegmented />
            <HubFilterChip />
            {/* The surface-wide honest-framing callout (P4-T03): rendered for EVERY
                query state so the surface always carries this framing. */}
            <CapacityReportingNotice />
            {denied ? null : <DownloadButton path="/exports/capacity" fallbackFilename="capacity-export" />}
          </>
        }
      />

      {denied ? (
        <AccessNotice kind={denied} />
      ) : (
        <motion.div
          className="flex min-w-0 flex-col gap-s6"
          // `exactOptionalPropertyTypes`: spread no animation props at all under
          // reduced motion rather than passing explicit `undefined` values.
          {...(motionTokens.reduced
            ? {}
            : {
                initial: 'hidden',
                animate: 'show',
                variants: { show: { transition: { staggerChildren: 0.08 } } },
              })}
        >
          {/* 1. The client's four headline cards. */}
          {showRun && hubData.rows.length > 0 ? (
            <StaggerSection>
              <CapacityKpiRow totals={hubData.totals} rows={hubData.rows} view={view} />
            </StaggerSection>
          ) : null}

          {/* 2. Class cards: A+, A, B, C and the OEM classes, with per-hub counts. */}
          <StaggerSection>
            <SectionBoundary
              query={classBreakdown}
              title="Class breakdown — deliverable vs. left out"
              errorDescription="The A+/A/B/C deliverable vs. left-out breakdown could not be loaded."
            >
              {(data) => <ClassBreakdownPanel data={data} />}
            </SectionBoundary>
          </StaggerSection>

          {/* 3. Load vs capacity charts. */}
          {showRun && hubData.rows.length > 0 ? (
            <StaggerSection>
              <LoadCapacityCharts rows={hubData.rows} view={view} />
            </StaggerSection>
          ) : null}

          {/* 4. Capacity booked: one tile per hub, design + its lab region (ADR 0016; hubs only, P19-T02). */}
          {showRun && hubData.rows.length > 0 ? (
            <StaggerSection>
              <HubBookingStrip rows={hubData.rows} view={view} />
            </StaggerSection>
          ) : null}

          {/* 5. One compact table; per-hub detail is behind each row's Details dialog. */}
          <StaggerSection>
            <SectionBoundary
              query={hubLoad}
              title="Load vs. capacity per hub"
              errorDescription="Per-hub load and capacity could not be loaded from the active schedule run."
            >
              {(data) => <HubSummaryTable data={data} activeRun={activeRun.data} view={view} />}
            </SectionBoundary>
          </StaggerSection>

          {/* 6. The hub utilization matrix, inline and expanded (P19-T02, owner ruling). It is
              built from the hub-load rows already on the page, so it fetches nothing extra. */}
          {showRun && hubData.rows.length > 0 ? (
            <StaggerSection>
              <section aria-label="Global resource utilization matrix" data-testid="section-hub-matrix">
                <HubUtilizationMatrix rows={hubData.rows} totals={hubData.totals} view={view} />
              </section>
            </StaggerSection>
          ) : null}

          {/* 7. The class chart (P19-T05, owner ruling: moved down from under the class cards),
              then chamber and engineer utilization. All collapsed and lazy: nothing renders
              or fetches until opened. The class chart reuses the class-breakdown data already
              on the page. */}
          <div className="flex flex-col gap-s3" data-testid="capacity-more-detail">
            {classBreakdown.data ? <ClassChartSection data={classBreakdown.data} /> : null}
            <CollapsibleSection
              showLabel="Show chamber utilization"
              hint="Concurrent projects per chamber per week"
              testId="section-chambers"
            >
              <ChamberSection hubId={hubId} region={region} activeRun={activeRun.data} />
            </CollapsibleSection>
            <CollapsibleSection
              showLabel="Show engineer utilization"
              hint="Named per-engineer weekly load (personal data; read only when opened)"
              testId="section-engineers"
            >
              <EngineerUtilizationPanel />
            </CollapsibleSection>
          </div>
        </motion.div>
      )}
    </>
  );
}

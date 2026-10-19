import * as React from 'react';
import { motion } from 'framer-motion';

import { FlaskConical, PenTool } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { MeterCard, StatStrip } from '@/components/ui/stat-variants';
import { DownloadButton } from '@/components/shared/download-button';
import { SectionBoundary } from '@/components/shared/section-boundary';
import { SURFACES } from '@/app/nav';
import { ApiError } from '@/lib/api/client';
import { formatDecimal } from '@/lib/format';
import { useMotionTokens } from '@/lib/motion';
import { useHubFilter } from '@/stores/hub-filter';
import { HubFilterChip } from '@/components/shared/hub-filter/hub-filter-chip';
import { CountrySegmented } from '@/components/shared/hub-filter/country-segmented';

import { labRegionRows } from './lib/lab-region-rows';
import { pickAreaFigures, type CapacityHorizon } from './lib/pick-figures';
import { AreaBookingStrip } from './components/area-booking-strip';
import { AccessNotice } from './components/access-notice';
import { CapacityReportingNotice } from './components/capacity-reporting-notice';
import { ChamberUtilizationPanel } from './components/chamber-utilization-panel';
import { ClassBreakdownPanel } from './components/class-breakdown-panel';
import { HubLoadPanel } from './components/hub-load-panel';
import { HubUtilizationMatrix } from './components/hub-utilization-matrix';
import { EngineerUtilizationPanel } from './components/engineer-utilization-panel';
import { KpiCaptions } from './components/kpi-captions';
import {
  useActiveScheduleRun,
  useClassBreakdown,
  useHubLoadVsCapacity,
  useUtilizationMatrix,
} from './hooks/use-capacity';

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

export default function CapacityPage(): React.JSX.Element {
  // P12 (ADR 0020): the global header hub filter. The server filters hub rows
  // and narrows `areas[]` to the area containing the hub; lab figures stay
  // region-wide (§4). Nothing is re-derived here.
  const { hubId, region } = useHubFilter();
  const hubLoad = useHubLoadVsCapacity({ hubId, region });
  const classBreakdown = useClassBreakdown(hubId, region);
  const utilization = useUtilizationMatrix(hubId, region);

  const hasRun =
    hubLoad.data?.has_active_schedule_run === true ||
    classBreakdown.data?.has_active_schedule_run === true ||
    utilization.data?.has_active_schedule_run === true;
  const activeRun = useActiveScheduleRun(hasRun);

  const title = CAPACITY_SURFACE?.title ?? 'RPD Capacity';
  const description =
    CAPACITY_SURFACE?.summary ??
    'Design and lab load vs. capacity per hub, reconciled to the week against the active schedule run (Invariants I6 / I7).';

  const denied = authKind([hubLoad.error, classBreakdown.error, utilization.error]);
  const motionTokens = useMotionTokens();

  /** Full year / Remaining year (ADR 0008). Lifted here so the P11 area strip,
   *  the KPI row, the per-hub card and the matrix show the same served horizon. */
  const [horizon, setHorizon] = React.useState<CapacityHorizon>('year');

  // P13-T11 addendum: the headline totals are SERVED (`totals`: design per hub,
  // lab once per lab region, booked % and status — I9/I19). The browser no
  // longer sums hub rows; it only selects the horizon's fields.
  const totals = hubLoad.data?.totals;
  const designTotals = totals ? pickAreaFigures(totals, 'design', horizon) : null;
  const labTotals = totals ? pickAreaFigures(totals, 'lab', horizon) : null;
  const hubLoadRows = hubLoad.data?.rows;
  // Lab figures are region-level, so the lab caption lists regions (selection only).
  const labRegions = React.useMemo(() => (hubLoadRows ? labRegionRows(hubLoadRows) : []), [hubLoadRows]);

  return (
    <>
      <PageHeader
        title={title}
        description={description}
        actions={
          <>
            {/* The surface-wide honest-framing callout (P4-T03). Rendered for
                EVERY query state — including `denied`, where it costs nothing,
                and `pending`, which is what keeps "the surface always carries
                this framing" true. It used to be a four-paragraph aside below
                this header; see `capacity-reporting-notice.tsx`. */}
            <CountrySegmented />
            <HubFilterChip />
            <CapacityReportingNotice />
            {denied ? null : (
              <DownloadButton path="/exports/capacity" fallbackFilename="capacity-export" />
            )}
          </>
        }
      />

      {denied ? (
        <AccessNotice kind={denied} />
      ) : (
        <motion.div
          className="flex flex-col gap-s6"
          // `exactOptionalPropertyTypes`: spread no animation props at all under
          // reduced motion rather than passing explicit `undefined` values —
          // same pattern as the Dashboard's own page-mount stagger.
          {...(motionTokens.reduced
            ? {}
            : {
                initial: 'hidden',
                animate: 'show',
                variants: { show: { transition: { staggerChildren: 0.08 } } },
              })}
        >
          {/* P11 (ADR 0016): Europe / India booked % — served figures only (I19). */}
          {hubLoad.data?.has_active_schedule_run && hubLoad.data.areas.length > 0 ? (
            <StaggerSection>
              <AreaBookingStrip areas={hubLoad.data.areas} horizon={horizon} />
            </StaggerSection>
          ) : null}

          {hubLoad.data?.has_active_schedule_run && classBreakdown.data && totals && designTotals && labTotals ? (
            <StaggerSection>
              <div className="grid gap-gutter lg:grid-cols-[1fr_1fr_1.1fr]">
                <MeterCard
                  label="Design load"
                  value={designTotals.load}
                  capacity={designTotals.capacity}
                  servedPct={designTotals.bookedPct}
                  unit="engineer-wks"
                  icon={PenTool}
                  accent="primary"
                  formatValue={formatDecimal}
                  footer={
                    <KpiCaptions
                      label="Design load"
                      split={totals.design_load_by_priority}
                      partsLabel="By hub"
                      parts={hubLoad.data.rows.map((r) => ({ key: r.hub, label: r.hub, value: r.design_load_weeks }))}
                    />
                  }
                />
                <MeterCard
                  label="Lab load"
                  value={labTotals.load}
                  capacity={labTotals.capacity}
                  servedPct={labTotals.bookedPct}
                  unit="chamber-wks"
                  icon={FlaskConical}
                  accent="success"
                  formatValue={formatDecimal}
                  footer={
                    <KpiCaptions
                      label="Lab load"
                      split={totals.lab_load_by_priority}
                      partsLabel="By lab region"
                      parts={labRegions.map((l) => ({ key: l.region, label: l.region, value: l.row.lab_load_weeks }))}
                    />
                  }
                />
                <StatStrip
                  ariaLabel="Deliverable versus left-out projects"
                  className="md:grid-flow-row md:grid-cols-2"
                  segments={[
                    {
                      label: 'Deliverable',
                      value: classBreakdown.data.rows.reduce((n, r) => n + r.deliverable_count, 0),
                      accent: 'success',
                      hint: 'Across every category',
                    },
                    {
                      label: 'Left out',
                      value: classBreakdown.data.rows.reduce((n, r) => n + r.left_out_count, 0),
                      accent: 'danger',
                      // ADR 0024: not done by W52 — spillover, framed on the 52-week year
                      // (the served `remaining_weeks` counts to the scheduler's internal
                      // 78-week search horizon, which the UI never presents).
                      hint: 'Not placed — spillover past W52',
                    },
                  ]}
                />
              </div>
            </StaggerSection>
          ) : null}

          <StaggerSection>
            <SectionBoundary
              query={hubLoad}
              title="Load vs. capacity per hub"
              errorDescription="Per-hub load and capacity could not be loaded from the active schedule run."
            >
              {(data) => (
                <HubLoadPanel data={data} activeRun={activeRun.data} horizon={horizon} onHorizonChange={setHorizon} />
              )}
            </SectionBoundary>
          </StaggerSection>

          <StaggerSection>
            <SectionBoundary
              query={classBreakdown}
              title="Class breakdown — deliverable vs. left out"
              errorDescription="The A+/A/B/C deliverable vs. left-out breakdown could not be loaded."
            >
              {(data) => <ClassBreakdownPanel data={data} />}
            </SectionBoundary>
          </StaggerSection>

          {hubLoad.data?.has_active_schedule_run && hubLoad.data.rows.length > 0 ? (
            <StaggerSection>
              <HubUtilizationMatrix rows={hubLoad.data.rows} totals={hubLoad.data.totals} horizon={horizon} />
            </StaggerSection>
          ) : null}

          <StaggerSection>
            <SectionBoundary
              query={utilization}
              title="Resource utilization matrix"
              errorDescription="The chamber utilization matrix could not be loaded."
            >
              {(data) => <ChamberUtilizationPanel data={data} activeRun={activeRun.data} />}
            </SectionBoundary>
          </StaggerSection>

          <StaggerSection>
            <EngineerUtilizationPanel />
          </StaggerSection>
        </motion.div>
      )}
    </>
  );
}

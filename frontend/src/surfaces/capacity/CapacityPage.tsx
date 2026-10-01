import * as React from 'react';
import { motion } from 'framer-motion';

import { FlaskConical, PenTool } from 'lucide-react';
import { PageHeader } from '@/components/layout/page-header';
import { MeterCard, StatStrip } from '@/components/ui/stat-variants';
import { DownloadButton } from '@/components/shared/download-button';
import { SectionBoundary } from '@/components/shared/section-boundary';
import { SURFACES } from '@/app/nav';
import { ApiError } from '@/lib/api/client';
import { useMotionTokens } from '@/lib/motion';

import { AccessNotice } from './components/access-notice';
import { CapacityReportingNotice } from './components/capacity-reporting-notice';
import { ChamberUtilizationPanel } from './components/chamber-utilization-panel';
import { ClassBreakdownPanel } from './components/class-breakdown-panel';
import { HubLoadPanel } from './components/hub-load-panel';
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
  const hubLoad = useHubLoadVsCapacity();
  const classBreakdown = useClassBreakdown();
  const utilization = useUtilizationMatrix();

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
          {hubLoad.data?.has_active_schedule_run && classBreakdown.data ? (
            <StaggerSection>
              <div className="grid gap-gutter lg:grid-cols-[1fr_1fr_1.1fr]">
                <MeterCard
                  label="Design load"
                  value={Math.round(hubLoad.data.rows.reduce((n, r) => n + r.design_load_weeks, 0))}
                  capacity={Math.round(hubLoad.data.rows.reduce((n, r) => n + r.design_capacity_year, 0))}
                  unit="engineer-wks"
                  icon={PenTool}
                  accent="primary"
                />
                <MeterCard
                  label="Lab load"
                  value={Math.round(hubLoad.data.rows.reduce((n, r) => n + r.lab_load_weeks, 0))}
                  capacity={Math.round(hubLoad.data.rows.reduce((n, r) => n + r.lab_capacity_year, 0))}
                  unit="chamber-wks"
                  icon={FlaskConical}
                  accent="success"
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
                      hint: `${String(hubLoad.data.remaining_weeks)} wks left`,
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
              {(data) => <HubLoadPanel data={data} activeRun={activeRun.data} />}
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

          <StaggerSection>
            <SectionBoundary
              query={utilization}
              title="Resource utilization matrix"
              errorDescription="The chamber utilization matrix could not be loaded."
            >
              {(data) => <ChamberUtilizationPanel data={data} activeRun={activeRun.data} />}
            </SectionBoundary>
          </StaggerSection>
        </motion.div>
      )}
    </>
  );
}

import * as React from 'react';
import { motion } from 'framer-motion';

import { PageHeader } from '@/components/layout/page-header';
import { SURFACES } from '@/app/nav';
import { ApiError } from '@/lib/api/client';
import { useMotionTokens } from '@/lib/motion';

import {
  useCompletingWithinYear,
  useHubTypePipeline,
  usePipelineTotals,
  useStatusOverview,
  useActiveScheduleRun,
} from './hooks/use-dashboard';
import { AccessNotice } from './components/access-notice';
import { HubGlobePanel } from './components/hub-globe-panel';
import { HubTypePipelineTable } from './components/hub-type-pipeline-table';
import { PipelinePanel } from './components/pipeline-panel';
import { ProjectBreakdown } from './components/project-breakdown';
import { SectionBoundary } from '@/components/shared/section-boundary';
import { StatusOverviewCards } from './components/status-overview-cards';
import { WithinYearPanel } from './components/within-year-panel';

const DASHBOARD_SURFACE = SURFACES.find((s) => s.path === '/');

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
 * Page-mount stagger (Dashboard polish, 2026-09-30): each top-level section
 * fades/rises in a few milliseconds after the one before it, so the eye is
 * guided down the page instead of every panel popping in at once. Gated by
 * `useMotionTokens()` — the shared `prefers-reduced-motion` switch every other
 * animated element in the app reads from (`lib/motion.ts`) — and applied at
 * the PAGE level, wrapping each section from the outside, so none of the
 * individual section components (`WithinYearPanel`, `StatusOverviewCards`, …)
 * needed their own internal DOM changed; their existing unit tests are
 * untouched by this.
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

export default function DashboardPage(): React.JSX.Element {
  const withinYear = useCompletingWithinYear();
  const pipelineTotals = usePipelineTotals();
  const statusOverview = useStatusOverview();
  const hubTypePipeline = useHubTypePipeline();
  const activeRun = useActiveScheduleRun(withinYear.data?.has_active_schedule_run === true);
  const motionTokens = useMotionTokens();

  const title = DASHBOARD_SURFACE?.title ?? 'Global RPD Dashboard';
  const description =
    DASHBOARD_SURFACE?.summary ??
    'Portfolio-wide view sourced from the active schedule run (Invariant I9).';

  const denied = authKind([
    withinYear.error,
    pipelineTotals.error,
    statusOverview.error,
    hubTypePipeline.error,
  ]);

  return (
    <>
      <PageHeader title={title} description={description} />

      {denied ? (
        <AccessNotice kind={denied} />
      ) : (
        <motion.div
          className="flex flex-col gap-4"
          // `exactOptionalPropertyTypes`: an explicit `undefined` isn't
          // assignable to these (non-optional-union) framer-motion props, so
          // the reduced-motion case spreads no animation props at all rather
          // than passing `undefined` values.
          {...(motionTokens.reduced
            ? {}
            : {
                initial: 'hidden',
                animate: 'show',
                variants: { show: { transition: { staggerChildren: 0.08 } } },
              })}
        >
          <StaggerSection>
            <div className="grid gap-4 xl:grid-cols-2">
              <SectionBoundary
                query={withinYear}
                title="Completing within the year"
                errorDescription="The within-year completion figures could not be loaded from the active schedule run."
              >
                {(data) => <WithinYearPanel data={data} activeRun={activeRun.data} />}
              </SectionBoundary>

              <SectionBoundary
                query={pipelineTotals}
                title="Pipeline & completion"
                errorDescription="Pipeline totals could not be loaded."
              >
                {(totals) => <PipelinePanel totals={totals} withinYear={withinYear.data ?? null} />}
              </SectionBoundary>
            </div>
          </StaggerSection>

          <StaggerSection>
            <SectionBoundary
              query={statusOverview}
              title="Status overview"
              errorDescription="Status overview counts could not be loaded."
            >
              {(data) => <StatusOverviewCards data={data} />}
            </SectionBoundary>
          </StaggerSection>

          <StaggerSection>
            <SectionBoundary
              query={hubTypePipeline}
              title="Hub × type pipeline"
              errorDescription="The hub × type pipeline summary could not be loaded."
            >
              {(data) => (
                <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
                  <HubTypePipelineTable rows={data} />
                  <HubGlobePanel rows={data} />
                </div>
              )}
            </SectionBoundary>
          </StaggerSection>

          <StaggerSection>
            <ProjectBreakdown />
          </StaggerSection>
        </motion.div>
      )}
    </>
  );
}

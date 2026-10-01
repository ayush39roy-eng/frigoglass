import * as React from 'react';
import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { ArrowUpRight, GanttChartSquare, Gauge as GaugeIcon } from 'lucide-react';

import { PageHeader } from '@/components/layout/page-header';
import { SURFACES } from '@/app/nav';
import { GlowOverlay } from '@/components/ui/background-components';
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
import { CompletionProfileCard } from './components/completion-profile-card';
import { HubRankList } from './components/hub-rank-list';
import { ProjectSpotlight } from './components/project-spotlight';
import { HubTypePipelineTable } from './components/hub-type-pipeline-table';
import { PipelinePanel } from './components/pipeline-panel';
import { ProjectBreakdown } from './components/project-breakdown';
import { SectionBoundary } from '@/components/shared/section-boundary';
import { StatusOverviewCards } from './components/status-overview-cards';
import { WithinYearKpis, WithinYearTable } from './components/within-year-panel';
import { DeliveryGaugeCard } from './components/delivery-gauge-card';
import { PlanningClockCard } from './components/planning-clock-card';
import { PortfolioAnalytics } from './components/portfolio-analytics';
import { Button } from '@/components/ui/button';

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
 * Page-mount stagger (Dashboard polish, 2026-09-30; retuned 2026-10-01 to the
 * Boltshift motion spec): each top-level section fades/rises in a few
 * milliseconds after the one before it, so the eye is guided down the page
 * instead of every panel popping in at once. Gated by `useMotionTokens()` — the
 * shared `prefers-reduced-motion` switch every other animated element in the app
 * reads from (`lib/motion.ts`) — and applied at the PAGE level, wrapping each
 * section from the outside, so none of the individual section components
 * (`WithinYearPanel`, `StatusOverviewCards`, …) needed their own internal DOM
 * changed; their existing unit tests are untouched by this.
 *
 * Boltshift's mount vocabulary is `y: 16 → 0` + opacity + `scale: 0.985 → 1` on
 * a `{stiffness: 300, damping: 30}` spring. The scale is on the SECTION
 * (everything settling into place together), never on an individual card hover
 * — the spec's own "DO NOT" list bans that, and `stat-card.tsx` / the spotlight
 * cards accordingly hover on `y` alone.
 */
const SECTION_VARIANTS = {
  hidden: { opacity: 0, y: 16, scale: 0.985 },
  show: { opacity: 1, y: 0, scale: 1 },
} as const;

const SECTION_SPRING = { type: 'spring', stiffness: 300, damping: 30 } as const;

function StaggerSection({ children }: { children: React.ReactNode }): React.JSX.Element {
  const { reduced } = useMotionTokens();
  if (reduced) return <>{children}</>;
  return (
    <motion.div variants={SECTION_VARIANTS} transition={SECTION_SPRING}>
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
  /**
   * Client text cleanup, 2026-10-01: the page used to print `SURFACES[].summary`
   * verbatim — a 180-character paragraph naming every figure on the page and
   * citing Invariant I9 — directly under the title. The client asked for "the
   * heading and the details one" only, with everything else living inside a
   * card. The full sentence is NOT lost: `nav.ts`'s `summary` is byte-unchanged
   * (the sidebar/command surfaces still read it), and the I9 provenance it cited
   * is now stated precisely, per card, by the info popovers and the schedule-run
   * chip row — closer to the numbers it describes than a page-level paragraph
   * ever was.
   */
  const description = 'Portfolio status for the active schedule run.';

  const denied = authKind([
    withinYear.error,
    pipelineTotals.error,
    statusOverview.error,
    hubTypePipeline.error,
  ]);

  return (
    <div className="relative">
      <GlowOverlay light />
      <div className="relative z-10">
        <PageHeader
          eyebrow="Plan · Overview"
          title={title}
          description={description}
          actions={
            <>
              <Button
                asChild
                variant="secondary"
                className="rounded-pill border-[1.5px] font-semibold"
              >
                <Link to="/capacity">
                  <GaugeIcon aria-hidden="true" />
                  Capacity view
                </Link>
              </Button>
              <Button asChild className="rounded-pill font-semibold shadow-feature">
                <Link to="/timeline">
                  <GanttChartSquare aria-hidden="true" />
                  Open timeline
                  <ArrowUpRight aria-hidden="true" />
                </Link>
              </Button>
            </>
          }
        />

        {denied ? (
          <AccessNotice kind={denied} />
        ) : (
          <motion.div
            className="flex flex-col gap-s8"
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
            {/* Row 1 — the four outcome KPI cards, full width. */}
            <StaggerSection>
              <SectionBoundary
                query={withinYear}
                title="Completing within the year"
                errorDescription="The within-year completion figures could not be loaded from the active schedule run."
              >
                {(data) => <WithinYearKpis data={data} activeRun={activeRun.data} />}
              </SectionBoundary>
            </StaggerSection>

            {/* Row 2 — completion curve beside the two feature cards. Profile and
                gauge read the SAME completing-within-year payload (one fetch,
                several reads), so they render only once it has resolved; the
                boundary above shows its skeleton/error meanwhile. */}
            <StaggerSection>
              <div className="grid gap-gutter xl:grid-cols-12">
                <div className="min-w-0 xl:col-span-8 [&>*]:h-full">
                  {withinYear.data?.has_active_schedule_run ? (
                    <CompletionProfileCard
                      data={withinYear.data}
                      horizonWeeks={activeRun.data?.horizon_weeks ?? null}
                    />
                  ) : null}
                </div>
                <div className="min-w-0 xl:col-span-4 [&>*]:h-full">
                  {withinYear.data?.has_active_schedule_run ? (
                    <DeliveryGaugeCard data={withinYear.data} />
                  ) : (
                    <PlanningClockCard />
                  )}
                </div>
              </div>
            </StaggerSection>

            {/* Row 3 — the per-project table beside pipeline composition. */}
            <StaggerSection>
              <div className="grid gap-gutter xl:grid-cols-12">
                {withinYear.data?.has_active_schedule_run ? (
                  <div className="h-[34rem] min-w-0 xl:col-span-7 xl:h-auto xl:min-h-[34rem]">
                    <WithinYearTable data={withinYear.data} />
                  </div>
                ) : null}
                <div
                  className={
                    withinYear.data?.has_active_schedule_run
                      ? 'flex min-w-0 flex-col gap-gutter xl:col-span-5'
                      : 'min-w-0 xl:col-span-12'
                  }
                >
                  {withinYear.data?.has_active_schedule_run ? <PlanningClockCard /> : null}
                  <SectionBoundary
                    query={pipelineTotals}
                    title="Pipeline & completion"
                    errorDescription="Pipeline totals could not be loaded."
                  >
                    {(totals) => (
                      <PipelinePanel totals={totals} withinYear={withinYear.data ?? null} />
                    )}
                  </SectionBoundary>
                </div>
              </div>
            </StaggerSection>

            {withinYear.data?.has_active_schedule_run && withinYear.data.rows.length > 0 ? (
              <StaggerSection>
                <PortfolioAnalytics rows={withinYear.data.rows} />
              </StaggerSection>
            ) : null}

            <StaggerSection>
              <SectionBoundary
                query={statusOverview}
                title="Status overview"
                errorDescription="Status overview counts could not be loaded."
              >
                {(data) => <StatusOverviewCards data={data} />}
              </SectionBoundary>
            </StaggerSection>

            {withinYear.data && withinYear.data.rows.length > 0 ? (
              <StaggerSection>
                <ProjectSpotlight
                  rows={withinYear.data.rows}
                  horizonWeeks={activeRun.data?.horizon_weeks ?? null}
                />
              </StaggerSection>
            ) : null}

            <StaggerSection>
              <SectionBoundary
                query={hubTypePipeline}
                title="Hub × type pipeline"
                errorDescription="The hub × type pipeline summary could not be loaded."
              >
                {(data) => (
                  <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
                    <HubTypePipelineTable rows={data} />
                    <HubRankList rows={data} />
                  </div>
                )}
              </SectionBoundary>
            </StaggerSection>

            <StaggerSection>
              <ProjectBreakdown />
            </StaggerSection>
          </motion.div>
        )}
      </div>
    </div>
  );
}

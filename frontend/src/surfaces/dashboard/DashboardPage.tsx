import * as React from 'react';
import { motion } from 'framer-motion';
import { Link } from 'react-router-dom';
import { ArrowUpRight, FolderKanban, GanttChartSquare, Gauge as GaugeIcon, List } from 'lucide-react';

import { PageHeader } from '@/components/layout/page-header';
import { SURFACES } from '@/app/nav';
import { GlowOverlay } from '@/components/ui/background-components';
import { formatInteger } from '@/lib/format';
import { ApiError } from '@/lib/api/client';
import { useMotionTokens } from '@/lib/motion';
import { usePermission } from '@/stores/session';
import { useHubFilter } from '@/stores/hub-filter';
import { HubFilterChip } from '@/components/shared/hub-filter/hub-filter-chip';
import { CountrySegmented } from '@/components/shared/hub-filter/country-segmented';

import {
  useCompletingWithinYear,
  useDashboardAnalytics,
  useHubTypePipeline,
  usePipelineTotals,
  useStatusOverview,
  useActiveScheduleRun,
  useRegionSummary,
} from './hooks/use-dashboard';
import { AccessNotice } from './components/access-notice';
import { HubRankList } from './components/hub-rank-list';
import { HubTypePipelineTable } from './components/hub-type-pipeline-table';
import { PipelinePanel } from './components/pipeline-panel';
import { ScheduledCountInfo } from './components/scheduled-count-info';
import { PipelineRow } from './components/pipeline-row';
import { ProjectBreakdown } from './components/project-breakdown';
import { SectionBoundary } from '@/components/shared/section-boundary';
import { StatusOverviewCards } from './components/status-overview-cards';
import { WithinYearKpis, WithinYearTable } from './components/within-year-panel';
import { DeliveryGaugeCard } from './components/delivery-gauge-card';
import { PlanningClockCard } from './components/planning-clock-card';
import { CapacityBookedCard } from './components/capacity-booked-card';
import { VipProjectsCard } from './components/vip/vip-projects-card';
import { Button } from '@/components/ui/button';
import { PanelSkeleton } from '@/components/ui/panel-skeleton';

/**
 * Deferred analytics panels (2026-10-01).
 *
 * `completion-profile-card.tsx` and `portfolio-analytics.tsx` are the Dashboard's
 * only two Recharts consumers, and `project-spotlight.tsx` is its largest
 * non-chart panel. Importing them at module scope made Recharts (≈353 KB raw /
 * ≈103 KB gzip — by far the biggest third-party module in the app) a STATIC
 * import of the Dashboard route chunk, so the browser downloaded and executed all
 * of it before the page could paint, and so did every test that merely renders the
 * app shell at "/" — even when no chart ends up on screen at all (no active
 * schedule run, a 403, or an unresolved query all render zero charts).
 *
 * `React.lazy` moves each one behind its own `import()`, so the chart code is
 * fetched only once the data that needs it has actually arrived. The fallback is
 * the shared skeleton (`ui-ux-pro-max`: skeletons, never spinners, for
 * above-the-fold regions), sized to the panel it replaces so the layout does not
 * jolt when the real panel swaps in.
 *
 * `DeliveryGaugeCard` and `PlanningClockCard` stay EAGER on purpose: they are
 * hand-built SVG/CSS, ~5 KB and ~4 KB of source with no dependency beyond
 * framer-motion and lucide (both already in the chunk), and one or the other is on
 * screen in every state of this page. Splitting them would buy nothing and cost an
 * extra request on the common path.
 */
const CompletionProfileCard = React.lazy(async () => ({
  default: (await import('./components/completion-profile-card')).CompletionProfileCard,
}));
const PortfolioAnalytics = React.lazy(async () => ({
  default: (await import('./components/portfolio-analytics')).PortfolioAnalytics,
}));
// P13-T10: the "Analytics & breakdown" section is a Recharts consumer too.
const AnalyticsBreakdown = React.lazy(async () => ({
  default: (await import('./components/analytics-breakdown')).AnalyticsBreakdown,
}));

const DASHBOARD_SURFACE = SURFACES.find((s) => s.path === '/');

/** The header's "All projects" button (ADR 0025 §5): scroll to the register
 *  and move focus there, instantly under reduced motion. */
function scrollToRegister(reduced: boolean): void {
  const target = document.getElementById('all-projects');
  if (!target) return;
  target.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'start' });
  if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
  target.focus({ preventScroll: true });
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
  // P12 (ADR 0020): every Dashboard figure follows the global header hub filter;
  // the server filters and totals (I9/I19/I23), the browser only renders.
  // P13 (ADR 0025): and the country filter beside it.
  const { hubId, region } = useHubFilter();
  const withinYear = useCompletingWithinYear(hubId, region);
  const pipelineTotals = usePipelineTotals(hubId, region);
  const statusOverview = useStatusOverview(hubId, region);
  const hubTypePipeline = useHubTypePipeline(hubId, region);
  // Per-country chips under the KPI cards (contract §2). Optional enrichment:
  // the cards render without it, so its error never blanks a card.
  const regionSummary = useRegionSummary(hubId, region);
  // P13-T10 (API_CONTRACT_P13 §5): served breakdowns + completing Hub × Type.
  const analytics = useDashboardAnalytics(hubId, region);
  const activeRun = useActiveScheduleRun(withinYear.data?.has_active_schedule_run === true);
  const motionTokens = useMotionTokens();
  const canReadCapacity = usePermission('capacity').read;

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

  const totalProjectsCount = withinYear.data?.has_active_schedule_run
    ? withinYear.data.within_year_count +
      withinYear.data.spillover_count +
      withinYear.data.left_out_count +
      withinYear.data.blocked_count
    : (pipelineTotals.data?.total_count ?? null);

  // The chip counts the schedule run's projects only when a run is active; then it
  // is a subset of the pipeline and must say "scheduled" (P17-R05). Cancelled /
  // On Hold are served status-overview counts, shown verbatim in the popover.
  const scheduledSubset = withinYear.data?.has_active_schedule_run === true;
  const cancelledCount = statusOverview.data
    ? (statusOverview.data.other_statuses_counts['Cancelled'] ?? 0)
    : null;
  const onHoldCount = statusOverview.data?.on_hold_count ?? null;

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
              <CountrySegmented />
              <HubFilterChip />
              {totalProjectsCount !== null ? (
                <div
                  data-numeric=""
                  data-testid="dashboard-total-projects"
                  className="flex items-center gap-2.5 rounded-pill border-2 border-primary/25 bg-surface py-1.5 pl-4 pr-2 shadow-dashCard transition-all hover:border-primary/50"
                >
                  <span className="grid size-8 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
                    <FolderKanban className="size-4.5" aria-hidden="true" />
                  </span>
                  <span className="flex items-baseline gap-1.5 leading-none">
                    <span className="font-display text-2xl sm:text-3xl font-black tracking-tight text-text tabular-nums">
                      {formatInteger(totalProjectsCount)}
                    </span>
                    <span className="text-xs font-bold uppercase tracking-wider text-text-muted">
                      {scheduledSubset ? 'scheduled' : totalProjectsCount === 1 ? 'project' : 'projects'}
                    </span>
                  </span>
                  {scheduledSubset ? (
                    <ScheduledCountInfo
                      scheduled={totalProjectsCount}
                      pipelineTotal={pipelineTotals.data?.total_count ?? null}
                      cancelled={cancelledCount}
                      onHold={onHoldCount}
                      label="About the scheduled project count (header)"
                    />
                  ) : (
                    <span className="w-2" aria-hidden="true" />
                  )}
                </div>
              ) : null}
              <Button
                type="button"
                variant="secondary"
                className="rounded-pill border-[1.5px] font-semibold"
                onClick={() => scrollToRegister(motionTokens.reduced)}
              >
                <List aria-hidden="true" />
                All projects
              </Button>
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
            {/* P17 (ADR 0030): Spillover + Newly registered + Unregistered = Total. */}
            <StaggerSection>
              <SectionBoundary
                query={pipelineTotals}
                title="Project pipeline"
                errorDescription="Pipeline totals could not be loaded."
              >
                {(totals) => <PipelineRow totals={totals} regionSummary={regionSummary.data ?? null} />}
              </SectionBoundary>
            </StaggerSection>

            <StaggerSection>
              <SectionBoundary
                query={statusOverview}
                title="Status overview"
                errorDescription="Status overview counts could not be loaded."
              >
                {(data) => <StatusOverviewCards data={data} regionSummary={regionSummary.data ?? null} />}
              </SectionBoundary>
            </StaggerSection>

            {/* Row 1 — the four outcome KPI cards, full width. */}
            <StaggerSection>
              <SectionBoundary
                query={withinYear}
                title="Completing within the year"
                errorDescription="The within-year completion figures could not be loaded from the active schedule run."
              >
                {(data) => (
                  <WithinYearKpis
                    data={data}
                    activeRun={activeRun.data}
                    pipelineTotal={pipelineTotals.data?.total_count ?? null}
                    cancelled={cancelledCount}
                    onHold={onHoldCount}
                  />
                )}
              </SectionBoundary>
            </StaggerSection>

            {/* P14 (ADR 0027 §6): VIP projects per country, after the KPI cards. */}
            <StaggerSection>
              <VipProjectsCard />
            </StaggerSection>

            {/* Row 2 — completion curve beside the two feature cards. Profile and
                gauge read the SAME completing-within-year payload (one fetch,
                several reads), so they render only once it has resolved; the
                boundary above shows its skeleton/error meanwhile. */}
            <StaggerSection>
              <div className="grid gap-gutter xl:grid-cols-12">
                <div className="min-w-0 xl:col-span-8 [&>*]:h-full">
                  {withinYear.data?.has_active_schedule_run ? (
                    <React.Suspense fallback={<PanelSkeleton height="h-[22rem]" />}>
                      <CompletionProfileCard data={withinYear.data} />
                    </React.Suspense>
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
                  <PipelinePanel withinYear={withinYear.data ?? null} />
                  {/* P11 (ADR 0016): compact Europe / India booked %, only for a
                      session that can read Capacity (no fetch otherwise). */}
                  {canReadCapacity ? <CapacityBookedCard /> : null}
                </div>
              </div>
            </StaggerSection>

            {withinYear.data?.has_active_schedule_run && withinYear.data.rows.length > 0 ? (
              <StaggerSection>
                <React.Suspense fallback={<PanelSkeleton height="h-[24rem]" />}>
                  <PortfolioAnalytics
                    rows={withinYear.data.rows}
                    priorityDelivery={withinYear.data.priority_delivery}
                  />
                </React.Suspense>
              </StaggerSection>
            ) : null}

            {/* P13 (ADR 0025 §5): the full-width all-projects register sits
                directly after the status overview. */}
            <StaggerSection>
              <ProjectBreakdown />
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
                    <HubRankList rows={data} />
                  </div>
                )}
              </SectionBoundary>
            </StaggerSection>

            {/* P13-T10: "Analytics & breakdown" after the hub × type pipeline. */}
            <StaggerSection>
              <SectionBoundary
                query={analytics}
                title="Analytics & breakdown"
                errorDescription="The analytics breakdown could not be loaded."
              >
                {(data) => (
                  <React.Suspense fallback={<PanelSkeleton height="h-[40rem]" />}>
                    <AnalyticsBreakdown data={data} pipelineTotal={pipelineTotals.data?.total_count} />
                  </React.Suspense>
                )}
              </SectionBoundary>
            </StaggerSection>
          </motion.div>
        )}
      </div>
    </div>
  );
}

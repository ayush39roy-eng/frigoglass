import * as React from 'react';
import { motion } from 'framer-motion';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowUpRight, FolderKanban, GanttChartSquare, Gauge as GaugeIcon, List } from 'lucide-react';

import { PageHeader } from '@/components/layout/page-header';
import { SURFACES } from '@/app/nav';
import { GlowOverlay } from '@/components/ui/background-components';
import { formatInteger } from '@/lib/format';
import { cn } from '@/lib/utils';
import { useKeepScrollAnchor } from '@/lib/use-keep-scroll-anchor';
import { ApiError } from '@/lib/api/client';
import { useMotionTokens } from '@/lib/motion';
import { useHubFilter } from '@/stores/hub-filter';
import { useSessionStore } from '@/stores/session';
import { HubFilterChip } from '@/components/shared/hub-filter/hub-filter-chip';
import { CountrySegmented } from '@/components/shared/hub-filter/country-segmented';

import {
  readStoredDashboardView,
  resolveDashboardView,
  storeDashboardView,
  type DashboardView,
} from './lib/view-mode';
import {
  useCompletingWithinYear,
  useDashboardAnalytics,
  useHubTypePipeline,
  usePipelineTotals,
  useStatusOverview,
  useActiveScheduleRun,
  useRegionSummary,
  useCrossFilterBreakdowns,
} from './hooks/use-dashboard';
import { useDashboardSelection } from './lib/selection';
import { DashboardSelectionBar } from './components/dashboard-selection-bar';
import { AccessNotice } from './components/access-notice';
import { ExecutiveView } from './components/executive/executive-view';
import { DashboardViewToggle } from './components/executive/view-toggle';
import { HubTypeSection } from './components/hub-type-section';
import { ScheduledCountInfo } from './components/scheduled-count-info';
import { PipelineRow } from './components/pipeline-row';
import { ProjectBreakdown } from './components/project-breakdown';
import { SectionBoundary } from '@/components/shared/section-boundary';
import { StaggerSection } from './components/stagger';
import { StatusOverviewCards } from './components/status-overview-cards';
import { WithinYearKpis } from './components/within-year-panel';
import { DeliveryGaugeCard } from './components/delivery-gauge-card';
import { VipProjectsCard } from './components/vip/vip-projects-card';
import { Button } from '@/components/ui/button';
import { PanelSkeleton } from '@/components/ui/panel-skeleton';

/**
 * Deferred analytics panels (2026-10-01).
 *
 * `completion-profile-card.tsx` and `portfolio-analytics.tsx` are the Dashboard's
 * only two Recharts consumers. Importing them at module scope made Recharts (≈353 KB raw /
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
 * `DeliveryGaugeCard` stays EAGER on purpose: it is hand-built SVG/CSS, ~5 KB of
 * source with no dependency beyond framer-motion and lucide (both already in the
 * chunk). Splitting it would buy nothing and cost an extra request on the common
 * path.
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

// The page-mount stagger (Boltshift motion spec) moved to
// `./components/stagger.tsx` in P28 so the Executive view shares it verbatim.

export default function DashboardPage(): React.JSX.Element {
  // P28 (ADR 0039 §2): Executive | Detailed. Precedence: URL `view` param →
  // localStorage `rpd-dashboard-view` → role default (roles exactly
  // ["Executive Viewer"] → Executive). Toggling writes BOTH the URL param
  // (deep-linkable) and the stored per-user choice.
  const [searchParams, setSearchParams] = useSearchParams();
  const roles = useSessionStore((s) => s.me?.roles ?? []);
  const view = resolveDashboardView(searchParams.get('view'), readStoredDashboardView(), roles);
  const setView = React.useCallback(
    (next: DashboardView): void => {
      storeDashboardView(next);
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev);
          params.set('view', next);
          return params;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );
  const executive = view === 'executive';
  // P12 (ADR 0020): every Dashboard figure follows the global header hub filter;
  // the server filters and totals (I9/I19/I23), the browser only renders.
  // P13 (ADR 0025): and the country filter beside it.
  const { hubId, region } = useHubFilter();
  // P31: the Dashboard-wide category / type selection (URL), sent with every
  // Dashboard request in both views; the donuts and the bar below edit it.
  const selection = useDashboardSelection();
  const withinYear = useCompletingWithinYear(hubId, region, selection);
  const pipelineTotals = usePipelineTotals(hubId, region, selection);
  const statusOverview = useStatusOverview(hubId, region, selection);
  const hubTypePipeline = useHubTypePipeline(hubId, region, selection);
  // Per-country chips under the KPI cards (contract §2). Optional enrichment:
  // the cards render without it, so its error never blanks a card.
  const regionSummary = useRegionSummary(hubId, region, selection);
  // P13-T10 (API_CONTRACT_P13 §5): served breakdowns + completing Hub × Type.
  const analytics = useDashboardAnalytics(hubId, region, selection);
  // P31 cross-filter: each selectable donut's own served distribution.
  const breakdowns = useCrossFilterBreakdowns(hubId, region, selection);
  // A hub / country change keeps the previous figures on screen (placeholderData)
  // so the page holds its scroll position; dim it until every section is current.
  // …and hold the section the reader is on in place while the layout settles.
  const sectionsRef = React.useRef<HTMLDivElement>(null);
  useKeepScrollAnchor(
    sectionsRef,
    `${hubId ?? ''}|${region ?? ''}|${selection.categories.join(',')}|${selection.types.join(',')}`,
  );
  const refreshing = [
    withinYear,
    pipelineTotals,
    statusOverview,
    hubTypePipeline,
    regionSummary,
    analytics,
    breakdowns.type.analytics,
    breakdowns.category.analytics,
  ].some((q) => q.isPlaceholderData);
  const activeRun = useActiveScheduleRun(withinYear.data?.has_active_schedule_run === true);
  const motionTokens = useMotionTokens();

  const title = DASHBOARD_SURFACE?.title ?? 'Global RPD Dashboard';
  // Owner ask 2026-10-22: no description line under the title (it repeated the
  // cards); the header is one compact band (PageHeader `aside`).

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
          aside={<CountrySegmented />}
          actions={
            <>
              <DashboardViewToggle view={view} onChange={setView} />
              <HubFilterChip />
              {totalProjectsCount !== null ? (
                <div
                  data-numeric=""
                  data-testid="dashboard-total-projects"
                  className="flex items-center gap-2 rounded-pill border-2 border-primary/25 bg-surface py-1 pl-3 pr-1.5 shadow-dashCard transition-all hover:border-primary/50"
                >
                  <span className="grid size-7 shrink-0 place-items-center rounded-full bg-primary/10 text-primary">
                    <FolderKanban className="size-4" aria-hidden="true" />
                  </span>
                  <span className="flex items-baseline gap-1.5 leading-none">
                    <span className="font-display text-2xl font-black tracking-tight text-text tabular-nums">
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
              {/* The register lives on the Detailed view only (ADR 0039 §3); its
                  scroll shortcut would point at nothing in Executive. */}
              {!executive ? (
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="rounded-pill border-[1.5px] font-semibold"
                  onClick={() => scrollToRegister(motionTokens.reduced)}
                >
                  <List aria-hidden="true" />
                  All projects
                </Button>
              ) : null}
              <Button
                asChild
                variant="secondary"
                size="sm"
                className="rounded-pill border-[1.5px] font-semibold"
              >
                <Link to="/capacity">
                  <GaugeIcon aria-hidden="true" />
                  Capacity view
                </Link>
              </Button>
              <Button asChild size="sm" className="rounded-pill font-semibold shadow-feature">
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
          <>
          <DashboardSelectionBar selection={selection} />
          <motion.div
            className={cn('flex flex-col gap-s8 transition-opacity duration-base', refreshing && 'opacity-60')}
            aria-busy={refreshing}
            data-testid="dashboard-sections"
            ref={sectionsRef}
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
            {executive ? (
              /* P28 (ADR 0039): the Executive ("helicopter") view — a second
                 presentation of the SAME served payloads. Its extra reads
                 (VIP board, register rows for overdue check-ins, and
                 /capacity/hub-load) are fetched by hooks mounted only inside
                 it, so they stop when the toggle returns to Detailed. */
              <ExecutiveView
                withinYear={withinYear}
                pipelineTotals={pipelineTotals}
                statusOverview={statusOverview}
                analytics={analytics}
                activeRun={activeRun.data}
                hubId={hubId}
                region={region}
                selection={selection}
                breakdowns={breakdowns}
              />
            ) : (
              <>
            {/* P17 (ADR 0030): Spillover + Newly registered + Unregistered = Total.
                P17-R08: the compact VIP column sits beside it (xl), so VIP is
                above the fold; below xl it stacks under the pipeline row. */}
            <StaggerSection>
              <div className="grid grid-cols-[minmax(0,1fr)] gap-gutter xl:grid-cols-12">
                <div className="min-w-0 xl:col-span-8">
                  <SectionBoundary
                    query={pipelineTotals}
                    title="Project pipeline"
                    errorDescription="Pipeline totals could not be loaded."
                  >
                    {(totals) => <PipelineRow totals={totals} regionSummary={regionSummary.data ?? null} />}
                  </SectionBoundary>
                </div>
                {/* P14 (ADR 0027 §6): VIP projects per country, compact. */}
                <div className="relative min-w-0 xl:col-span-4">
                  <VipProjectsCard fill />
                </div>
              </div>
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

            {/* Completion profile + delivery rate, straight after Status overview
                (owner ask 2026-10-22). Profile and gauge read the SAME
                completing-within-year payload (one fetch, several reads), so they
                render only once it has resolved; the KPI boundary below shows its
                skeleton/error meanwhile. */}
            {withinYear.data?.has_active_schedule_run ? (
              <StaggerSection>
                <div className="grid gap-gutter xl:grid-cols-12">
                  <div className="min-w-0 xl:col-span-8 [&>*]:h-full">
                    <React.Suspense fallback={<PanelSkeleton height="h-[22rem]" />}>
                      <CompletionProfileCard data={withinYear.data} />
                    </React.Suspense>
                  </div>
                  <div className="min-w-0 xl:col-span-4 [&>*]:h-full">
                    <DeliveryGaugeCard data={withinYear.data} />
                  </div>
                </div>
              </StaggerSection>
            ) : null}

            {/* The outcome KPI cards, compact: their figures repeat the profile
                and gauge above (owner ask 2026-10-22). */}
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
                    compact
                  />
                )}
              </SectionBoundary>
            </StaggerSection>

            {/* P17-R08: Project pipeline summary | Completing within year (Hub ×
                Type tables with drill-down), then Pipeline vs completing. */}
            <StaggerSection>
              <HubTypeSection
                hubTypePipeline={hubTypePipeline}
                analytics={analytics}
                withinYear={withinYear.data ?? null}
                pipelineTotal={pipelineTotals.data?.total_count ?? null}
                hubId={hubId}
                region={region}
              />
            </StaggerSection>

            {/* P23-T03 (owner ask 2026-10-22): the Dashboard "Capacity booked"
                card (Europe / India booked %) is gone; booked % lives per hub on
                the RPD Capacity page. The DETAILED view never asks for
                GET /capacity/hub-load — the Executive view's "Hubs at a glance"
                does, lazily, while it is shown (ADR 0039 §4, owner-sanctioned
                narrowing of P23-T03). */}

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

            {/* P13-T10: "Analytics & breakdown" (the four composition charts). */}
            <StaggerSection>
              <SectionBoundary
                query={analytics}
                title="Analytics & breakdown"
                errorDescription="The analytics breakdown could not be loaded."
              >
                {(data) => (
                  <React.Suspense fallback={<PanelSkeleton height="h-[40rem]" />}>
                    <AnalyticsBreakdown
                      data={data}
                      pipelineTotal={pipelineTotals.data?.total_count}
                      typeBuckets={breakdowns.type.analytics.data?.by_type}
                      categoryBuckets={breakdowns.category.analytics.data?.by_category}
                      categoryTotal={breakdowns.category.totals.data?.total_count}
                      selection={selection}
                    />
                  </React.Suspense>
                )}
              </SectionBoundary>
            </StaggerSection>

            {/* P17-R08: the all-projects register is the LAST section. */}
            <StaggerSection>
              <ProjectBreakdown />
            </StaggerSection>
              </>
            )}
          </motion.div>
          </>
        )}
      </div>
    </div>
  );
}

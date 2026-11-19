import * as React from 'react';
import { Info, RefreshCw } from 'lucide-react';

import { PageHeader } from '@/components/layout/page-header';
import { StatStrip } from '@/components/ui/stat-variants';
import { SectionBoundary } from '@/components/shared/section-boundary';
import { ScheduleRunProvenance } from '@/components/shared/schedule-run-provenance';
import { DownloadButton } from '@/components/shared/download-button';
import { selectionParam } from '@/lib/multi-select-filter';
import { EmptyState } from '@/components/shared/empty-state';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ReadOnlyNotice } from '@/components/session/write-gate';
import { PriorityMoveProvider } from '@/components/shared/priority-move/priority-move-provider';
import { ApiError } from '@/lib/api/client';
import { editFreshness } from '@/lib/use-edit-freshness';
import { useAnyEditInProgress, useEditSession } from '@/stores/edit-session';
import { hasHubSelection, useHubFilter, useHubSelection, type HubSelection } from '@/stores/hub-filter';
import { HubFilterChip } from '@/components/shared/hub-filter/hub-filter-chip';
import { PlanWeekNotice } from '@/components/shared/plan-week-notice';
import { formatInteger } from '@/lib/format';
import { WITHIN_YEAR_WEEK } from '@/lib/domain-constants';
import { useCurrentWeek, usePlanYearLabels } from '@/lib/plan-clock';
import { SURFACES } from '@/app/nav';
import { usePermission, useSessionStore } from '@/stores/session';
import { useDebouncedValue } from '@/lib/use-debounced-value';

import { AccessNotice, FreezeForbiddenNotice } from './components/access-notice';
import { GanttChart } from './components/gantt-chart';
import { GanttLegend } from './components/gantt-legend';
import { FreezeDialog } from './components/freeze-dialog';
import { ZoomControl } from './components/zoom-control';
import { GanttFilterBar, ViewToggles } from './components/gantt-toolbar';
import { DEFAULT_GANTT_FILTERS, hasActiveFilters, type GanttFilterState } from './lib/gantt-filters';
import { useActiveScheduleRun, useGantt, useGanttFacets, useToggleFreeze } from './hooks/use-gantt';
import { useGanttUrlFilters } from './hooks/use-gantt-url-filters';
import type { GanttQueryParams } from './api/gantt-api';
import type { FreezeToggleRequest, GanttProjectRow } from './api/types';
import { ZOOM_DEFAULT_PX } from './lib/gantt-coordinates';
import { STEP_PINS_MAX } from './api/step-pins-api';
import { StepPinEditProvider, useStepPinDraftState } from './hooks/use-step-pin-edit';
import { conflictMatchesPin, useStepPinSave } from './hooks/use-step-pin-save';
import { pinKey } from './lib/step-pin-drafts';
import { StepPinDiscardDialog, StepPinEditBar, StepPinLeaveGuard } from './components/step-pin-edit-bar';
import { StepPinSavePanel } from './components/step-pin-save-panel';
import { StepCountChips } from './components/step-count-chips';

/** Owner 2026-11-18: the Gantt charts toggle is remembered per browser. */
const SHOW_DETAILS_STORAGE_KEY = 'rpd.gantt.showDetails';

function readShowDetails(): boolean {
  try {
    const v = window.localStorage.getItem(SHOW_DETAILS_STORAGE_KEY);
    return v === null ? true : v !== 'false';
  } catch {
    return true;
  }
}

function writeShowDetails(next: boolean): void {
  try {
    window.localStorage.setItem(SHOW_DETAILS_STORAGE_KEY, String(next));
  } catch {
    // Storage unavailable (private mode, quota): the choice lasts for this view only.
  }
}

/** Space the timeline card keeps below its chart (card padding + page gutter). */
const CHART_BOTTOM_RESERVE_PX = 56;
const CHART_MIN_HEIGHT_PX = 320;

/**
 * Owner ask 2026-11-13 (floating filters): the chart's height is the surface
 * region's height minus the floating filter card, so that once the page has
 * scrolled the chart up to the card, the whole chart — its sticky week axis
 * included — is on screen and further scrolling happens inside the chart.
 * Re-measured when the region or the card resizes. Layout only.
 */
function useChartHeightBelow(card: HTMLElement | null): number | undefined {
  const [height, setHeight] = React.useState<number | undefined>(undefined);
  React.useLayoutEffect(() => {
    const region = card?.closest<HTMLElement>('[data-testid="surface-region"]');
    if (!card || !region) return undefined;
    const read = () => {
      const available = region.clientHeight - card.getBoundingClientRect().height - CHART_BOTTOM_RESERVE_PX;
      setHeight(Math.max(CHART_MIN_HEIGHT_PX, Math.round(available)));
    };
    read();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(read);
    ro.observe(card);
    ro.observe(region);
    return () => { ro.disconnect(); };
  }, [card]);
  return height;
}

/** P13-T13: the toolbar state as server params; unset filters are left out
 *  (`undefined`), so they are neither sent nor distinct in the cache key. */
function toQueryParams(hub: HubSelection, f: GanttFilterState, q: string): GanttQueryParams {
  const trimmed = q.trim();
  return {
    hubIds: selectionParam(hub.hubIds),
    regions: selectionParam(hub.regions),
    q: trimmed === '' ? undefined : trimmed,
    category: selectionParam(f.category),
    type: selectionParam(f.type),
    // Multi-select (owner ask 2026-11-13): repeated params, ORed by the server.
    status: selectionParam(f.status),
    leaderEngineerId: selectionParam(f.leaderEngineerId),
    currentStep: selectionParam(f.currentStep),
    priority: selectionParam(f.priority),
    sort: f.sort,
    // P40-T03c: the steps the run did not place are listed too, so their
    // Start / End weeks can be typed (API_CONTRACT_P40 §2).
    includeUnplaced: true,
  };
}

/** The "On the timeline" hint for the hub selection (labels only, no figure). */
function hubHint(hub: HubSelection): string {
  if (!hasHubSelection(hub)) return 'All hubs';
  if (hub.hubIds.length === 0 && hub.regions.length === 1) return hub.regions[0] ?? 'Selected country';
  if (hub.regions.length === 0 && hub.hubIds.length === 1) return 'Selected hub';
  return 'Selected hubs';
}

const TIMELINE_SURFACE = SURFACES.find((s) => s.path === '/timeline');

function authKind(errors: unknown[]): 'forbidden' | 'unauthorized' | null {
  for (const err of errors) {
    if (err instanceof ApiError && err.isForbidden) return 'forbidden';
  }
  for (const err of errors) {
    if (err instanceof ApiError && err.isUnauthorized) return 'unauthorized';
  }
  return null;
}

export default function GanttPage(): React.JSX.Element {
  const years = usePlanYearLabels();
  // P12 (ADR 0020): the global header hub filter replaces the page-local select.
  const hub = useHubSelection();
  const [zoomPx, setZoomPx] = React.useState<number>(ZOOM_DEFAULT_PX);
  // Leader / Step options need `dashboard` read (the facets endpoint); without
  // it (an Engineer) those two filters are simply not offered.
  const canReadFacets = usePermission('dashboard').read;
  const facetsQuery = useGanttFacets(hub, canReadFacets);
  const facets = canReadFacets && !facetsQuery.isError ? facetsQuery.data : undefined;
  // Search and sort are local; every multi-select filter is URL state
  // (P31 category / type; P40-T01 status, leader, step, priority), written as
  // repeated params. Old single-value links still parse.
  const [local, setLocal] = React.useState<Pick<GanttFilterState, 'q' | 'sort'>>({
    q: DEFAULT_GANTT_FILTERS.q,
    sort: DEFAULT_GANTT_FILTERS.sort,
  });
  const urlFilters = useGanttUrlFilters(facets);
  const filters = React.useMemo<GanttFilterState>(
    () => ({ ...urlFilters.value, ...local }),
    [urlFilters.value, local],
  );
  const { set: setUrlFilters } = urlFilters;
  const setFilters = React.useCallback(
    (next: GanttFilterState) => {
      setUrlFilters({
        category: next.category,
        type: next.type,
        status: next.status,
        leaderEngineerId: next.leaderEngineerId,
        currentStep: next.currentStep,
        priority: next.priority,
      });
      setLocal({ q: next.q, sort: next.sort });
    },
    [setUrlFilters],
  );
  const { clear: clearHub } = useHubFilter();
  const clearAll = React.useCallback(() => {
    setFilters({ ...DEFAULT_GANTT_FILTERS, sort: filters.sort });
    clearHub();
  }, [setFilters, filters.sort, clearHub]);
  const [forest, setForest] = React.useState(false);
  // A callback ref (state), so measuring starts whenever the card mounts.
  const [filtersEl, setFiltersEl] = React.useState<HTMLDivElement | null>(null);
  const chartHeight = useChartHeightBelow(filtersEl);
  // P40-T01: the summary, the legend and the weekly counts sit behind one
  // small toggle. Owner 2026-11-18: shown by default ("bring the charts back");
  // the user's choice is remembered in localStorage.
  const [showDetails, setShowDetailsState] = React.useState<boolean>(readShowDetails);
  const setShowDetails = React.useCallback((next: boolean) => {
    setShowDetailsState(next);
    writeShowDetails(next);
  }, []);
  const debouncedQ = useDebouncedValue(filters.q, 300);
  const [expandedIds, setExpandedIds] = React.useState<ReadonlySet<string>>(new Set());
  const [freezeProject, setFreezeProject] = React.useState<GanttProjectRow | null>(null);
  const [freezeOpen, setFreezeOpen] = React.useState(false);
  const [writeForbidden, setWriteForbidden] = React.useState(false);
  const [recalcNeeded, setRecalcNeeded] = React.useState(false);

  const queryParams = React.useMemo(
    () => toQueryParams(hub, filters, debouncedQ),
    [hub, filters, debouncedQ],
  );
  // P47 (ADR 0059): refetch on focus and every 60 s while no step week is drafted.
  const editInProgress = useAnyEditInProgress();
  const ganttQuery = useGantt(queryParams, editFreshness(editInProgress));
  const hasRun = ganttQuery.data?.has_active_schedule_run === true;
  const activeRun = useActiveScheduleRun(hasRun);
  const freezeMut = useToggleFreeze();

  const title = TIMELINE_SURFACE?.title ?? 'Project Execution Timeline';
  const description =
    TIMELINE_SURFACE?.summary ??
    'Hand-built virtualized Gantt: 14 workflow steps per project across the plan year and the first 26 weeks of the next.';

  const denied = authKind([ganttQuery.error]);
  const rows = React.useMemo<GanttProjectRow[]>(
    () => ganttQuery.data?.rows ?? [],
    [ganttQuery.data],
  );
  const isFiltered = hasHubSelection(hub) || hasActiveFilters(filters);
  // Session table first (ADR 0010), server 403 second — both withdraw the freeze control.
  const permission = usePermission('gantt');
  const canWrite = permission.write && !writeForbidden;
  // P40-T03c (R40-10): unfreezing needs the Admin or Super Admin ROLE; the
  // server answers 403 UNFREEZE_REQUIRES_ADMIN to anyone else.
  const isAdminRole = useSessionStore((st) => st.me?.roles.some((r) => r === 'Admin' || r === 'Super Admin') ?? false);
  const canUnfreeze = canWrite && isAdminRole;

  // P40-T03c (ADR 0054): drafted step Start / End weeks, one batch Save.
  const calendarWeek = useCurrentWeek();
  const pinSave = useStepPinSave();
  const pinDrafts = useStepPinDraftState({
    minWeek: ganttQuery.data?.current_week ?? calendarWeek ?? 1,
    maxWeek: WITHIN_YEAR_WEEK,
    locked: pinSave.saving,
  });
  const [pinBarError, setPinBarError] = React.useState<string | null>(null);
  useEditSession(pinDrafts.list.length > 0);
  const [confirmPinCancel, setConfirmPinCancel] = React.useState(false);
  const pinTooMany =
    pinDrafts.list.length > STEP_PINS_MAX
      ? `One save takes at most ${formatInteger(STEP_PINS_MAX)} steps. Save fewer at a time.`
      : null;
  const { list: pinList, reset: resetPins, applyServerErrors, dropKeys: dropPinKeys } = pinDrafts;
  const { save: savePins } = pinSave;
  const handlePinSave = React.useCallback(async () => {
    const sent = pinList;
    setPinBarError(null);
    const items = pinDrafts.items();
    const result = await savePins({ items });
    if (result.ok) {
      resetPins();
      return;
    }
    if (result.conflictChoice === 'theirs' && result.conflicts) {
      // P47 (ADR 0059 C2): their stored weeks win for the conflicting steps
      // only; every other drafted step stays, unsaved.
      const conflicts = result.conflicts;
      dropPinKeys(
        items
          .filter((item) => conflicts.some((c) => conflictMatchesPin(c, item)))
          .map((item) => pinKey(item.project_id, item.step_template_id)),
      );
    }
    applyServerErrors(result.itemErrors, sent);
    setPinBarError(result.message);
    // Show the refused steps: expand their projects.
    if (result.itemErrors.length > 0) {
      setExpandedIds((prev) => {
        const next = new Set(prev);
        for (const err of result.itemErrors) next.add(err.project_id);
        return next;
      });
    }
  }, [pinList, savePins, pinDrafts, resetPins, applyServerErrors, dropPinKeys]);
  const discardPins = React.useCallback(() => {
    resetPins();
    setPinBarError(null);
    setConfirmPinCancel(false);
  }, [resetPins]);
  const stepNames = React.useMemo(() => {
    const out = new Map<string, string>();
    for (const r of rows) for (const st of r.steps) if (!out.has(st.step_id)) out.set(st.step_id, st.step_name);
    return out;
  }, [rows]);

  const handleToggleExpand = React.useCallback((projectId: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  }, []);

  const expandAll = React.useCallback(() => {
    setExpandedIds(new Set(rows.map((r) => r.project_id)));
  }, [rows]);
  const collapseAll = React.useCallback(() => setExpandedIds(new Set()), []);

  const handleFreezeClick = React.useCallback((project: GanttProjectRow) => {
    setFreezeProject(project);
    setFreezeOpen(true);
  }, []);

  const handleFreezeSubmit = React.useCallback(
    async (projectId: string, body: FreezeToggleRequest) => {
      try {
        await freezeMut.mutateAsync({ projectId, body });
        setRecalcNeeded(true);
      } catch (err) {
        // P40-T03c: a refused UNFREEZE (Admin / Super Admin only) does not
        // withdraw freezing; the dialog shows the reason.
        if (err instanceof ApiError && err.isForbidden && err.code !== 'UNFREEZE_REQUIRES_ADMIN') {
          setWriteForbidden(true);
          setFreezeOpen(false);
        }
        throw err;
      }
    },
    [freezeMut],
  );

  // P11 (ADR 0015): one priority-move flow for the page; each row's
  // <PriorityMoveControl> uses it.
  return (
    <PriorityMoveProvider>
      {/* P40-T03c: the expanded step rows' Start / End inputs read the drafts here. */}
      <StepPinEditProvider value={pinDrafts.api}>
      <PageHeader
        title={title}
        description={description}
        actions={<HubFilterChip />}
      />
      {/* P37 (ADR 0052 §6): the active plan may be from an earlier week. */}
      <PlanWeekNotice className="mb-4" />

      {denied ? (
        <AccessNotice kind={denied} />
      ) : (
        <div className="flex flex-col gap-4">
          {ganttQuery.data && showDetails ? (
            <StatStrip
              ariaLabel="Timeline summary"
              segments={[
                { label: 'On the timeline', value: rows.length, accent: 'primary', hint: hubHint(hub) },
                // ADR 0024: a left-out project is not done by W52 either, so it is
                // counted inside spillover (server flags, counted — not recomputed).
                {
                  label: 'Spilling past W52',
                  value: rows.filter((r) => r.spillover || r.left_out).length,
                  accent: 'warning',
                  hint: `→ ${years.spilloverYear} · ${String(rows.filter((r) => r.left_out).length)} not yet placed`,
                },
                { label: 'Frozen in place', value: rows.filter((r) => r.frozen).length, accent: 'neutral' },
              ]}
            />
          ) : null}
          {/* Owner ask 2026-11-13: the filters float. The card sticks to the top
              of the surface region while the timeline scrolls under it (the
              chart's own week axis is sticky inside its own scroller, so the
              two never overlap). */}
          <Card
            ref={setFiltersEl}
            className="sticky top-0 z-40 shadow-pop"
            role="region"
            aria-label="Timeline filters"
            data-testid="gantt-filters-floating"
          >
            {/* P40-T01: ONE compact row (wraps only on narrow screens). */}
            <CardContent className="flex flex-wrap items-center gap-1.5 px-s3 py-s2" data-testid="gantt-toolbar">
              <GanttFilterBar
                filters={filters}
                onChange={setFilters}
                facets={facets}
                anyActive={isFiltered}
                onClearAll={clearAll}
              />
              <ViewToggles
                forest={forest}
                onForestChange={setForest}
                showDetails={showDetails}
                onShowDetailsChange={setShowDetails}
                onExpandAll={expandAll}
                onCollapseAll={collapseAll}
                canExpand={!forest && rows.length > 0}
                canCollapse={!forest && expandedIds.size > 0}
              />
              <DownloadButton
                path="/exports/gantt"
                filters={{
                  hub_id: selectionParam(hub.hubIds),
                  region: selectionParam(hub.regions),
                  // P31: the export carries the category / type selection.
                  category: selectionParam(filters.category),
                  type: selectionParam(filters.type),
                }}
                fallbackFilename="gantt-export"
                // P43 (ADR 0057 D2): the workbook carries a drawn Gantt sheet; CSV is the table.
                xlsxLabel="Download as Excel (with Gantt chart)"
                csvLabel="Download as CSV (data only)"
                className="ml-auto [&_button]:h-7"
              />
            </CardContent>
          </Card>

          <ReadOnlyNotice surface="gantt" what="Freezing projects" />
          {writeForbidden ? <FreezeForbiddenNotice /> : null}
          {recalcNeeded ? (
            <div
              role="status"
              className="flex items-start gap-2 rounded-lg border border-warning/50 bg-warning-subtle px-3 py-2 text-2xs text-warning-subtle-fg"
            >
              <RefreshCw className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <span>
                Freeze state saved — the schedule was not recalculated. A Hub Planner or Admin must
                run a schedule recalculation for this change to affect planned dates on this
                timeline.
              </span>
            </div>
          ) : null}

          <SectionBoundary
            query={ganttQuery}
            title="Execution timeline"
            errorDescription="The project execution timeline could not be loaded from the active schedule run."
          >
            {(data) => (
              <Card>
                {/* P40-T01: a slim header (title, provenance and count on one line). */}
                <CardHeader className="min-h-0 py-s2">
                  <div className="flex items-center gap-3">
                    <CardTitle className="text-sm">Execution timeline</CardTitle>
                    {/* P40-T01: the zoom sits on the timeline's own header line. */}
                    <ZoomControl value={zoomPx} onChange={setZoomPx} compact />
                  </div>
                  {data.has_active_schedule_run ? (
                    <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1 text-2xs">
                      <ScheduleRunProvenance
                        scheduleRunVersion={data.schedule_run_version}
                        activeRun={activeRun.data ?? null}
                        leadIn="Planned bars below are read directly from"
                        affordanceLabel="How to read the bars"
                      >
                        <span className="space-y-1 text-left">
                          <span className="block">
                            <strong>Solid bar</strong> = planned schedule (from the run above).
                          </span>
                          <span className="block">
                            <strong>Hatched bar</strong> = actual / delayed dates (live project
                            data).
                          </span>
                          <span className="block">
                            <strong>Red connector</strong> = delay magnitude. The timeline shows
                            the plan year and the first 26 weeks of {years.spilloverYear}, with the
                            year above the weeks; work after the dashed week {WITHIN_YEAR_WEEK}{' '}
                            year-end line runs into the shaded {years.spilloverYear} weeks
                            (spillover). Whether a project
                            completes within the year is the server&apos;s <code>spillover</code>{' '}
                            / <code>left out</code> flag, shown as a badge — not computed here.
                          </span>
                          <span className="block">
                            <strong>Expected completion</strong> (solid violet) is the project&apos;s
                            target week, or the process-derived finish when no target is set;{' '}
                            <strong>will be completed</strong> (dash-dot teal) is the active run&apos;s
                            finish plus delay. Both weeks and the slip between them are stored on
                            the run — never computed here (Invariant I16).
                          </span>
                          <span className="block">
                            <strong>Step timing</strong> follows each project&apos;s category
                            template (Workflow templates). A &ldquo;parallel N wk&rdquo; or
                            &ldquo;wait N wk&rdquo; chip on a step is the template&apos;s gap
                            before it. An Admin may type a step&apos;s <strong>Start / End
                            week</strong> (both inclusive) on an expanded project: the step
                            then sits on those weeks (<strong>Pinned</strong>), and its
                            neighbours keep their own timing.
                          </span>
                        </span>
                      </ScheduleRunProvenance>
                      <span className="flex items-center gap-1 text-2xs text-text-muted">
                        <Info className="size-3" aria-hidden="true" />
                        {formatInteger(data.rows.length)} of {formatInteger(data.total_count)}{' '}
                        {data.total_count === 1 ? 'project' : 'projects'} shown
                      </span>
                    </div>
                  ) : null}
                </CardHeader>
                <CardContent className="space-y-2 p-s2">
                  {!data.has_active_schedule_run ? (
                    <EmptyState
                      title="No schedule computed yet"
                      description="No active schedule run exists. Once the schedule is calculated, each project's 14 workflow steps will appear here as planned bars — sourced directly from that run."
                    />
                  ) : data.rows.length === 0 ? (
                    <EmptyState
                      title={isFiltered ? 'No projects match these filters' : 'No projects in scope'}
                      description={
                        isFiltered
                          ? 'Try clearing the toolbar filters or the hub filter in the header.'
                          : 'There are no projects visible in your hub scope.'
                      }
                    />
                  ) : (
                    <>
                      {showDetails ? <GanttLegend rows={data.rows} /> : null}
                      {showDetails ? (
                        <StepCountChips
                          counts={data.current_step_counts ?? {}}
                          week={data.current_week ?? null}
                          names={stepNames}
                        />
                      ) : null}
                      <GanttChart
                        rows={data.rows}
                        zoom={zoomPx}
                        density={forest ? 'forest' : 'comfortable'}
                        weeklyCounts={data.weekly_active_counts}
                        showStats={showDetails}
                        expandedIds={expandedIds}
                        onToggleExpand={handleToggleExpand}
                        onFreezeClick={handleFreezeClick}
                        canWrite={canWrite}
                        canUnfreeze={canUnfreeze}
                        markUnplaced
                        {...(chartHeight !== undefined ? { maxHeight: chartHeight } : {})}
                      />
                    </>
                  )}
                </CardContent>
              </Card>
            )}
          </SectionBoundary>
          {pinDrafts.list.length > 0 ? (
            <StepPinEditBar
              changedCount={pinDrafts.list.length}
              projectCount={pinDrafts.projectCount}
              invalidCount={pinDrafts.invalidCount}
              onSave={() => void handlePinSave()}
              onCancel={() => setConfirmPinCancel(true)}
              saving={pinSave.saving}
              error={pinBarError}
              tooMany={pinTooMany}
            />
          ) : null}
        </div>
      )}

      <StepPinLeaveGuard when={pinDrafts.list.length > 0} />
      {pinSave.conflictDialog}
      <StepPinDiscardDialog
        open={confirmPinCancel}
        title="Discard your step weeks?"
        description={`${formatInteger(pinDrafts.list.length)} ${
          pinDrafts.list.length === 1 ? 'step has' : 'steps have'
        } unsaved Start / End weeks. Nothing has been saved.`}
        onKeep={() => setConfirmPinCancel(false)}
        onDiscard={discardPins}
        testId="step-pin-discard-dialog"
      />
      <StepPinSavePanel
        flow={pinSave.flow}
        runState={pinSave.runState}
        changes={pinSave.changes}
        watchingFollowUp={pinSave.watchingFollowUp}
        onClose={pinSave.close}
      />

      <FreezeDialog
        project={freezeProject}
        open={freezeOpen}
        onOpenChange={setFreezeOpen}
        onSubmit={handleFreezeSubmit}
      />
      </StepPinEditProvider>
    </PriorityMoveProvider>
  );
}

import * as React from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQueries } from '@tanstack/react-query';
import { ChevronsDownUp, ChevronsUpDown, Search, TriangleAlert } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { EmptyState } from '@/components/shared/empty-state';
import { ProjectStatusBadge } from '@/components/shared/project-status-badge';
import { SectionBoundary } from '@/components/shared/section-boundary';
import { ReadOnlyNotice } from '@/components/session/write-gate';
import { ApiError } from '@/lib/api/client';
import { SCHEDULER_HORIZON_WEEKS } from '@/lib/domain-constants';
import { formatInteger, formatYearWeek } from '@/lib/format';
import { queryKeys } from '@/lib/query-keys';
import { useHubFilter } from '@/stores/hub-filter';
import { usePermission } from '@/stores/session';
import type { ProjectPriority, ProjectStatus } from '@/types/enums';
import { AccessNotice } from '@/surfaces/gantt/components/access-notice';
import { GanttChart } from '@/surfaces/gantt/components/gantt-chart';
import { GanttLegend } from '@/surfaces/gantt/components/gantt-legend';
import { PriorityTabs } from '@/surfaces/gantt/components/gantt-toolbar';
import { StepTimingProvider } from '@/surfaces/gantt/components/step-timing/step-timing-provider';
import { useGantt } from '@/surfaces/gantt/hooks/use-gantt';
import { projectWaterfallScale, ZOOM_DEFAULT_PX } from '@/surfaces/gantt/lib/gantt-coordinates';
import type { GanttProjectRow } from '@/surfaces/gantt/api/types';
import { fetchWorkspace, retryUnlessAuth } from '@/surfaces/project-workspace/api/workspace-api';

import { useProjectStatuses } from '../../hooks/use-project-statuses';
import { completeStepRows, STEPS_PER_WORKFLOW } from '../../lib/complete-step-rows';

/**
 * P32-R04 (owner 2026-11-04/05: "here ALL the projects should come with the
 * timeline and we can expand and then move and drag the bars"): the Workflow
 * page's "Project step timing" tab is the Timeline's own `GanttChart`, with
 * the step-timing host mounted (drag, right-edge resize, drop onto the step
 * above = parallel, Edit timing, Reset, run-follow) over every project in scope
 * (global hub filter). Differences from `/timeline`, all opt-in chart props:
 * - the axis runs past W52 to the latest served end / start floor + 2 (max
 *   W78), labelled "W5 '27", and the weeks grow to fill the card;
 * - a search box filters the loaded rows (name, code, hub, status);
 * - `?project=<id>` expands that project and scrolls to it;
 * - a project the active run did not (fully) place gets a "Not placed" badge,
 *   and once expanded and on screen its missing steps come from the Workspace
 *   (`completeStepRows`), with Edit timing where it may be offered.
 * Rows are virtualized by the chart.
 */

function needsStages(row: GanttProjectRow): boolean {
  return row.steps.length < STEPS_PER_WORKFLOW;
}

function matches(row: GanttProjectRow, q: string, status: ProjectStatus | undefined): boolean {
  if (q === '') return true;
  return [row.project_name, row.external_code ?? '', row.hub, status ?? ''].some((v) => v.toLowerCase().includes(q));
}

const noop = (): void => undefined;

export function ProjectStepTimingSection(): React.JSX.Element {
  const [params, setParams] = useSearchParams();
  const linked = params.get('project');
  const { hubId, region } = useHubFilter();
  const [priority, setPriority] = React.useState<ProjectPriority | null>(null);
  const [query, setQuery] = React.useState('');
  const gantt = useGantt({
    hubId: hubId ?? undefined,
    region: region ?? undefined,
    priority: priority ?? undefined,
  });
  const statuses = useProjectStatuses();
  const canWriteGantt = usePermission('gantt').write;

  const [toggled, setExpandedIds] = React.useState<ReadonlySet<string>>(new Set());
  // `?project=<id>` is always expanded (deep link, or the last one opened).
  const expandedIds = React.useMemo<ReadonlySet<string>>(
    () => (linked && !toggled.has(linked) ? new Set(toggled).add(linked) : toggled),
    [toggled, linked],
  );

  const toggle = React.useCallback(
    (projectId: string) => {
      const expanding = !expandedIds.has(projectId);
      const next = new Set(expandedIds);
      if (expanding) next.add(projectId);
      else next.delete(projectId);
      setExpandedIds(next);
      setParams(
        (prev) => {
          const p = new URLSearchParams(prev);
          if (expanding) p.set('project', projectId);
          else if (p.get('project') === projectId) p.delete('project');
          return p;
        },
        { replace: true },
      );
    },
    [expandedIds, setParams],
  );
  const collapseAll = React.useCallback(() => {
    setExpandedIds(new Set());
    setParams(
      (prev) => {
        const p = new URLSearchParams(prev);
        p.delete('project');
        return p;
      },
      { replace: true },
    );
  }, [setParams]);

  // Workspace stages only for an expanded, not fully placed project that has
  // been on screen (kept once seen, so rows do not jump while scrolling).
  const [seen, setSeen] = React.useState<ReadonlySet<string>>(new Set());
  const onVisible = React.useCallback((ids: readonly string[]) => {
    setSeen((prev) => {
      if (ids.every((id) => prev.has(id))) return prev;
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      return next;
    });
  }, []);
  const rows = React.useMemo(() => gantt.data?.rows ?? [], [gantt.data]);
  const stageIds = React.useMemo(
    () => rows.filter((r) => expandedIds.has(r.project_id) && seen.has(r.project_id) && needsStages(r)).map((r) => r.project_id),
    [rows, expandedIds, seen],
  );
  // `combine` is structurally shared, so the list keeps its identity until a
  // workspace payload changes.
  const workspaces = useQueries({
    queries: stageIds.map((id) => ({
      queryKey: queryKeys.projectWorkspace(id),
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchWorkspace(id, { signal }),
      retry: retryUnlessAuth,
      staleTime: 30_000,
    })),
    combine: (results) => results.map((r) => r.data ?? null),
  });

  const completed = React.useMemo(() => {
    const byId = new Map(stageIds.map((id, i) => [id, workspaces[i] ?? null] as const));
    return rows.map((r) => {
      const ws = byId.get(r.project_id) ?? null;
      if (!ws) return r;
      return completeStepRows(r, ws.stages, {
        canWriteGantt,
        frozen: ws.project.frozen,
        status: ws.project.status,
      }).row;
    });
  }, [rows, stageIds, workspaces, canWriteGantt]);

  const q = query.trim().toLowerCase();
  const visible = React.useMemo(
    () => completed.filter((r) => matches(r, q, statuses.get(r.project_id))),
    [completed, q, statuses],
  );

  // One axis for the whole list (stable while filtering): past W52 up to the
  // latest served end / floor + 2, max W78.
  const allSteps = React.useMemo(() => completed.flatMap((r) => r.steps), [completed]);
  const axis = React.useMemo(
    () => ({ scaleFor: (px: number) => projectWaterfallScale(allSteps, px), fill: true, weekLabel: formatYearWeek }),
    [allSteps],
  );

  const rowExtra = React.useCallback(
    (project: GanttProjectRow) => {
      const status = statuses.get(project.project_id);
      return (
        <>
          {status ? <ProjectStatusBadge status={status} className="px-1 py-px" /> : null}
          {project.left_out || needsStages(project) ? <NotPlacedBadge project={project} /> : null}
        </>
      );
    },
    [statuses],
  );

  const denied =
    gantt.error instanceof ApiError && (gantt.error.isForbidden || gantt.error.isUnauthorized)
      ? gantt.error.isForbidden
        ? 'forbidden'
        : 'unauthorized'
      : null;

  return (
    <StepTimingProvider>
      <div className="flex flex-col gap-4" data-testid="project-step-timing">
        <Card>
          <CardHeader>
            <CardTitle>Project step timing</CardTitle>
            <CardDescription>
              Expand a project to see its steps. Drag a step bar to set its earliest start, drag its right edge to
              change its duration, or drop it onto the step above to run the two in parallel. Each change
              recalculates the timeline in a few seconds; capacity and precedence still apply.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-end gap-4">
            <div className="flex w-full max-w-sm flex-col gap-1">
              <Label htmlFor="step-timing-search" className="text-2xs text-text-muted">
                Search
              </Label>
              <div className="relative">
                <Search
                  className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-text-subtle"
                  aria-hidden="true"
                />
                <Input
                  id="step-timing-search"
                  type="search"
                  className="pl-8"
                  placeholder="Name, code, hub or status"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  data-testid="step-timing-search"
                />
              </div>
            </div>
            <PriorityTabs value={priority} onChange={setPriority} />
            <div className="flex items-end gap-1">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setExpandedIds(new Set(visible.map((r) => r.project_id)))}
                disabled={visible.length === 0}
              >
                <ChevronsUpDown />
                Expand all
              </Button>
              <Button variant="ghost" size="sm" onClick={collapseAll} disabled={expandedIds.size === 0}>
                <ChevronsDownUp />
                Collapse all
              </Button>
            </div>
          </CardContent>
        </Card>
        <ReadOnlyNotice surface="gantt" what="Changing step timing" />
        {denied ? (
          <AccessNotice kind={denied} />
        ) : (
          <SectionBoundary
            query={gantt}
            title="Project timeline"
            errorDescription="The project timeline could not be loaded from the active schedule run."
          >
            {(data) =>
              !data.has_active_schedule_run ? (
                <EmptyState
                  title="No schedule yet"
                  description="Step timing is edited on the active schedule. Run a recalculation first."
                />
              ) : visible.length === 0 ? (
                <EmptyState
                  title={rows.length === 0 ? 'No projects in scope' : 'No project matches the search'}
                  description={
                    rows.length === 0
                      ? 'There are no projects visible in your hub scope and filters.'
                      : 'Clear the search or the priority filter.'
                  }
                />
              ) : (
                <div className="flex flex-col gap-2">
                  <p className="text-2xs text-text-muted" data-testid="step-timing-count">
                    {formatInteger(visible.length)} of {formatInteger(rows.length)}{' '}
                    {rows.length === 1 ? 'project' : 'projects'} shown
                  </p>
                  <GanttLegend />
                  <GanttChart
                    rows={visible}
                    zoom={ZOOM_DEFAULT_PX}
                    showStats={false}
                    expandedIds={expandedIds}
                    onToggleExpand={toggle}
                    onFreezeClick={noop}
                    canWrite={false}
                    maxHeight={680}
                    axis={axis}
                    rowExtra={rowExtra}
                    markUnplaced
                    scrollToProjectId={linked}
                    onVisibleProjectsChange={onVisible}
                  />
                </div>
              )
            }
          </SectionBoundary>
        )}
      </div>
    </StepTimingProvider>
  );
}

/**
 * The active run placed none (left out) or only some of the project's steps.
 * The run stores no reason; the two the row serves (no leader, category not
 * allowed) are named, otherwise it says none is recorded.
 */
function NotPlacedBadge({ project }: { project: GanttProjectRow }): React.JSX.Element {
  const horizon = formatYearWeek(SCHEDULER_HORIZON_WEEKS);
  const reason =
    project.leader_engineer_id === null
      ? 'Reason: the project has no leader.'
      : project.cat_not_allowed
        ? "Reason: the project's category is not allowed in this hub."
        : 'The run records no reason; the leader and category are set, so it is usually engineer or chamber capacity.';
  const title = `Not placed: the scheduler found no slot before the planning horizon (${horizon}). ${reason} Expand it to shorten steps, run steps in parallel or change timing (Edit timing on a step); it then recalculates.`;
  return (
    <Badge tone="warning" className="whitespace-nowrap px-1 py-px" title={title} data-testid="step-timing-not-placed">
      <TriangleAlert aria-hidden="true" />
      Not placed
      <span className="sr-only">. {title}</span>
    </Badge>
  );
}

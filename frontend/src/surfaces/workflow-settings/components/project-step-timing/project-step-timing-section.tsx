import * as React from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight, CalendarRange, TriangleAlert, UserRound } from 'lucide-react';

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/shared/empty-state';
import { ErrorState } from '@/components/shared/error-state';
import { NoLeaderLabel } from '@/components/shared/no-leader-label';
import { PanelSkeleton } from '@/components/ui/panel-skeleton';
import { PriorityBandPill } from '@/components/shared/priority-band-pill';
import { ProjectStatusBadge } from '@/components/shared/project-status-badge';
import { ProjectedFinishChip } from '@/components/shared/project-outcome-chips';
import { ApiError } from '@/lib/api/client';
import { formatYearWeek } from '@/lib/format';
import { SCHEDULER_HORIZON_WEEKS } from '@/lib/domain-constants';
import { queryKeys } from '@/lib/query-keys';
import { usePermission } from '@/stores/session';
import { SCHEDULABLE_STATUSES, type ProjectStatus } from '@/types/enums';
import { fetchWorkspace, retryUnlessAuth } from '@/surfaces/project-workspace/api/workspace-api';
import { ProjectStepWaterfall } from '@/surfaces/gantt/components/project-step-waterfall';
import { StepTimingProvider } from '@/surfaces/gantt/components/step-timing/step-timing-provider';
import { useProjectTimeline } from '@/surfaces/gantt/hooks/use-gantt';
import type { GanttProjectRow } from '@/surfaces/gantt/api/types';

import { useStepTimingProjects, type StepTimingProjectOption } from '../../hooks/use-step-timing-projects';
import { completeStepRows, STEPS_PER_WORKFLOW } from '../../lib/complete-step-rows';
import { ProjectPicker } from './project-picker';

/**
 * P32-R04 (owner 2026-11-04: "the drag of the bars for change of timeline —
 * mainly we will do it in Workflow, so put it there"): per-project step timing
 * on the Workflow page. Pick a project (remembered as `?project=<id>`), see its
 * steps one below another and edit them exactly as on the Timeline — the same
 * step-timing host (drag, resize, drop-onto-step-above overlap, Edit timing
 * dialog, Reset, run-follow). The Timeline keeps its own drag too.
 *
 * Data: `GET /gantt?project_id=` (key under `['gantt']`, so a save and the
 * completed run refetch it and the Timeline). What may be edited is the
 * served `timing_editable` per step (Hub Planner of the hub, Admin, Super
 * Admin; read only for everyone else); the server enforces it.
 */
export function ProjectStepTimingSection(): React.JSX.Element {
  const [params, setParams] = useSearchParams();
  const projectId = params.get('project');
  const projects = useStepTimingProjects();

  const select = React.useCallback(
    (option: StepTimingProjectOption) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set('project', option.id);
          return next;
        },
        { replace: false },
      );
    },
    [setParams],
  );

  const selectedOption = projectId === null ? null : (projects.options.find((o) => o.id === projectId) ?? null);

  return (
    <StepTimingProvider>
      <div className="flex flex-col gap-4" data-testid="project-step-timing">
        <Card>
          <CardHeader>
            <CardTitle>Project step timing</CardTitle>
            <CardDescription>
              Drag a step bar to set its earliest start, drag its right edge to change its duration, or drop it onto
              the step above to run the two in parallel. Each change recalculates the timeline in a few seconds;
              capacity and precedence still apply.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ProjectPicker
              options={projects.options}
              selectedId={projectId}
              onSelect={select}
              loading={projects.isPending}
            />
            {projects.isError ? (
              <p className="mt-2 text-2xs text-danger" role="alert">
                The project list could not be loaded. A project linked here still opens.
              </p>
            ) : null}
          </CardContent>
        </Card>
        {projectId === null ? (
          <EmptyState
            title="Pick a project to adjust its steps"
            description="Its 14 workflow steps appear one below another on the week axis, ready to move, resize or run in parallel."
            media={<CalendarRange className="size-8 text-text-subtle" aria-hidden="true" />}
          />
        ) : (
          <ProjectTiming projectId={projectId} option={selectedOption} />
        )}
      </div>
    </StepTimingProvider>
  );
}

function ProjectTiming({
  projectId,
  option,
}: {
  projectId: string;
  option: StepTimingProjectOption | null;
}): React.JSX.Element {
  const timeline = useProjectTimeline(projectId);
  const canWriteGantt = usePermission('gantt').write;
  const served = timeline.data?.rows.find((r) => r.project_id === projectId) ?? null;
  // `/gantt` lists only the steps the active run placed: a left-out project
  // has none. The Workspace stages fill in the rest (P32-R04 follow-up).
  const needsStages = served !== null && served.steps.length < STEPS_PER_WORKFLOW;
  const workspace = useQuery({
    queryKey: queryKeys.projectWorkspace(projectId),
    queryFn: ({ signal }) => fetchWorkspace(projectId, { signal }),
    retry: retryUnlessAuth,
    enabled: needsStages,
  });

  if (timeline.isPending || (needsStages && workspace.isPending)) return <PanelSkeleton height="h-96" />;
  if (timeline.isError) {
    const err = timeline.error;
    if (err instanceof ApiError && (err.isForbidden || err.isUnauthorized)) {
      return (
        <EmptyState
          title="Timeline not available"
          description="Your role cannot read this project's timeline."
        />
      );
    }
    return (
      <Card>
        <CardContent className="pt-6">
          <ErrorState description="The project's steps could not be loaded." onRetry={() => void timeline.refetch()} />
        </CardContent>
      </Card>
    );
  }
  if (!timeline.data.has_active_schedule_run) {
    return (
      <EmptyState
        title="No schedule yet"
        description="Step timing is edited on the active schedule. Run a recalculation first."
      />
    );
  }
  if (!served) {
    return (
      <EmptyState
        title="This project is not on the timeline"
        description="It is outside your hub scope, or its status is not scheduled."
      />
    );
  }
  const ws = needsStages ? (workspace.data ?? null) : null;
  const status: ProjectStatus | null = ws?.project.status ?? option?.status ?? null;
  const { row } = completeStepRows(
    served,
    ws?.stages ?? null,
    ws ? { canWriteGantt, frozen: ws.project.frozen, status: ws.project.status } : null,
  );
  const unplaced = row.steps.filter(
    (s) => !s.skipped && s.planned_start_week === null && s.actual_start_week === null,
  ).length;
  const editable = row.steps.some((s) => !s.skipped && s.timing_editable !== 'none');
  const readOnlyReason = !canWriteGantt
    ? 'Your role can view step timing but not change it.'
    : row.frozen
      ? 'This project is frozen, so its step timing is locked.'
      : status !== null && !(SCHEDULABLE_STATUSES as readonly string[]).includes(status)
        ? `This project's status (${status}) is not scheduled, so its step timing cannot be changed.`
        : 'No step of this project can be changed: the remaining steps are done, skipped or outside your hub scope.';
  return (
    <Card data-testid="step-timing-project" aria-busy={timeline.isFetching || undefined}>
      <CardHeader>
        <ProjectHeader project={row} option={option} status={status} />
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {row.left_out || unplaced > 0 ? (
          <NotPlacedBanner project={row} unplaced={unplaced} total={row.steps.filter((s) => !s.skipped).length} />
        ) : null}
        {needsStages && workspace.isError ? (
          <p className="text-2xs text-danger" role="alert" data-testid="step-timing-stages-error">
            The steps the run did not place could not be loaded, so only the placed steps are listed.
          </p>
        ) : null}
        {editable ? null : (
          <p className="text-2xs text-text-muted" data-testid="step-timing-read-only">
            Read only: {readOnlyReason}
          </p>
        )}
        <ProjectStepWaterfall project={row} />
      </CardContent>
    </Card>
  );
}

/**
 * The run placed none (left out) or only some of the project's steps. The
 * run stores no reason; the two the row serves (no leader, category not
 * allowed) are named, otherwise it says none is recorded.
 */
function NotPlacedBanner({
  project,
  unplaced,
  total,
}: {
  project: GanttProjectRow;
  unplaced: number;
  total: number;
}): React.JSX.Element {
  // W78, the scheduler horizon, named as next year's week (ADR 0024).
  const horizon = `the planning horizon (${formatYearWeek(SCHEDULER_HORIZON_WEEKS)})`;
  const reason =
    project.leader_engineer_id === null
      ? 'Reason: the project has no leader.'
      : project.cat_not_allowed
        ? "Reason: the project's category is not allowed in this hub."
        : 'The run records no reason; the leader and category are set, so it is usually engineer or chamber capacity.';
  const lead =
    unplaced > 0 && unplaced < total
      ? `Partly placed: ${String(unplaced)} of ${String(total)} steps found no slot before ${horizon}.`
      : `Not placed: the scheduler found no slot before ${horizon}.`;
  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-md border border-warning/50 bg-warning-subtle px-3 py-2 text-xs text-warning-subtle-fg"
      data-testid="step-timing-not-placed"
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <p>
        <span className="font-semibold">{lead}</span> {reason} Shorten steps, run steps in parallel or change the
        leader (Edit timing on a step), then it recalculates.
      </p>
    </div>
  );
}

function ProjectHeader({
  project,
  option,
  status,
}: {
  project: GanttProjectRow;
  option: StepTimingProjectOption | null;
  status: ProjectStatus | null;
}): React.JSX.Element {
  const withinYear =
    project.projected_end_week === null ? null : !(project.spillover || project.left_out);
  return (
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 className="truncate text-base font-semibold text-text" data-testid="step-timing-project-name">
          {project.project_name}
          {project.external_code ? (
            <span className="ml-2 text-xs font-normal text-text-subtle tabular-nums">{project.external_code}</span>
          ) : null}
        </h2>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-text-muted">
          <span>{project.hub}</span>
          <span aria-hidden="true">·</span>
          <span>Category {project.category ?? '—'}</span>
          <span aria-hidden="true">·</span>
          <span className="inline-flex items-center gap-1">
            <UserRound className="size-3 text-text-subtle" aria-hidden="true" />
            <span className="sr-only">Leader: </span>
            {project.leader_name ? (
              project.leader_name
            ) : project.leader_engineer_id ? (
              <span className="italic">Name unavailable</span>
            ) : (
              <NoLeaderLabel leftOut={project.left_out} inline />
            )}
          </span>
          {project.projected_end_week !== null ? (
            <>
              <span aria-hidden="true">·</span>
              <span className="tabular-nums" data-testid="step-timing-finish-week">
                Finish {formatYearWeek(project.projected_end_week)}
              </span>
            </>
          ) : null}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {(status ?? option?.status) ? <ProjectStatusBadge status={(status ?? option?.status) as ProjectStatus} /> : null}
        {project.priority ? <PriorityBandPill priority={project.priority} /> : null}
        <ProjectedFinishChip projectedEndWeek={project.projected_end_week} withinYear={withinYear} />
        <Link
          to={`/projects/${project.project_id}`}
          className="inline-flex items-center gap-0.5 rounded-sm text-2xs font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          Open project
          <ArrowUpRight className="size-3" aria-hidden="true" />
        </Link>
      </div>
    </div>
  );
}

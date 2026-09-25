import * as React from 'react';
import { ChevronsDownUp, ChevronsUpDown, FilterX, Info, RefreshCw } from 'lucide-react';

import { PageHeader } from '@/components/layout/page-header';
import { SectionBoundary } from '@/components/shared/section-boundary';
import { ScheduleRunProvenance } from '@/components/shared/schedule-run-provenance';
import { DownloadButton } from '@/components/shared/download-button';
import { EmptyState } from '@/components/shared/empty-state';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApiError } from '@/lib/api/client';
import { useHubs } from '@/lib/api/reference';
import { formatInteger } from '@/lib/format';
import { WITHIN_YEAR_WEEK } from '@/lib/domain-constants';
import { SURFACES } from '@/app/nav';

import { AccessNotice, FreezeForbiddenNotice } from './components/access-notice';
import { GanttChart } from './components/gantt-chart';
import { GanttLegend } from './components/gantt-legend';
import { FreezeDialog } from './components/freeze-dialog';
import { ZoomControl } from './components/zoom-control';
import { useActiveScheduleRun, useGantt, useToggleFreeze } from './hooks/use-gantt';
import type { FreezeToggleRequest, GanttProjectRow } from './api/types';
import type { GanttZoom } from './lib/gantt-coordinates';

const TIMELINE_SURFACE = SURFACES.find((s) => s.path === '/timeline');
const ALL = '__all__';

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
  const [hubId, setHubId] = React.useState<string>(ALL);
  const [zoom, setZoom] = React.useState<GanttZoom>('weeks');
  const [expandedIds, setExpandedIds] = React.useState<ReadonlySet<string>>(new Set());
  const [freezeProject, setFreezeProject] = React.useState<GanttProjectRow | null>(null);
  const [freezeOpen, setFreezeOpen] = React.useState(false);
  const [writeForbidden, setWriteForbidden] = React.useState(false);
  const [recalcNeeded, setRecalcNeeded] = React.useState(false);

  const hubsQuery = useHubs();
  const ganttQuery = useGantt({ hubId: hubId === ALL ? undefined : hubId });
  const hasRun = ganttQuery.data?.has_active_schedule_run === true;
  const activeRun = useActiveScheduleRun(hasRun);
  const freezeMut = useToggleFreeze();

  const title = TIMELINE_SURFACE?.title ?? 'Project Execution Timeline';
  const description =
    TIMELINE_SURFACE?.summary ??
    'Hand-built virtualized Gantt: 14 workflow steps per project across the 78-week horizon.';

  const denied = authKind([ganttQuery.error]);
  const rows = React.useMemo<GanttProjectRow[]>(
    () => ganttQuery.data?.rows ?? [],
    [ganttQuery.data],
  );
  const isFiltered = hubId !== ALL;
  const canWrite = !writeForbidden;

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
        if (err instanceof ApiError && err.isForbidden) {
          setWriteForbidden(true);
          setFreezeOpen(false);
        }
        throw err;
      }
    },
    [freezeMut],
  );

  return (
    <>
      <PageHeader
        title={title}
        description={description}
        actions={<ZoomControl value={zoom} onChange={setZoom} />}
      />

      {denied ? (
        <AccessNotice kind={denied} />
      ) : (
        <div className="flex flex-col gap-4">
          <Card>
            <CardHeader>
              <CardTitle>View</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap items-end gap-4">
              <div className="flex flex-col gap-1">
                <Label htmlFor="gantt-hub" className="text-2xs text-text-muted">
                  Hub
                </Label>
                <Select value={hubId} onValueChange={setHubId}>
                  <SelectTrigger id="gantt-hub" className="h-8 w-44">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={ALL}>All hubs</SelectItem>
                    {(hubsQuery.data ?? []).map((h) => (
                      <SelectItem key={h.id} value={h.id}>
                        {h.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-end gap-1">
                <Button variant="secondary" size="sm" onClick={expandAll} disabled={rows.length === 0}>
                  <ChevronsUpDown />
                  Expand all
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={collapseAll}
                  disabled={expandedIds.size === 0}
                >
                  <ChevronsDownUp />
                  Collapse all
                </Button>
              </div>
              {isFiltered ? (
                <Button variant="ghost" size="sm" onClick={() => setHubId(ALL)}>
                  <FilterX />
                  Clear
                </Button>
              ) : null}
              <DownloadButton
                path="/exports/gantt"
                filters={{ hub_id: hubId === ALL ? undefined : hubId }}
                fallbackFilename="gantt-export"
                className="ml-auto"
              />
            </CardContent>
          </Card>

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
                <CardHeader>
                  <CardTitle>Execution timeline</CardTitle>
                  {data.has_active_schedule_run ? (
                    <div className="flex flex-col gap-2">
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
                            <strong>Red connector</strong> = delay magnitude. The dashed line at
                            week {WITHIN_YEAR_WEEK} is year-end; whether a project completes within
                            the year is the server&apos;s <code>spillover</code> / <code>left out</code>{' '}
                            flag, shown as a badge — not computed here.
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
                <CardContent className="space-y-3">
                  {!data.has_active_schedule_run ? (
                    <EmptyState
                      title="No schedule computed yet"
                      description="No active schedule run exists. Once the schedule is calculated, each project's 14 workflow steps will appear here as planned bars — sourced directly from that run."
                    />
                  ) : data.rows.length === 0 ? (
                    <EmptyState
                      title={isFiltered ? 'No projects match this hub filter' : 'No projects in scope'}
                      description={
                        isFiltered
                          ? 'Try clearing the hub filter.'
                          : 'There are no projects visible in your hub scope.'
                      }
                    />
                  ) : (
                    <>
                      <GanttLegend />
                      <GanttChart
                        rows={data.rows}
                        zoom={zoom}
                        expandedIds={expandedIds}
                        onToggleExpand={handleToggleExpand}
                        onFreezeClick={handleFreezeClick}
                        canWrite={canWrite}
                      />
                    </>
                  )}
                </CardContent>
              </Card>
            )}
          </SectionBoundary>
        </div>
      )}

      <FreezeDialog
        project={freezeProject}
        open={freezeOpen}
        onOpenChange={setFreezeOpen}
        onSubmit={handleFreezeSubmit}
      />
    </>
  );
}

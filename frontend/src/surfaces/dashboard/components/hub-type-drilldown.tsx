import * as React from 'react';
import { CalendarCheck, FolderKanban } from 'lucide-react';

import { PriorityBandPill } from '@/components/shared/priority-band-pill';
import { ProjectStatusBadge } from '@/components/shared/project-status-badge';
import { Skeleton } from '@/components/ui/skeleton';
import { CategoryTag } from '@/components/ui/category-tag';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { EntityCell } from '@/components/ui/table-cells';
import { ErrorState } from '@/components/shared/error-state';
import { useHubs } from '@/lib/api/reference';
import { categoricalRankSoftBg, categoricalRankText, categoryRank } from '@/lib/categorical-palette';
import { formatInteger, formatPlanWeek } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { HubName, LabRegion, ProjectCategory, ProjectPriority, ProjectStatus, ProjectType } from '@/types/enums';

import type { CompletingWithinYearRow, ProjectFilterRow } from '../api/types';
import { useDrilldownProjects } from '../hooks/use-dashboard';
import { useDashboardSelection } from '../lib/selection';
import { selectionParam } from '@/lib/multi-select-filter';
import { typeLabel } from '../lib/analytics';
import { drillAriaLabel, drillTitle, type DrillSource, type DrillTarget } from '../lib/drilldown';
import { outcomeOf } from '../lib/outcome';
import { VirtualDataTable, type VirtualColumn } from './virtual-data-table';

/**
 * P17-R08: drill-down from the two Hub × Type tables (client's older app,
 * "Click to view N projects"). A cell, a row total, a column total or the grand
 * total opens a dialog listing exactly the projects behind that figure.
 *
 * Sources (no new endpoint; every membership test is a served field):
 * - Pipeline table: `GET /dashboard/projects` (ADR 0030 all-projects basis)
 *   with the server filters `hub_id` (the cell's hub, else the global hub),
 *   `region` (the global country) and `type`. The browser does not filter.
 * - Completing table: the already-loaded `GET /dashboard/completing-within-year`
 *   rows (same hub / country filter, same active run) in the exclusive
 *   within-year bucket (`outcomeOf(row) === 'within_year'`, i.e. `within_year
 *   AND NOT blocked`, the backend's own precedence), matched on the served
 *   `hub` and `type`. That is the set `/dashboard/analytics` counts per cell.
 *
 * The dialog shows the list's own length and, if it ever differs from the
 * clicked figure, says so instead of hiding the disagreement.
 */

/* --------------------------------- trigger --------------------------------- */

/** A clickable figure in a Hub × Type table. Zero is never clickable. */
export function DrillButton({
  target,
  onDrill,
  children,
  className,
}: {
  target: DrillTarget;
  onDrill: (target: DrillTarget, trigger: HTMLElement) => void;
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  const label = drillAriaLabel(target);
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      data-testid="drill-cell"
      onClick={(e) => onDrill(target, e.currentTarget)}
      className={cn(
        'inline-flex min-h-7 min-w-7 items-center justify-center rounded-md px-1 tabular-nums underline decoration-dotted decoration-1 underline-offset-4 transition-colors',
        'hover:bg-primary-subtle hover:text-primary-subtle-fg hover:decoration-solid',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        className,
      )}
    >
      {children}
    </button>
  );
}

/* ---------------------------------- rows ----------------------------------- */

interface DrillRow {
  id: string;
  name: string;
  externalCode: string | null;
  hub: HubName;
  type: ProjectType | null;
  category: ProjectCategory | null;
  priority: ProjectPriority | null;
  status: ProjectStatus;
  finishWeek: number | null;
}

function fromRegister(r: ProjectFilterRow): DrillRow {
  return {
    id: r.project_id,
    name: r.project_name,
    externalCode: r.external_code,
    hub: r.hub,
    type: r.type,
    category: r.category,
    priority: r.priority,
    status: r.status,
    finishWeek: r.end_week,
  };
}

function fromRun(r: CompletingWithinYearRow): DrillRow {
  return {
    id: r.project_id,
    name: r.project_name,
    externalCode: null,
    hub: r.hub,
    type: r.type,
    category: r.category,
    priority: r.priority,
    status: r.status,
    finishWeek: r.last_step_end_week,
  };
}

const DASH = <span className="text-text-subtle">—</span>;

function columns(source: DrillSource): VirtualColumn<DrillRow>[] {
  const base: VirtualColumn<DrillRow>[] = [
    {
      id: 'project',
      header: 'Project',
      width: 'minmax(13rem, 2.2fr)',
      cell: (row) => {
        const rank = row.category ? categoryRank(row.category) : 9;
        return (
          <EntityCell
            icon={FolderKanban}
            iconClassName={cn(categoricalRankSoftBg(rank), categoricalRankText(rank))}
            title={row.name}
            titleAttr={`${row.name} — open in Project Workspace`}
            to={`/projects/${row.id}`}
            subtitle={row.externalCode ?? undefined}
          />
        );
      },
    },
    {
      id: 'hub',
      header: 'Hub',
      width: 'minmax(6.5rem, 0.9fr)',
      cell: (row) => <span className="truncate text-xs font-semibold text-text">{row.hub}</span>,
    },
    {
      id: 'type',
      header: 'Type',
      width: '3.5rem',
      align: 'center',
      cell: (row) =>
        row.type ? (
          <abbr title={typeLabel(row.type)} className="text-xs font-bold text-text no-underline">
            {row.type}
          </abbr>
        ) : (
          DASH
        ),
    },
    {
      id: 'category',
      header: 'Cat',
      width: '3.75rem',
      align: 'center',
      cell: (row) => (row.category ? <CategoryTag category={row.category} /> : DASH),
    },
    {
      id: 'priority',
      header: 'Priority',
      width: '4.5rem',
      align: 'center',
      cell: (row) => (row.priority ? <PriorityBandPill priority={row.priority} /> : DASH),
    },
    {
      id: 'status',
      header: 'Status',
      width: 'minmax(8.5rem, 1fr)',
      cell: (row) => <ProjectStatusBadge status={row.status} />,
    },
  ];
  if (source === 'pipeline') return base;
  return [
    ...base,
    {
      id: 'finish',
      header: 'Finish',
      width: '5rem',
      align: 'center',
      cell: (row) =>
        row.finishWeek !== null ? (
          <span className="text-xs font-semibold tabular-nums text-text" data-numeric="">
            {formatPlanWeek(row.finishWeek)}
          </span>
        ) : (
          DASH
        ),
    },
    {
      id: 'outcome',
      header: 'Outcome',
      width: '7rem',
      cell: () => (
        <span className="inline-flex items-center gap-1 rounded-pill bg-success-subtle px-2 py-0.5 text-2xs font-semibold text-success-subtle-fg">
          <CalendarCheck className="size-3" aria-hidden="true" />
          Within year
        </span>
      ),
    },
  ];
}

/* ---------------------------------- dialog --------------------------------- */

export interface HubTypeDrilldownDialogProps {
  target: DrillTarget | null;
  onClose: () => void;
  /** Global filter, passed to the register query (ANDed with the scope server-side). */
  hubId: string | null;
  region: LabRegion | null;
  /** The loaded `/dashboard/completing-within-year` rows (same filter). */
  runRows: CompletingWithinYearRow[] | null;
  /** Where focus returns on close (the clicked figure). */
  returnFocusTo: React.RefObject<HTMLElement | null>;
}

export function HubTypeDrilldownDialog({
  target,
  onClose,
  hubId,
  region,
  runRows,
  returnFocusTo,
}: HubTypeDrilldownDialogProps): React.JSX.Element {
  return (
    <Dialog open={target !== null} onOpenChange={(open) => (open ? undefined : onClose())}>
      <DialogContent
        className="flex max-h-[calc(100vh-2rem)] w-[calc(100vw-1.5rem)] max-w-5xl flex-col motion-reduce:animate-none"
        data-testid="hub-type-drilldown"
        onCloseAutoFocus={(e) => {
          const el = returnFocusTo.current;
          if (el && el.isConnected) {
            e.preventDefault();
            el.focus();
          }
        }}
      >
        {target ? (
          <>
            <DialogHeader className="pr-8">
              <DialogTitle>{drillTitle(target)}</DialogTitle>
              <DialogDescription>
                {target.source === 'pipeline'
                  ? 'Project pipeline (every project, all statuses) for the current hub / country filter.'
                  : 'Projects the active schedule run completes within the year (by W52), for the current hub / country filter.'}
              </DialogDescription>
            </DialogHeader>
            {target.source === 'pipeline' ? (
              <PipelineList target={target} hubId={hubId} region={region} />
            ) : (
              <CompletingList target={target} runRows={runRows} />
            )}
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function PipelineList({
  target,
  hubId,
  region,
}: {
  target: DrillTarget;
  hubId: string | null;
  region: LabRegion | null;
}): React.JSX.Element {
  const hubs = useHubs();
  const cellHubId = target.hub ? hubs.data?.find((h) => h.name === target.hub)?.id : undefined;
  const resolvedHubId = target.hub ? cellHubId : (hubId ?? undefined);
  const hubResolved = target.hub === null || cellHubId !== undefined;
  // P31: the cell's own type, else (a Total cell) the Dashboard type selection;
  // and always the Dashboard category selection — the cell counts were served
  // for that same selection.
  const selection = useDashboardSelection();
  const query = useDrilldownProjects(
    {
      hub_id: resolvedHubId,
      region: region ?? undefined,
      type: target.typeKey !== null ? [target.typeKey] : selectionParam(selection.types),
      category: selectionParam(selection.categories),
    },
    hubResolved,
  );

  if (!hubResolved && !hubs.isPending) {
    return <ErrorState description={`The hub ${target.hub ?? ''} is not in the hub list.`} />;
  }
  if (query.isPending) return <ListSkeleton />;
  if (query.isError) {
    return <ErrorState description="The project list could not be loaded." onRetry={() => void query.refetch()} />;
  }
  return <DrillList source="pipeline" target={target} rows={query.data.rows.map(fromRegister)} />;
}

function CompletingList({
  target,
  runRows,
}: {
  target: DrillTarget;
  runRows: CompletingWithinYearRow[] | null;
}): React.JSX.Element {
  const rows = React.useMemo(() => {
    if (runRows === null) return null;
    return runRows
      .filter(
        (r) =>
          outcomeOf(r) === 'within_year' &&
          (target.hub === null || r.hub === target.hub) &&
          (target.typeKey === null || (r.type ?? 'Unmapped') === target.typeKey),
      )
      .sort((a, b) => a.project_name.localeCompare(b.project_name))
      .map(fromRun);
  }, [runRows, target]);
  if (rows === null) return <ListSkeleton />;
  return <DrillList source="completing" target={target} rows={rows} />;
}

function ListSkeleton(): React.JSX.Element {
  return (
    <div className="space-y-2" aria-busy="true">
      <span className="sr-only">Loading projects…</span>
      <Skeleton className="h-8 w-full" />
      <Skeleton className="h-8 w-5/6" />
      <Skeleton className="h-8 w-4/6" />
    </div>
  );
}

function DrillList({
  source,
  target,
  rows,
}: {
  source: DrillSource;
  target: DrillTarget;
  rows: DrillRow[];
}): React.JSX.Element {
  const cols = React.useMemo(() => columns(source), [source]);
  const mismatch = rows.length !== target.count;
  return (
    <div className="flex min-h-0 flex-col gap-s3">
      <p className="text-sm font-semibold text-text" data-testid="drilldown-count" data-count={rows.length}>
        {formatInteger(rows.length)} {rows.length === 1 ? 'project' : 'projects'}
      </p>
      {mismatch ? (
        <p role="status" className="rounded-md bg-warning-subtle px-s3 py-s2 text-xs text-warning-subtle-fg" data-testid="drilldown-mismatch">
          This list has {formatInteger(rows.length)} projects but the table shows {formatInteger(target.count)}. The
          data may have changed since the page loaded; refresh to update both.
        </p>
      ) : null}
      {rows.length === 0 ? (
        <p className="py-s6 text-center text-sm text-text-muted">No projects.</p>
      ) : (
        <VirtualDataTable
          rows={rows}
          columns={cols}
          rowKey={(r) => r.id}
          caption={`${drillTitle(target)}: ${formatInteger(rows.length)} projects`}
          headerTone="ink"
          maxHeight={480}
          estimateRowHeight={52}
          className="min-h-0"
        />
      )}
    </div>
  );
}

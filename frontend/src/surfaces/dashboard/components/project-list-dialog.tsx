import * as React from 'react';
import { Link } from 'react-router-dom';

import { WeekText } from '@/components/shared/week-text';
import { CountryFlag } from '@/components/shared/hub-filter/country-flag';
import { PriorityBandPill } from '@/components/shared/priority-band-pill';
import { ProjectStatusBadge } from '@/components/shared/project-status-badge';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { formatInteger } from '@/lib/format';
import { toHubFilterParams, type HubSelection } from '@/stores/hub-filter';

import type { DashboardSelection } from '../api/dashboard-api';
import type { ProjectFilterParams, ProjectFilterRow } from '../api/types';
import { useDrilldownProjects } from '../hooks/use-dashboard';
import { VirtualDataTable, type VirtualColumn } from './virtual-data-table';

/**
 * Owner ask 2026-11-13: clicking a Dashboard composition figure (a Project
 * pipeline card, a Status overview card, a country chip under either, a hub in
 * "Top hubs") lists the projects behind it.
 *
 * The rows are `GET /dashboard/projects` fetched with the SAME scope as the
 * figures (the global hub / country filter and the Dashboard-wide category /
 * type selection, `_dashboard_filter` on the server), then SELECTED by the
 * card's own rule on served row fields (`carry_over`, `reg_year`, `status`,
 * `region`, `hub`) — pure selection, nothing recomputed (I19). The card's
 * served count is passed in; if the fresh list disagrees (data changed since
 * the card loaded), the dialog says so rather than hiding it.
 */

export interface ProjectListRequest {
  /** Dialog title, e.g. "Spillover 2025 · India". */
  title: string;
  /** The served count shown on the clicked figure. */
  expected: number;
  /** Selection rule over served row fields. */
  match: (row: ProjectFilterRow) => boolean;
  /** A chart that ignores part of the Dashboard selection (the type chart
   *  ignores the type filter, the category chart the category filter) lists
   *  its projects with that part dropped too, so the list matches the bar. */
  ignoreSelection?: 'types' | 'categories' | undefined;
}

/** `opener` receives focus back when the dialog closes (a chart bar has no
 *  focusable element, so it may be null). */
type OpenProjectList = (request: ProjectListRequest, opener: HTMLElement | null) => void;

const ProjectListContext = React.createContext<OpenProjectList | null>(null);

/** `null` outside a `ProjectListProvider`: the figure then renders as plain,
 *  non-clickable text (component tests, the Executive view). */
export function useOpenProjectList(): OpenProjectList | null {
  return React.useContext(ProjectListContext);
}

export interface ProjectListScope {
  /** The global hub / country selection (multi-select; the server unions hubs and countries). */
  hub: HubSelection;
  selection: DashboardSelection;
}

export function ProjectListProvider({
  scope,
  children,
}: {
  scope: ProjectListScope;
  children: React.ReactNode;
}): React.JSX.Element {
  const [request, setRequest] = React.useState<ProjectListRequest | null>(null);
  const openerRef = React.useRef<HTMLElement | null>(null);
  const open = React.useCallback<OpenProjectList>((req, opener) => {
    openerRef.current = opener;
    setRequest(req);
  }, []);

  return (
    <ProjectListContext.Provider value={open}>
      {children}
      <ProjectListDialog
        scope={scope}
        request={request}
        onClose={() => setRequest(null)}
        returnFocusTo={openerRef}
      />
    </ProjectListContext.Provider>
  );
}

function scopeParams(scope: ProjectListScope, ignore: ProjectListRequest['ignoreSelection']): ProjectFilterParams {
  const categories = ignore === 'categories' ? [] : scope.selection.categories;
  const types = ignore === 'types' ? [] : scope.selection.types;
  const hub = toHubFilterParams(scope.hub.hubIds, scope.hub.regions);
  return {
    ...(hub.hub_id ? { hub_id: hub.hub_id } : {}),
    ...(hub.region ? { region: hub.region } : {}),
    ...(categories.length > 0 ? { category: categories } : {}),
    ...(types.length > 0 ? { type: types } : {}),
  };
}

const COLUMNS: VirtualColumn<ProjectFilterRow>[] = [
  {
    id: 'project',
    header: 'Project',
    width: 'minmax(12rem, 2.4fr)',
    cell: (row) => (
      <span className="flex min-w-0 flex-col">
        <Link
          to={`/projects/${row.project_id}`}
          className="truncate text-xs font-semibold text-text underline-offset-2 hover:underline focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          title={row.project_name}
        >
          {row.project_name}
        </Link>
        {row.external_code ? (
          <span className="truncate text-2xs tabular-nums text-text-muted">{row.external_code}</span>
        ) : null}
      </span>
    ),
  },
  {
    id: 'hub',
    header: 'Hub',
    width: 'minmax(7rem, 1fr)',
    cell: (row) => (
      <span className="flex min-w-0 items-center gap-1.5 text-xs text-text">
        <CountryFlag region={row.region} />
        <span className="truncate">{row.hub}</span>
      </span>
    ),
  },
  {
    id: 'status',
    header: 'Status',
    width: 'minmax(8rem, 1.2fr)',
    cell: (row) => <ProjectStatusBadge status={row.status} className="max-w-full truncate" />,
  },
  {
    id: 'priority',
    header: 'Priority',
    width: '5rem',
    cell: (row) =>
      row.priority ? <PriorityBandPill priority={row.priority} /> : <span className="text-xs text-text-muted">—</span>,
  },
  {
    id: 'end-week',
    header: 'End week',
    width: '5.5rem',
    align: 'right',
    cell: (row) => (
      <span className="text-xs tabular-nums text-text" data-numeric="">
        {row.end_week === null ? '—' : <WeekText week={row.end_week} />}
      </span>
    ),
  },
];

function ProjectListDialog({
  scope,
  request,
  onClose,
  returnFocusTo,
}: {
  scope: ProjectListScope;
  request: ProjectListRequest | null;
  onClose: () => void;
  returnFocusTo: React.RefObject<HTMLElement | null>;
}): React.JSX.Element {
  const query = useDrilldownProjects(scopeParams(scope, request?.ignoreSelection), request !== null);
  const selected = React.useMemo(
    () => (request && query.data ? query.data.rows.filter(request.match) : []),
    [request, query.data],
  );
  const loading = request !== null && query.isPending;
  const mismatch = request !== null && query.data !== undefined && selected.length !== request.expected;

  return (
    <Dialog open={request !== null} onOpenChange={(isOpen) => { if (!isOpen) onClose(); }}>
      <DialogContent
        className="flex max-h-[calc(100vh-4rem)] max-w-4xl flex-col motion-reduce:animate-none"
        data-testid="project-list-dialog"
        onCloseAutoFocus={(event) => {
          const target = returnFocusTo.current;
          if (target) {
            event.preventDefault();
            target.focus();
          }
        }}
      >
        {request ? (
          <>
            <DialogHeader>
              <DialogTitle data-testid="project-list-dialog-title">
                {request.title} — {formatInteger(request.expected)}{' '}
                {request.expected === 1 ? 'project' : 'projects'}
              </DialogTitle>
              <DialogDescription>
                The projects behind this figure, with the Dashboard&apos;s current hub, country, category and
                type filters. Click a project to open its workspace.
              </DialogDescription>
            </DialogHeader>
            {mismatch ? (
              <p className="rounded-md bg-warning-subtle px-s3 py-s2 text-xs text-warning-subtle-fg" role="status">
                The list now has {formatInteger(selected.length)} — the data changed since the card loaded. Reload
                the Dashboard to refresh the figures.
              </p>
            ) : null}
            {loading ? (
              <div className="space-y-s2" aria-busy="true" aria-label="Loading projects">
                <Skeleton className="h-8" />
                <Skeleton className="h-8" />
                <Skeleton className="h-8" />
              </div>
            ) : query.isError ? (
              <p className="text-sm text-danger" role="alert">
                The projects could not be loaded. Please try again.
              </p>
            ) : selected.length === 0 ? (
              <p className="text-sm text-text-muted">No projects here.</p>
            ) : (
              <VirtualDataTable
                rows={selected}
                columns={COLUMNS}
                rowKey={(row) => row.project_id}
                caption={request.title}
                maxHeight={460}
              />
            )}
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/**
 * Overlay that turns a whole card into one click target without nesting
 * interactive elements: an absolutely positioned <button> covers the card
 * (which must be `relative`), and inner controls (country chips) sit above it
 * with `relative z-[2]`.
 */
export function CardOpenButton({
  label,
  onOpen,
  testId,
}: {
  label: string;
  onOpen: (el: HTMLButtonElement) => void;
  testId?: string;
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      aria-label={label}
      title={label}
      data-testid={testId}
      onClick={(event) => { onOpen(event.currentTarget); }}
      className="absolute inset-0 z-[1] cursor-pointer rounded-[inherit] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
    />
  );
}

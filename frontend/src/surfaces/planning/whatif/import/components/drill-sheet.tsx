import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import type { ColumnDef } from '@tanstack/react-table';
import { ExternalLink, GanttChartSquare, Search, X } from 'lucide-react';
import { Link } from 'react-router-dom';

import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

import { int } from '../../components/figures';
import { OUTCOME_LABEL, OUTCOME_TONE } from '../../components/outcome-meta';
import { listedCount, type Drill, type DrillRow, type ProjectDrill } from '../drilldown';
import { useDrill } from '../drill-store';
import { useImportPlan } from '../import-store';
import type { ImportResultProject } from '../import-types';
import { weekOrDash } from '../week-labels';
import { projectInYear, YEAR_ALL } from '../year-filter';
import { DrillTable } from './drill-table';

/**
 * The drill-down side sheet (P32-R07): one sheet for every clickable figure of the import
 * Review and Results. A right-hand sheet from `sm` up, full screen on a phone; Escape and the
 * close button return focus to the figure. The header count is the clicked (served) figure;
 * when the planner counts projects it does not return, the list says "N of M shown (why)".
 */

/** "(k/n)" at the end of an expanded copy's served name (P32-R03 naming). */
function copyOf(name: string): string | null {
  return /\((\d+\/\d+)\)\s*$/.exec(name)?.[1] ?? null;
}

function SourceCell({ p }: { p: ImportResultProject }): React.JSX.Element {
  if (p.source === 'plan') return <Badge tone="neutral">plan</Badge>;
  const copy = copyOf(p.name);
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      <Badge tone="primary">file</Badge>
      {p.file_row !== null ? <span className="text-text-muted">{`row ${String(p.file_row)}`}</span> : null}
      {copy ? <span className="tabular-nums text-text-muted">{`(${copy})`}</span> : null}
    </span>
  );
}

function projectColumns(drill: ProjectDrill, onGantt: (p: ImportResultProject) => void): ColumnDef<ImportResultProject>[] {
  const base = drill.baseYear;
  return [
    {
      id: 'name',
      header: 'Project',
      accessorKey: 'name',
      cell: ({ row }) => <span className="font-medium">{row.original.name}</span>,
    },
    {
      id: 'source',
      header: 'Source',
      accessorFn: (p) => `${p.source}-${String(p.file_row ?? 0).padStart(5, '0')}`,
      cell: ({ row }) => <SourceCell p={row.original} />,
    },
    { id: 'hub', header: 'Hub', accessorKey: 'hub' },
    { id: 'category', header: 'Category', accessorKey: 'category' },
    { id: 'priority', header: 'Priority', accessorKey: 'priority' },
    { id: 'status', header: 'Status', accessorKey: 'status' },
    {
      id: 'leader',
      header: 'Leader',
      accessorFn: (p) => p.leader_name ?? '',
      cell: ({ row }) => (
        <span className="inline-flex items-center gap-1 whitespace-nowrap">
          {row.original.leader_name ?? <span className="text-text-muted">none</span>}
          {row.original.leader_auto_assigned ? <Badge tone="warning">auto</Badge> : null}
        </span>
      ),
    },
    {
      id: 'finish',
      header: 'Finish',
      accessorFn: (p) => p.finish_week ?? Number.POSITIVE_INFINITY,
      cell: ({ row }) => <span className="whitespace-nowrap tabular-nums">{weekOrDash(row.original.finish_week, base)}</span>,
    },
    {
      id: 'outcome',
      header: 'Outcome',
      accessorKey: 'outcome',
      cell: ({ row }) => <Badge tone={OUTCOME_TONE[row.original.outcome]}>{OUTCOME_LABEL[row.original.outcome]}</Badge>,
    },
    {
      id: 'before_after',
      header: 'Before → after',
      accessorFn: (p) => p.before_finish_week ?? Number.POSITIVE_INFINITY,
      cell: ({ row }) => {
        const p = row.original;
        if (p.source !== 'plan') return <span className="text-text-muted">—</span>;
        return (
          <span className="whitespace-nowrap tabular-nums">
            {weekOrDash(p.before_finish_week, base)} <span aria-hidden="true">→</span>
            <span className="sr-only"> to </span> {weekOrDash(p.finish_week, base)}
          </span>
        );
      },
    },
    {
      id: 'actions',
      header: 'Actions',
      enableSorting: false,
      cell: ({ row }) => {
        const p = row.original;
        return (
          <span className="inline-flex items-center gap-1 whitespace-nowrap">
            {drill.gantt ? (
              <button
                type="button"
                className="inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-2xs font-semibold text-primary hover:bg-primary-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                onClick={() => onGantt(p)}
                aria-label={`Show ${p.name} on the Gantt`}
                data-testid="drill-show-gantt"
              >
                <GanttChartSquare className="size-3.5" aria-hidden="true" />
                Show on Gantt
              </button>
            ) : null}
            {p.source === 'plan' ? (
              <Link
                to={`/projects/${encodeURIComponent(p.ref)}`}
                className="inline-flex h-7 items-center gap-1 rounded-md px-1.5 text-2xs font-semibold text-primary hover:bg-primary-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`Open project ${p.name}`}
                data-testid="drill-open-project"
              >
                <ExternalLink className="size-3.5" aria-hidden="true" />
                Open project
              </Link>
            ) : null}
          </span>
        );
      },
    },
  ];
}

function engineerOf(r: DrillRow['row']): string {
  if (r.leader.kind === 'existing') return r.leader.name;
  if (r.leader.kind === 'new') return `${r.leader.name} (new)`;
  return 'Auto-assign';
}

const ROW_COLUMNS: ColumnDef<DrillRow>[] = [
  {
    id: 'name',
    header: 'Row',
    accessorFn: (d) => d.row.name,
    cell: ({ row }) => (
      <span className="font-medium">
        {row.original.row.name}
        {row.original.copy ? <span className="ml-1 tabular-nums text-text-muted">{`(${row.original.copy})`}</span> : null}
      </span>
    ),
  },
  {
    id: 'file_row',
    header: 'File row',
    accessorFn: (d) => d.row.file_row,
    cell: ({ row }) => <span className="tabular-nums">{row.original.row.file_row}</span>,
  },
  { id: 'hub', header: 'Hub', accessorFn: (d) => d.row.hub },
  { id: 'category', header: 'Category', accessorFn: (d) => d.row.category },
  { id: 'status', header: 'Status', accessorFn: (d) => d.row.status },
  { id: 'priority', header: 'Priority', accessorFn: (d) => d.row.priority },
  {
    id: 'engineer',
    header: 'Engineer',
    accessorFn: (d) => engineerOf(d.row),
    cell: ({ row }) => {
      const r = row.original.row;
      return r.leader.kind === 'auto' ? <Badge tone="warning">auto-assign</Badge> : <span>{engineerOf(r)}</span>;
    },
  },
  {
    id: 'issues',
    header: 'Issues',
    accessorFn: (d) => d.issues.length,
    cell: ({ row }) => {
      const issues = row.original.issues;
      if (issues.length === 0) return <span className="text-text-muted">—</span>;
      return (
        <span className="line-clamp-2 max-w-[22rem] text-2xs text-text-muted" title={issues.map((i) => i.message).join('\n')}>
          {issues.map((i) => i.message).join(' · ')}
        </span>
      );
    },
  },
];

function matchesProject(p: ImportResultProject, q: string): boolean {
  return [p.name, p.hub, p.category, p.priority, p.status, p.leader_name ?? ''].some((v) => v.toLowerCase().includes(q));
}

function matchesRow(d: DrillRow, q: string): boolean {
  const r = d.row;
  return [r.name, r.hub, r.category, r.status, r.priority, engineerOf(r), String(r.file_row)].some((v) =>
    v.toLowerCase().includes(q),
  );
}

function unitOf(d: Drill, n: number): string {
  const unit = d.kind === 'projects' ? 'projects' : d.unit;
  return n === 1 ? unit.replace(/s$/, '') : unit;
}

function DrillBody({ drill }: { drill: Drill }): React.JSX.Element {
  const close = useDrill((s) => s.close);
  const focusOnGantt = useImportPlan((s) => s.focusOnGantt);
  const yearKey = useImportPlan((s) => s.yearFilter);
  const [query, setQuery] = React.useState('');
  const q = query.trim().toLowerCase();
  const listed = listedCount(drill);
  const total = drill.kind === 'projects' ? drill.projects.length : drill.rows.length;

  const onGantt = React.useCallback(
    (p: ImportResultProject) => {
      if (drill.kind !== 'projects') return;
      close(false);
      const shown = yearKey === YEAR_ALL || projectInYear(p, yearKey, drill.baseYear);
      focusOnGantt({ ref: p.ref, name: p.name }, !shown);
    },
    [close, focusOnGantt, yearKey, drill],
  );
  const projectCols = React.useMemo(
    () => (drill.kind === 'projects' ? projectColumns(drill, onGantt) : []),
    [drill, onGantt],
  );
  const projects = drill.kind === 'projects' ? drill.projects.filter((p) => q === '' || matchesProject(p, q)) : [];
  const rows = drill.kind === 'rows' ? drill.rows.filter((d) => q === '' || matchesRow(d, q)) : [];
  const shownCount = drill.kind === 'projects' ? projects.length : rows.length;
  const searchId = React.useId();

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-s3 p-s4 sm:p-s5">
      <div className="space-y-1 pr-8">
        <DialogPrimitive.Title className="text-base font-semibold text-text" data-testid="drill-title">
          {`${drill.title} · ${int(drill.figure)} ${unitOf(drill, drill.figure)}`}
        </DialogPrimitive.Title>
        <DialogPrimitive.Description className="text-2xs text-text-muted">
          {drill.context ? `${drill.context} · ` : ''}
          <span data-testid="drill-count" data-count={listed}>
            {drill.kind === 'rows' && drill.note
              ? drill.note
              : `${int(total)} ${drill.kind === 'projects' ? unitOf(drill, total) : total === 1 ? 'row' : 'rows'} listed`}
          </span>
        </DialogPrimitive.Description>
        {drill.shortfall ? (
          <p className="text-2xs font-medium text-warning-subtle-fg" role="note" data-testid="drill-shortfall">
            {`${int(listed)} of ${int(drill.figure)} shown (${drill.shortfall})`}
          </p>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-s2">
        <label htmlFor={searchId} className="sr-only">
          Search the list
        </label>
        <span className="relative min-w-0 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-text-muted" aria-hidden="true" />
          <Input
            id={searchId}
            type="search"
            className="h-8 pl-7 text-xs"
            placeholder="Search name, hub, leader…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            data-testid="drill-search"
          />
        </span>
        {q !== '' ? (
          <span className="text-2xs text-text-muted" role="status" aria-live="polite">
            {`${int(shownCount)} of ${int(total)} match`}
          </span>
        ) : null}
      </div>
      {total === 0 ? (
        <p className="text-xs text-text-muted" data-testid="drill-empty">
          Nothing to list.
        </p>
      ) : drill.kind === 'projects' ? (
        <DrillTable
          data={projects}
          columns={projectCols}
          rowId={(p) => p.ref}
          label={drill.title}
          rowTestId="drill-row"
          minWidth={1080}
        />
      ) : (
        <DrillTable
          data={rows}
          columns={ROW_COLUMNS}
          rowId={(d) => d.id}
          label={drill.title}
          rowTestId="drill-row"
          minWidth={900}
        />
      )}
    </div>
  );
}

export function DrillSheet(): React.JSX.Element {
  const drill = useDrill((s) => s.drill);
  const close = useDrill((s) => s.close);
  return (
    <DialogPrimitive.Root
      open={drill !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            'fixed inset-0 z-50 bg-slate-950/40',
            'data-[state=open]:animate-in data-[state=open]:fade-in-0 motion-reduce:animate-none',
          )}
        />
        <DialogPrimitive.Content
          data-testid="drill-sheet"
          onCloseAutoFocus={(event) => {
            // Back to the figure that opened it; "Show on Gantt" moves focus itself.
            event.preventDefault();
            const opener = useDrill.getState().opener;
            if (opener && opener.isConnected) opener.focus();
          }}
          className={cn(
            // Full screen on a phone; a right-hand sheet from `sm` up.
            'fixed inset-y-0 right-0 z-50 flex h-full w-full flex-col bg-surface shadow-lg sm:max-w-3xl sm:border-l sm:border-border lg:max-w-5xl',
            'data-[state=open]:animate-in data-[state=open]:slide-in-from-right motion-reduce:animate-none',
          )}
        >
          {drill ? <DrillBody key={`${drill.title}|${drill.context ?? ''}`} drill={drill} /> : null}
          <DialogPrimitive.Close
            className="absolute right-3 top-3 rounded p-1 text-text-muted transition-colors hover:bg-surface-raised hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Close"
          >
            <X className="size-4" aria-hidden="true" />
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

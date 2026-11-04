import * as React from 'react';
import { flexRender, getCoreRowModel, useReactTable, type CellContext, type ColumnDef } from '@tanstack/react-table';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Link2, TriangleAlert } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import { cn } from '@/lib/utils';
import {
  HUB_NAMES,
  PROJECT_PRIORITIES,
  UI_PROJECT_STATUSES,
  type ProjectCategory,
  type ProjectPriority,
} from '@/types/enums';

import type { WhatIfHub } from '../../../api/whatif-types';
import { NativeSelect } from '../../components/form-controls';
import {
  ENGINEER_ISSUE_CODES,
  copiesOfRow,
  isMappedStatus,
  withStatus,
  categoriesForWorkflow,
  stepsOfWorkflow,
  withHubOrCategory,
  workflowOfHub,
} from '../import-rows';
import { useImportPlan } from '../import-store';
import type { ImportParseIssue, ImportParseResponse, ImportRow } from '../import-types';
import { EngineerPicker } from './engineer-picker';

const ROW_H = 52;
const VIRTUALIZE_OVER = 100;

function priorityHint(row: ImportRow, original: ImportRow | undefined): string {
  if (original && original.priority !== row.priority) return 'edited';
  if (row.priority_source === 'rank') return row.rank === null ? 'ranked' : `rank ${String(row.rank)}`;
  if (row.priority_source === 'matched') return 'from plan';
  return 'default';
}

interface Ctx {
  parsed: ImportParseResponse;
  originals: Map<string, ImportRow>;
  issuesByRow: Map<string, ImportParseIssue[]>;
  errors: Record<string, string>;
  update: (key: string, next: ImportRow) => void;
}

const ReviewCtx = React.createContext<Ctx | null>(null);

function useCtx(): Ctx {
  const c = React.useContext(ReviewCtx);
  if (!c) throw new Error('ReviewCtx missing');
  return c;
}
const sel = 'h-7 text-xs';

type Cell = CellContext<ImportRow, unknown>;

function IncludeCell({ row: { original: r } }: Cell): React.JSX.Element {
  const { update } = useCtx();
  const mapped = isMappedStatus(r.status);
  return (
    <Checkbox
      checked={r.include}
      disabled={!mapped}
      title={mapped ? undefined : `${r.status} projects are not mapped; change the status to include it`}
      aria-label={`Include ${r.name}`}
      onCheckedChange={(v) => update(r.key, { ...r, include: v === true })}
    />
  );
}

function ProjectCell({ row: { original: r } }: Cell): React.JSX.Element {
  const { issuesByRow } = useCtx();
  // The chip follows the option: with expansion off the row stays one project (P32-R03).
  const copies = copiesOfRow(
    r,
    useImportPlan((s) => s.options.expandMulti),
  );
  const issues = issuesByRow.get(r.key) ?? [];
  const worst = issues.some((i) => i.severity === 'error')
    ? 'error'
    : issues.some((i) => i.severity === 'warning')
      ? 'warning'
      : null;
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="flex min-w-0 items-center gap-1">
        <span className="font-mono text-2xs text-text-muted">{`Row ${String(r.file_row)}`}</span>
        <span className="truncate text-xs font-medium text-text" title={r.name}>
          {r.name}
        </span>
        {copies >= 2 ? (
          <Badge
            tone="neutral"
            className="shrink-0"
            title={`This row becomes ${String(copies)} projects: ${r.name} (1/${String(copies)}) … (${String(copies)}/${String(copies)})`}
            data-testid="import-copies"
          >
            <span aria-hidden="true">{`×${String(copies)} projects`}</span>
            <span className="sr-only">{`becomes ${String(copies)} projects`}</span>
          </Badge>
        ) : null}
        {worst ? (
          <span
            role="img"
            aria-label={`${String(issues.length)} issue${issues.length === 1 ? '' : 's'}: ${issues.map((i) => i.message).join('; ')}`}
            title={issues.map((i) => i.message).join('\n')}
            className={worst === 'error' ? 'text-danger' : 'text-warning-subtle-fg'}
          >
            <TriangleAlert className="size-3.5" aria-hidden="true" />
          </span>
        ) : null}
      </span>
      {r.matched_project_id && r.matched_project_name ? (
        <Badge tone="primary" className="w-fit max-w-full" data-testid="import-replaces">
          <Link2 aria-hidden="true" />
          <span className="truncate">{`replaces: ${r.matched_project_name}`}</span>
        </Badge>
      ) : null}
    </div>
  );
}

function HubCell({ row: { original: r } }: Cell): React.JSX.Element {
  const { parsed, update } = useCtx();
  return (
    <NativeSelect
      className={sel}
      aria-label={`Hub for ${r.name}`}
      value={r.hub}
      onChange={(e) => update(r.key, withHubOrCategory(r, { hub: e.target.value as WhatIfHub }, parsed))}
    >
      {HUB_NAMES.map((h) => (
        <option key={h} value={h}>
          {h}
        </option>
      ))}
    </NativeSelect>
  );
}

function CategoryCell({ row: { original: r } }: Cell): React.JSX.Element {
  const { parsed, update } = useCtx();
  return (
    <NativeSelect
      className={sel}
      aria-label={`Category for ${r.name}`}
      value={r.category}
      onChange={(e) => update(r.key, withHubOrCategory(r, { category: e.target.value as ProjectCategory }, parsed))}
    >
      {categoriesForWorkflow(workflowOfHub(r.hub)).map((c) => (
        <option key={c} value={c}>
          {c}
        </option>
      ))}
    </NativeSelect>
  );
}

function StatusCell({ row: { original: r } }: Cell): React.JSX.Element {
  const { update } = useCtx();
  const opts = (UI_PROJECT_STATUSES as readonly string[]).includes(r.status)
    ? UI_PROJECT_STATUSES
    : [r.status, ...UI_PROJECT_STATUSES];
  return (
    <NativeSelect
      className={sel}
      aria-label={`Status for ${r.name}`}
      value={r.status}
      onChange={(e) => update(r.key, withStatus(r, e.target.value))}
    >
      {opts.map((s) => (
        <option key={s} value={s}>
          {s}
        </option>
      ))}
    </NativeSelect>
  );
}

function PriorityCell({ row: { original: r } }: Cell): React.JSX.Element {
  const { originals, update } = useCtx();
  return (
    <div className="flex flex-col gap-0.5">
      <NativeSelect
        className={sel}
        aria-label={`Priority for ${r.name}`}
        aria-describedby={`prio-hint-${r.key}`}
        value={r.priority}
        onChange={(e) => update(r.key, { ...r, priority: e.target.value as ProjectPriority })}
      >
        {PROJECT_PRIORITIES.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </NativeSelect>
      <span id={`prio-hint-${r.key}`} className="text-2xs text-text-muted" data-testid="import-priority-hint">
        {priorityHint(r, originals.get(r.key))}
      </span>
    </div>
  );
}

function StageCell({ row: { original: r } }: Cell): React.JSX.Element {
  const { parsed, update } = useCtx();
  return (
    <NativeSelect
      className={sel}
      aria-label={`Stage for ${r.name}`}
      value={r.stage_step_id ?? ''}
      onChange={(e) =>
        update(r.key, {
          ...r,
          stage_step_id: e.target.value === '' ? null : e.target.value,
        })
      }
    >
      <option value="">First step</option>
      {stepsOfWorkflow(parsed.steps_meta, workflowOfHub(r.hub)).map((s) => (
        <option key={s.step_id} value={s.step_id}>
          {`${s.step_id} · ${s.name}`}
        </option>
      ))}
    </NativeSelect>
  );
}

function EngineerCell({ row: { original: r } }: Cell): React.JSX.Element {
  const { parsed, errors, update } = useCtx();
  return (
    <EngineerPicker
      id={`eng-${r.key}`}
      rowName={r.name}
      hub={r.hub}
      leader={r.leader}
      roster={parsed.roster}
      error={errors[r.key]}
      onChange={(leader) => update(r.key, { ...r, leader })}
    />
  );
}

/** Module-level and stable: `flexRender` treats a cell function as a component type, so a
 *  column set rebuilt on every edit would remount the inputs (and drop the focus). */
const COLUMNS: ColumnDef<ImportRow>[] = [
  { id: 'include', header: 'Include', size: 64, cell: IncludeCell },
  { id: 'project', header: 'Project', size: 240, cell: ProjectCell },
  { id: 'hub', header: 'Hub', size: 150, cell: HubCell },
  { id: 'category', header: 'Category', size: 90, cell: CategoryCell },
  { id: 'status', header: 'Status', size: 190, cell: StatusCell },
  { id: 'priority', header: 'Priority', size: 90, cell: PriorityCell },
  { id: 'stage', header: 'Stage', size: 220, cell: StageCell },
  { id: 'engineer', header: 'Engineer', size: 200, cell: EngineerCell },
];

/** The editable rows (TanStack Table + Virtual; virtualized over 100 rows). */
export function ReviewTable({
  rows,
  parsed,
  issuesByRow,
  errors,
  update,
  label = 'Rows of the file',
}: {
  label?: string;
  rows: readonly ImportRow[];
  parsed: ImportParseResponse;
  issuesByRow: Map<string, ImportParseIssue[]>;
  errors: Record<string, string>;
  update: (key: string, next: ImportRow) => void;
}): React.JSX.Element {
  const originals = React.useMemo(() => new Map(parsed.rows.map((r) => [r.key, r])), [parsed.rows]);
  const ctx = React.useMemo<Ctx>(
    () => ({ parsed, originals, issuesByRow, errors, update }),
    [parsed, originals, issuesByRow, errors, update],
  );
  const cols = COLUMNS;
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Table + Virtual are the mandated table stack.
  const table = useReactTable({
    data: rows as ImportRow[],
    columns: cols,
    getCoreRowModel: getCoreRowModel(),
    getRowId: (r) => r.key,
  });
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const tableRows = table.getRowModel().rows;
  const virtual = tableRows.length > VIRTUALIZE_OVER;
  const virtualizer = useVirtualizer({
    count: virtual ? tableRows.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 6,
    initialRect: { width: 1200, height: 520 },
  });
  const items = virtual ? virtualizer.getVirtualItems() : tableRows.map((_, index) => ({ index, start: 0, end: 0 }));
  const top = virtual ? (items[0]?.start ?? 0) : 0;
  const bottom = virtual ? virtualizer.getTotalSize() - (items.at(-1)?.end ?? 0) : 0;
  const width = cols.reduce((s, c) => s + (c.size ?? 120), 0);

  return (
    <ReviewCtx.Provider value={ctx}>
      <div
        ref={scrollRef}
        className="max-h-[32rem] overflow-auto rounded-md border border-border"
        role="region"
        aria-label={`${label} (scrollable)`}
        tabIndex={0}
        data-testid="import-review-table"
      >
        <table
          className="table-fixed border-collapse text-left"
          style={{ width: '100%', minWidth: width }}
          aria-label={label}
        >
          {/* Fixed layout: every editable column keeps its width so a select shows its full value;
              the project name truncates (full name in its title) and the region scrolls sideways. */}
          <colgroup>
            {table.getAllLeafColumns().map((c) => (
              <col key={c.id} style={{ width: c.getSize() }} />
            ))}
          </colgroup>
          <thead className="sticky top-0 z-10 bg-surface-raised">
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h) => (
                  <th
                    key={h.id}
                    scope="col"
                    style={{ width: h.getSize() }}
                    className="border-b border-border px-s2 py-1.5 text-2xs font-semibold uppercase tracking-wide text-text-muted"
                  >
                    {flexRender(h.column.columnDef.header, h.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody data-virtualized={virtual || undefined}>
            {top > 0 ? (
              <tr aria-hidden="true">
                <td colSpan={cols.length} style={{ height: top, padding: 0 }} />
              </tr>
            ) : null}
            {items.map((v) => {
              const row = tableRows[v.index];
              if (!row) return null;
              const r = row.original;
              const engIssue = (issuesByRow.get(r.key) ?? []).some((i) => ENGINEER_ISSUE_CODES.has(i.code));
              const flagged = r.include && (engIssue || r.leader.kind === 'auto');
              return (
                <tr
                  key={row.id}
                  style={{ height: ROW_H }}
                  className={cn(
                    'border-b border-border align-middle',
                    !r.include && 'text-text-muted',
                    flagged && 'bg-warning-subtle/40',
                  )}
                  data-testid="import-review-row"
                  data-row-key={r.key}
                  data-flagged={flagged || undefined}
                >
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id} className="px-s2 py-1">
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              );
            })}
            {bottom > 0 ? (
              <tr aria-hidden="true">
                <td colSpan={cols.length} style={{ height: bottom, padding: 0 }} />
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </ReviewCtx.Provider>
  );
}

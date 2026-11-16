import * as React from 'react';
import type { ColumnDef } from '@tanstack/react-table';
import { ListChecks, Search } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from '@/components/ui/sheet';

import { int } from '../../components/figures';
import { NativeSelect } from '../../components/form-controls';
import { computeBlockedReason } from '../import-schema';
import { useImportPlan } from '../import-store';
import {
  filterPicks,
  initialTicks,
  NO_PICK_FILTERS,
  pickItems,
  picksToRequest,
  pickValues,
  type PickFilters,
  type PickItem,
} from '../project-picks';
import { DrillTable } from './drill-table';

/**
 * P41 (ADR 0055 D2, contract E2): "Pick projects…". A right-hand sheet (the drill-down
 * sheet's pattern) listing the file rows and, in merge mode, the served `plan_projects`,
 * each with a tick box. "Compute scenario" includes the ticked rows and sends the unticked
 * plan projects as `exclude_plan_project_ids`; the results then re-simulate. The list is
 * virtualized over 100 rows (DrillTable).
 */
export function PickProjectsButton({ disabled }: { disabled: boolean }): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button type="button" size="sm" variant="secondary" disabled={disabled} onClick={() => setOpen(true)}>
        <ListChecks />
        Pick projects…
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent className="sm:max-w-3xl lg:max-w-5xl" data-testid="import-picker">
          {open ? <PickerBody onClose={() => setOpen(false)} /> : null}
        </SheetContent>
      </Sheet>
    </>
  );
}

const SOURCE_LABEL: Record<string, string> = { file: 'File row', plan: 'Plan project' };

function PickerBody({ onClose }: { onClose: () => void }): React.JSX.Element {
  const rows = useImportPlan((s) => s.rows);
  const mode = useImportPlan((s) => s.options.mode);
  const excludedPlanIds = useImportPlan((s) => s.excludedPlanIds);
  const planProjects = useImportPlan((s) => s.result?.plan_projects);
  const applyPicks = useImportPlan((s) => s.applyPicks);

  const served = React.useMemo(() => planProjects ?? [], [planProjects]);
  const items = React.useMemo(() => pickItems(rows, served, mode), [rows, served, mode]);
  const [ticks, setTicks] = React.useState<Set<string>>(() => initialTicks(rows, served, excludedPlanIds));
  const [filters, setFilters] = React.useState<PickFilters>(NO_PICK_FILTERS);
  const shown = React.useMemo(() => filterPicks(items, filters), [items, filters]);
  const selectable = items.filter((it) => it.locked === null);
  const included = selectable.filter((it) => ticks.has(it.id)).length;

  const toggle = React.useCallback(
    (id: string) =>
      setTicks((t) => {
        const next = new Set(t);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      }),
    [],
  );
  const setShown = (on: boolean) =>
    setTicks((t) => {
      const next = new Set(t);
      for (const it of shown) {
        if (it.locked !== null) continue;
        if (on) next.add(it.id);
        else next.delete(it.id);
      }
      return next;
    });

  const picks = React.useMemo(() => picksToRequest(items, ticks), [items, ticks]);
  const blocked = React.useMemo(
    () => computeBlockedReason(rows.map((r) => ({ ...r, include: picks.includedKeys.has(r.key) }))),
    [rows, picks],
  );

  const compute = () => {
    if (blocked) return;
    applyPicks(picks.includedKeys, picks.excludedPlanIds);
    onClose();
  };

  const columns = React.useMemo<ColumnDef<PickItem>[]>(
    () => [
      {
        id: 'tick',
        header: 'Include',
        enableSorting: false,
        cell: ({ row }) => {
          const it = row.original;
          return (
            <Checkbox
              checked={it.locked === null && ticks.has(it.id)}
              disabled={it.locked !== null}
              onCheckedChange={() => toggle(it.id)}
              aria-label={`Include ${it.name}`}
              data-testid="picker-tick"
            />
          );
        },
      },
      {
        id: 'name',
        header: 'Project',
        accessorKey: 'name',
        cell: ({ row }) => (
          <span className="flex flex-col">
            <span className="font-medium">{row.original.name}</span>
            {row.original.note || row.original.locked ? (
              <span className="text-2xs text-text-muted">{row.original.locked ?? row.original.note}</span>
            ) : null}
          </span>
        ),
      },
      {
        id: 'source',
        header: 'Source',
        accessorKey: 'source',
        cell: ({ row }) => (
          <Badge tone={row.original.source === 'file' ? 'primary' : 'neutral'}>{row.original.source}</Badge>
        ),
      },
      { id: 'hub', header: 'Hub', accessorKey: 'hub' },
      { id: 'category', header: 'Category', accessorKey: 'category' },
      { id: 'priority', header: 'Priority', accessorKey: 'priority' },
      { id: 'status', header: 'Status', accessorKey: 'status' },
    ],
    [ticks, toggle],
  );

  const searchId = React.useId();
  const setFilter = (k: keyof PickFilters, v: string) => setFilters((f) => ({ ...f, [k]: v }));
  const dropdown = (k: 'category' | 'hub' | 'priority' | 'source', label: string, values: string[]) => (
    <label className="flex flex-col gap-1 text-2xs text-text-muted">
      {label}
      <NativeSelect className="w-40" value={filters[k]} onChange={(e) => setFilter(k, e.target.value)}>
        <option value="">All</option>
        {values.map((v) => (
          <option key={v} value={v}>
            {k === 'source' ? (SOURCE_LABEL[v] ?? v) : v}
          </option>
        ))}
      </NativeSelect>
    </label>
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-s3">
      <SheetHeader>
        <SheetTitle>Pick the projects of the scenario</SheetTitle>
        <SheetDescription>
          Tick the projects to include, then compute. Unticked plan projects are left out of both the before and the
          after run.
        </SheetDescription>
      </SheetHeader>
      {mode === 'merge' && planProjects === undefined ? (
        <p className="text-2xs text-text-muted" data-testid="picker-no-plan">
          This server does not list the plan projects; only the file rows can be picked.
        </p>
      ) : null}
      <div className="flex flex-wrap items-end gap-s3">
        <span className="relative min-w-0 flex-1 sm:max-w-xs">
          <label htmlFor={searchId} className="sr-only">
            Search projects
          </label>
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-text-muted" aria-hidden="true" />
          <Input
            id={searchId}
            type="search"
            className="h-8 pl-7 text-xs"
            placeholder="Search name, hub, status…"
            value={filters.query}
            onChange={(e) => setFilter('query', e.target.value)}
          />
        </span>
        {dropdown('category', 'Category', pickValues(items, 'category'))}
        {dropdown('hub', 'Hub', pickValues(items, 'hub'))}
        {dropdown('priority', 'Priority', pickValues(items, 'priority'))}
        {mode === 'merge' ? dropdown('source', 'Source', ['file', 'plan']) : null}
      </div>
      <div className="flex flex-wrap items-center gap-s2">
        <Button type="button" size="sm" variant="ghost" onClick={() => setShown(true)}>
          Select all
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => setShown(false)}>
          Select none
        </Button>
        <span className="ml-auto text-xs text-text" role="status" aria-live="polite" data-testid="picker-count">
          {`${int(included)} of ${int(selectable.length)} included`}
          {shown.length !== items.length ? ` · ${int(shown.length)} shown` : ''}
        </span>
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        <DrillTable
          data={shown}
          columns={columns}
          rowId={(it) => it.id}
          label="Projects to pick"
          rowTestId="picker-row"
          minWidth={820}
        />
      </div>
      <SheetFooter>
        {blocked ? (
          <p className="mr-auto self-center text-2xs font-medium text-danger-subtle-fg" role="note">
            {blocked}
          </p>
        ) : null}
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="button" onClick={compute} disabled={blocked !== null}>
          Compute scenario
        </Button>
      </SheetFooter>
    </div>
  );
}

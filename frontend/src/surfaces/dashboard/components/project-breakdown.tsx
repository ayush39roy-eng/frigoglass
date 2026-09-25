import * as React from 'react';
import { FilterX } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
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
import { DownloadButton } from '@/components/shared/download-button';
import { EmptyState } from '@/components/shared/empty-state';
import { ErrorState } from '@/components/shared/error-state';
import { PriorityBandPill } from '@/components/shared/priority-band-pill';
import { ProjectStatusBadge } from '@/components/shared/project-status-badge';
import { Skeleton } from '@/components/ui/skeleton';
import { formatInteger } from '@/lib/format';
import { useHubs } from '@/lib/api/reference';
import {
  PROJECT_CATEGORIES,
  PROJECT_PRIORITIES,
  PROJECT_STATUSES,
  type ProjectCategory,
  type ProjectPriority,
  type ProjectStatus,
} from '@/types/enums';

import { useDashboardProjects } from '../hooks/use-dashboard';
import type { ProjectFilterParams, ProjectFilterRow } from '../api/types';
import { VirtualDataTable, type VirtualColumn } from './virtual-data-table';

/**
 * "Analytics breakdown with filters (by hub, category, status, priority)"
 * (PROJECT_AND_STACK.md §2). Filtering is server-side — the hooks pass the
 * params straight to `GET /dashboard/projects`, which is already hub-scoped by
 * RBAC. Nothing is computed here.
 */

const ALL = '__all__';

const COLUMNS: VirtualColumn<ProjectFilterRow>[] = [
  {
    id: 'project',
    header: 'Project',
    width: 'minmax(12rem, 2fr)',
    cell: (row) => (
      <span className="truncate font-medium text-text" title={row.project_name}>
        {row.project_name}
      </span>
    ),
  },
  {
    id: 'hub',
    header: 'Hub',
    width: 'minmax(7rem, 1fr)',
    cell: (row) => <span className="truncate text-text-muted">{row.hub}</span>,
  },
  {
    id: 'category',
    header: 'Cat.',
    width: '4rem',
    align: 'center',
    cell: (row) =>
      row.category ? (
        <Badge tone="outline">{row.category}</Badge>
      ) : (
        <span className="text-text-subtle">—</span>
      ),
  },
  {
    id: 'status',
    header: 'Status',
    width: 'minmax(9rem, 1fr)',
    cell: (row) => <ProjectStatusBadge status={row.status} />,
  },
  {
    id: 'priority',
    header: 'Priority',
    width: '5rem',
    align: 'center',
    cell: (row) =>
      row.priority ? (
        <PriorityBandPill priority={row.priority} />
      ) : (
        <span className="text-text-subtle">—</span>
      ),
  },
];

interface FilterState {
  hub_id: string;
  category: string;
  status_: string;
  priority: string;
}

const EMPTY: FilterState = { hub_id: ALL, category: ALL, status_: ALL, priority: ALL };

function FilterSelect({
  label,
  value,
  onChange,
  options,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  options: { value: string; label: string }[];
}): React.JSX.Element {
  const id = React.useId();
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id} className="text-2xs text-text-muted">
        {label}
      </Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className="h-8 w-40">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All</SelectItem>
          {options.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export function ProjectBreakdown(): React.JSX.Element {
  const [filters, setFilters] = React.useState<FilterState>(EMPTY);
  const hubsQuery = useHubs();

  const params = React.useMemo<ProjectFilterParams>(
    () => ({
      hub_id: filters.hub_id === ALL ? undefined : filters.hub_id,
      category: filters.category === ALL ? undefined : (filters.category as ProjectCategory),
      status_: filters.status_ === ALL ? undefined : (filters.status_ as ProjectStatus),
      priority: filters.priority === ALL ? undefined : (filters.priority as ProjectPriority),
    }),
    [filters],
  );

  const query = useDashboardProjects(params);
  const isFiltered = filters !== EMPTY && Object.values(filters).some((v) => v !== ALL);

  const set = (key: keyof FilterState) => (next: string) =>
    setFilters((prev) => ({ ...prev, [key]: next }));

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <CardTitle>Project breakdown</CardTitle>
          {query.data ? (
            <Badge tone="neutral" data-numeric="">
              {formatInteger(query.data.total_count)}{' '}
              {query.data.total_count === 1 ? 'project' : 'projects'}
            </Badge>
          ) : null}
        </div>
        <DownloadButton
          path="/exports/dashboard"
          filters={{
            hub_id: params.hub_id,
            category: params.category,
            status_: params.status_,
            priority: params.priority,
          }}
          fallbackFilename="dashboard-export"
        />
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <FilterSelect
            label="Hub"
            value={filters.hub_id}
            onChange={set('hub_id')}
            options={(hubsQuery.data ?? []).map((hub) => ({ value: hub.id, label: hub.name }))}
          />
          <FilterSelect
            label="Category"
            value={filters.category}
            onChange={set('category')}
            options={PROJECT_CATEGORIES.map((c) => ({ value: c, label: c }))}
          />
          <FilterSelect
            label="Status"
            value={filters.status_}
            onChange={set('status_')}
            options={PROJECT_STATUSES.map((s) => ({ value: s, label: s }))}
          />
          <FilterSelect
            label="Priority"
            value={filters.priority}
            onChange={set('priority')}
            options={PROJECT_PRIORITIES.map((p) => ({ value: p, label: p }))}
          />
          {isFiltered ? (
            <Button variant="ghost" size="sm" onClick={() => setFilters(EMPTY)}>
              <FilterX />
              Clear
            </Button>
          ) : null}
        </div>

        {query.isPending ? (
          <div className="space-y-2" aria-hidden="true">
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-full" />
            <Skeleton className="h-9 w-5/6" />
          </div>
        ) : query.isError ? (
          <ErrorState
            description="The project breakdown could not be loaded."
            onRetry={() => void query.refetch()}
          />
        ) : query.data.rows.length === 0 ? (
          <EmptyState
            title={isFiltered ? 'No projects match these filters' : 'No projects'}
            description={
              isFiltered
                ? 'Try widening or clearing the filters above.'
                : 'There are no projects visible in your hub scope.'
            }
          />
        ) : (
          <VirtualDataTable
            rows={query.data.rows}
            columns={COLUMNS}
            rowKey={(row) => row.project_id}
            caption="Filtered project breakdown"
          />
        )}
      </CardContent>
    </Card>
  );
}

import * as React from 'react';
import { FilterX } from 'lucide-react';

import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { DownloadButton } from '@/components/shared/download-button';
import { EmptyState } from '@/components/shared/empty-state';
import { ErrorState } from '@/components/shared/error-state';
import { Skeleton } from '@/components/ui/skeleton';
import { formatInteger } from '@/lib/format';
import { useHubs } from '@/lib/api/reference';
import { SURFACES } from '@/app/nav';
import {
  PROJECT_CATEGORIES,
  PROJECT_PRIORITIES,
  PROJECT_STATUSES,
  type ProjectCategory,
  type ProjectPriority,
  type ProjectStatus,
} from '@/types/enums';

import {
  ALL,
  EMPTY,
  FilterSelect,
  type FilterState,
} from '@/surfaces/dashboard/components/project-breakdown';
import { ProjectCardGrid } from '@/surfaces/dashboard/components/project-card-grid';
import { useDashboardProjects } from '@/surfaces/dashboard/hooks/use-dashboard';
import type { ProjectFilterParams } from '@/surfaces/dashboard/api/types';

const PROJECTS_SURFACE = SURFACES.find((s) => s.path === '/projects');

/**
 * `/projects` (ad hoc, 2026-10-01, project-owner request) — every project
 * visible in this session's hub scope, as a feature card, with its own
 * "Ask the agent" entry point. Same filtered rows as the Dashboard's
 * "Project breakdown" card (`GET /dashboard/projects`, already hub-scoped by
 * RBAC server-side) — this page just gives the card view its own URL and
 * sidebar entry instead of living behind a tab on the Dashboard. Filters are
 * independent local state from the Dashboard's own copy (no shared store),
 * same pattern `ProjectBreakdown` itself already uses.
 */
export default function ProjectsPage(): React.JSX.Element {
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

  const title = PROJECTS_SURFACE?.title ?? 'All Projects';
  const description =
    'Every project in your hub scope, as a card — the same filtered set as the Dashboard\'s Project breakdown.';

  return (
    <>
      <PageHeader
        title={title}
        description={description}
        actions={
          <>
            {query.data ? (
              <Badge tone="neutral" data-numeric="">
                {formatInteger(query.data.total_count)}{' '}
                {query.data.total_count === 1 ? 'project' : 'projects'}
              </Badge>
            ) : null}
            <DownloadButton
              path="/exports/dashboard"
              filters={{
                hub_id: params.hub_id,
                category: params.category,
                status_: params.status_,
                priority: params.priority,
              }}
              fallbackFilename="projects-export"
            />
          </>
        }
      />

      <div className="flex flex-wrap items-end gap-3 mb-gutter">
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
        <div className="grid gap-gutter sm:grid-cols-2 xl:grid-cols-3" aria-hidden="true">
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-48 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      ) : query.isError ? (
        <ErrorState
          description="The project list could not be loaded."
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
        <ProjectCardGrid rows={query.data.rows} />
      )}
    </>
  );
}

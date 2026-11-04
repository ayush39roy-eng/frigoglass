import * as React from 'react';
import { useQuery } from '@tanstack/react-query';

import { queryKeys } from '@/lib/query-keys';
import { useHubFilter } from '@/stores/hub-filter';
import { usePermission } from '@/stores/session';
import type { ProjectStatus } from '@/types/enums';
import { fetchDashboardProjects } from '@/surfaces/dashboard/api/dashboard-api';
import { retryUnlessAuth } from '@/surfaces/gantt/api/gantt-api';

/**
 * P32-R04: each project's served lifecycle status, for the Workflow page's
 * project timeline (the `GET /gantt` row carries none). Same request and
 * cache key as the Projects page register (`GET /dashboard/projects`), with
 * the global hub / country filter. Needs `dashboard` read; without it (an
 * Engineer) the map is empty and rows simply show no status.
 */
export function useProjectStatuses(): ReadonlyMap<string, ProjectStatus> {
  const { hubId, region } = useHubFilter();
  const enabled = usePermission('dashboard').read;
  const query = useQuery({
    queryKey: queryKeys.dashboardProjects({
      hub_id: hubId ?? undefined,
      ...(region !== null ? { region } : {}),
      sort: 'name',
    }),
    queryFn: ({ signal }) =>
      fetchDashboardProjects({ hub_id: hubId ?? undefined, region: region ?? undefined, sort: 'name' }, { signal }),
    retry: retryUnlessAuth,
    enabled,
    staleTime: 60_000,
  });
  return React.useMemo(
    () => new Map((query.data?.rows ?? []).map((r) => [r.project_id, r.status] as const)),
    [query.data],
  );
}

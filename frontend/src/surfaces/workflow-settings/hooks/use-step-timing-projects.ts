import * as React from 'react';
import { useQuery } from '@tanstack/react-query';

import { queryKeys } from '@/lib/query-keys';
import { useHubFilter } from '@/stores/hub-filter';
import { usePermission } from '@/stores/session';
import type { HubName, ProjectPriority, ProjectStatus } from '@/types/enums';
import { fetchDashboardProjects } from '@/surfaces/dashboard/api/dashboard-api';
import { fetchGantt, retryUnlessAuth } from '@/surfaces/gantt/api/gantt-api';

/**
 * P32-R04: the projects the Workflow page's step-timing picker offers — every
 * project the caller can see, narrowed by the global hub / country filter
 * (ADR 0020 / 0025; the server ANDs it with the RBAC scope).
 *
 * Source: the Projects page's `GET /dashboard/projects` (name, code, hub,
 * status, priority) when the caller reads the dashboard; otherwise (an
 * Engineer) the Timeline's `GET /gantt` rows, which carry no project status.
 * Rows are passed through as served; nothing is derived.
 */
export interface StepTimingProjectOption {
  id: string;
  name: string;
  code: string | null;
  hub: HubName;
  /** `null` when the source does not serve it (the Gantt fallback). */
  status: ProjectStatus | null;
  priority: ProjectPriority | null;
}

export function useStepTimingProjects(): {
  options: StepTimingProjectOption[];
  isPending: boolean;
  isError: boolean;
  error: unknown;
} {
  const { hubId, region } = useHubFilter();
  const viaDashboard = usePermission('dashboard').read;
  const dashboard = useQuery({
    queryKey: queryKeys.dashboardProjects({
      hub_id: hubId ?? undefined,
      ...(region !== null ? { region } : {}),
      sort: 'name',
    }),
    queryFn: ({ signal }) =>
      fetchDashboardProjects({ hub_id: hubId ?? undefined, region: region ?? undefined, sort: 'name' }, { signal }),
    retry: retryUnlessAuth,
    enabled: viaDashboard,
    staleTime: 60_000,
  });
  const gantt = useQuery({
    queryKey: queryKeys.gantt({ hubId: hubId ?? undefined, region: region ?? undefined, sort: 'name' }),
    queryFn: ({ signal }) =>
      fetchGantt({ hubId: hubId ?? undefined, region: region ?? undefined, sort: 'name' }, { signal }),
    retry: retryUnlessAuth,
    enabled: !viaDashboard,
    staleTime: 60_000,
  });

  const options = React.useMemo<StepTimingProjectOption[]>(() => {
    if (viaDashboard) {
      return (dashboard.data?.rows ?? []).map((r) => ({
        id: r.project_id,
        name: r.project_name,
        code: r.external_code,
        hub: r.hub,
        status: r.status,
        priority: r.priority,
      }));
    }
    return (gantt.data?.rows ?? []).map((r) => ({
      id: r.project_id,
      name: r.project_name,
      code: r.external_code,
      hub: r.hub,
      status: null,
      priority: r.priority,
    }));
  }, [viaDashboard, dashboard.data, gantt.data]);

  const q = viaDashboard ? dashboard : gantt;
  return { options, isPending: q.isPending, isError: q.isError, error: q.error };
}

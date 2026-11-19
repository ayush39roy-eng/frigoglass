import { useQuery } from '@tanstack/react-query';

import { ApiError } from '@/lib/api/client';
import { queryKeys } from '@/lib/query-keys';
import { NO_HUB_SELECTION, type HubSelection } from '@/stores/hub-filter';

import {
  fetchDeliveryByYearProjects,
  type DashboardSelection,
  type DeliveryDrillQuery,
} from '../api/dashboard-api';

const NONE: DashboardSelection = { categories: [], types: [] };

function retryUnlessAuth(failureCount: number, error: Error): boolean {
  if (error instanceof ApiError && (error.status === 401 || error.status === 403 || error.status === 404)) return false;
  return failureCount < 2;
}

/** P53 (API_CONTRACT_P53 §4.2): the projects behind one delivery-by-year
 *  figure; disabled until a figure is opened (`q` null). Served rows only (I59). */
export function useDeliveryByYearProjects(
  q: DeliveryDrillQuery | null,
  hub: HubSelection = NO_HUB_SELECTION,
  selection: DashboardSelection = NONE,
) {
  return useQuery({
    queryKey: queryKeys.dashboardDeliveryByYearProjects(q ?? { kind: '', year: null, band: null }, hub, selection),
    queryFn: ({ signal }) => fetchDeliveryByYearProjects(q as DeliveryDrillQuery, { signal }, hub, selection),
    enabled: q !== null,
    retry: retryUnlessAuth,
  });
}

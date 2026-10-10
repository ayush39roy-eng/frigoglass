import { useQuery } from '@tanstack/react-query';

import { fetchCheckInHistory } from '@/lib/api/check-ins';
import { queryKeys } from '@/lib/query-keys';

export { useCheckInsDue } from '@/lib/api/check-ins';

/** `GET /check-ins/history` for one stage, fetched only while its drawer is open. */
export function useCheckInHistory(projectId: string, stepId: string, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.checkInHistory(projectId, stepId),
    queryFn: ({ signal }) => fetchCheckInHistory(projectId, stepId, { signal }),
    enabled,
  });
}

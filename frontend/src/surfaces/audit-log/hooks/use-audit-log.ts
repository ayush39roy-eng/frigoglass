/**
 * TanStack Query hook for the Audit Log surface (P7-T05).
 *
 * Nothing here derives a value — the hook returns the raw
 * `AuditLogEntryList` page exactly as `GET /audit-log` returned it (Invariant
 * I9 analogue: no independent calculation, including in the frontend).
 */

import { useQuery } from '@tanstack/react-query';

import { ApiError } from '@/lib/api/client';
import { queryKeys, sortedKeyList, type AuditLogQueryFilters } from '@/lib/query-keys';

import { fetchAuditLog } from '../api/audit-log-api';
import type { AuditLogFilterParams } from '../api/types';

/** Do not retry an auth failure — a 401/403 will not fix itself on retry. */
function retryUnlessAuth(failureCount: number, error: Error): boolean {
  if (error instanceof ApiError && (error.isForbidden || error.isUnauthorized)) return false;
  return failureCount < 1;
}

export function useAuditLog(params: AuditLogFilterParams) {
  // Multi-select: lists are SORTED in the key (absent when empty).
  const keyFilters: AuditLogQueryFilters = {
    ...params,
    entity_type: sortedKeyList(params.entity_type),
    actor_user_id: sortedKeyList(params.actor_user_id),
    action: sortedKeyList(params.action),
    hub_id: sortedKeyList(params.hub_id),
  };
  return useQuery({
    queryKey: queryKeys.auditLog(keyFilters),
    queryFn: ({ signal }) => fetchAuditLog(params, { signal }),
    retry: retryUnlessAuth,
    // Keep the previous page visible while a filter/pagination change is
    // in flight — same rationale as `useDashboardProjects` (avoids a
    // flash-to-empty on every filter tweak).
    placeholderData: (prev) => prev,
  });
}

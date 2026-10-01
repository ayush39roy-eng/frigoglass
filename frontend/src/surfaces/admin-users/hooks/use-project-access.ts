/**
 * TanStack Query hooks for project-level access grants (ADR 0012, P10-T03).
 * Keys from `lib/query-keys.ts`. `useProjectAccessGrants` surfaces a 403
 * (no delegation rights on this project) as a normal query error — the tab
 * degrades to an explicit empty/disabled state rather than hiding itself.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { queryKeys } from '@/lib/query-keys';

import {
  createProjectAccessGrant,
  fetchProjectAccessGrants,
  revokeProjectAccessGrant,
} from '../api/project-access-api';
import { retryUnlessAuth } from '../api/users-api';
import type { ProjectAccessGrantCreateRequest } from '../api/types';

export function useProjectAccessGrants(projectId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.projectAccessGrants(projectId ?? ''),
    queryFn: ({ signal }) => fetchProjectAccessGrants(projectId ?? '', { signal }),
    enabled: projectId !== undefined,
    retry: retryUnlessAuth,
  });
}

export function useCreateProjectAccessGrant(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ProjectAccessGrantCreateRequest) => createProjectAccessGrant(projectId, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projectAccessGrants(projectId) });
    },
  });
}

export function useRevokeProjectAccessGrant(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (grantId: string) => revokeProjectAccessGrant(projectId, grantId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projectAccessGrants(projectId) });
    },
  });
}

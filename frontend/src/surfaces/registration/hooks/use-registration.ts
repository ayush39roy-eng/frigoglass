/**
 * TanStack Query hooks for the Project Registration surface (P4-T06).
 *
 * Keys come from `lib/query-keys.ts` (single source of truth). Nothing here
 * derives a number or a hard-gate decision — hooks return raw API payloads
 * (Invariant I9 — no independent calculation, including in the frontend).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { ApiError } from '@/lib/api/client';
import { queryKeys } from '@/lib/query-keys';

import { fetchEngineerOptions } from '../api/engineers-api';
import {
  createProject,
  fetchHardGateStatus,
  fetchProjects,
  submitProject,
  updateProject,
  type ProjectListParams,
} from '../api/registration-api';
import type {
  ProjectCreateRequest,
  ProjectSubmitRequest,
  ProjectUpdateRequest,
} from '../api/types';

/** Do not retry an auth failure — a 401/403 will not fix itself on retry. */
function retryUnlessAuth(failureCount: number, error: Error): boolean {
  if (error instanceof ApiError && (error.isForbidden || error.isUnauthorized)) return false;
  return failureCount < 1;
}

export interface UseProjectListParams {
  hubId?: string | undefined;
  category?: string | undefined;
  status?: string | undefined;
  priority?: string | undefined;
  type?: string | undefined;
}

const LIST_LIMIT = 500;

export function useProjectList(params: UseProjectListParams) {
  const query: ProjectListParams = { ...params, limit: LIST_LIMIT, offset: 0 };
  return useQuery({
    // Every changeable filter (including `hubId`, per the P4-T04 review lesson
    // on stale hub-scoped caches) is part of the key.
    queryKey: queryKeys.projects(params),
    queryFn: ({ signal }) => fetchProjects(query, { signal }),
    retry: retryUnlessAuth,
    placeholderData: (prev) => prev,
  });
}

/** Only fetched on demand (the row is expanded / the edit form is open for a
 *  Draft project) — not every row in a 236-project list needs its hard-gate
 *  status pre-fetched. */
export function useHardGateStatus(projectId: string | null) {
  return useQuery({
    queryKey: queryKeys.projectHardGateStatus(projectId ?? '__none__'),
    queryFn: ({ signal }) => fetchHardGateStatus(projectId ?? '', { signal }),
    enabled: projectId !== null,
    retry: retryUnlessAuth,
  });
}

/** Read-only engineer lookup for the leader picker (`api/engineers-api.ts` —
 *  distinct from Capacity Planning's future Engineer CRUD, P4-T07). */
export function useEngineerOptions(hubId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.engineers(hubId),
    queryFn: ({ signal }) => fetchEngineerOptions(hubId, { signal }),
    enabled: hubId !== undefined,
    retry: retryUnlessAuth,
    staleTime: 60_000,
  });
}

/** `POST /projects`. On success, invalidate the project list so the new Draft
 *  row appears. Never touches `['schedule-runs', …]` — a Draft (or any status)
 *  project only affects the next schedule run, not the active one. */
export function useCreateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ProjectCreateRequest) => createProject(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });
}

/** `PATCH /projects/{id}`. Invalidates the list + this project's hard-gate
 *  status (a field edit can change which fields are still missing). */
export function useUpdateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, body }: { projectId: string; body: ProjectUpdateRequest }) =>
      updateProject(projectId, body),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.projectHardGateStatus(variables.projectId),
      });
    },
  });
}

/** `POST /projects/{id}/submit` — leave Draft. Invalidates the project list +
 *  hard-gate status only. Deliberately does NOT invalidate
 *  `['schedule-runs', …]` / `['dashboard', …]` / `['gantt', …]` / `['capacity',
 *  …]`: the project becomes eligible for the *next* schedule run, this action
 *  does not itself recalculate one (same "recalc needed" contract as the
 *  Gantt freeze toggle, `surfaces/gantt/hooks/use-gantt.ts`). */
export function useSubmitProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, body }: { projectId: string; body: ProjectSubmitRequest }) =>
      submitProject(projectId, body),
    onSuccess: (_data, variables) => {
      void queryClient.invalidateQueries({ queryKey: ['projects'] });
      void queryClient.invalidateQueries({
        queryKey: queryKeys.projectHardGateStatus(variables.projectId),
      });
    },
  });
}

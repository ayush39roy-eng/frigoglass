/**
 * TanStack Query hooks for the Project Workspace. Mutations that return the
 * full workspace payload write it straight into the cache; everything that
 * can make other surfaces stale (stage progress, recalculation) invalidates
 * them too. A progress edit never triggers a solve (ADR 0006).
 */

import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { ApiError } from '@/lib/api/client';
import { queryKeys } from '@/lib/query-keys';

import {
  askAgent,
  createComment,
  deleteComment,
  editComment,
  fetchActivity,
  fetchWorkspace,
  patchFile,
  patchStage,
  recalculate,
  retryUnlessAuth,
  searchMentions,
  uploadFile,
} from '../api/workspace-api';
import type { FilePatchRequest, FileUploadInput, StagePatchRequest, WorkspaceResponse } from '../api/types';

export function useWorkspace(projectId: string) {
  return useQuery({
    queryKey: queryKeys.projectWorkspace(projectId),
    queryFn: ({ signal }) => fetchWorkspace(projectId, { signal }),
    retry: retryUnlessAuth,
  });
}

function refreshWorkspace(queryClient: QueryClient, projectId: string) {
  void queryClient.invalidateQueries({ queryKey: queryKeys.projectWorkspace(projectId) });
}

export function useStagePatch(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ stepId, body }: { stepId: string; body: StagePatchRequest }) => patchStage(projectId, stepId, body),
    onSuccess: (data: WorkspaceResponse) => {
      queryClient.setQueryData(queryKeys.projectWorkspace(projectId), data);
      // The Gantt's stale chip and the Registration list read `schedule_stale`.
      void queryClient.invalidateQueries({ queryKey: ['gantt'] });
      void queryClient.invalidateQueries({ queryKey: ['projects'], exact: false, refetchType: 'none' });
    },
    onError: (err: unknown) => {
      // 409 PROJECT_FROZEN (remediation ruling 3): the project was frozen on the
      // Gantt after this page loaded. Refetch so `project.frozen` arrives and the
      // Progress panel switches to read-only with the "Unfreeze on the Gantt" note.
      if (err instanceof ApiError && err.code === 'PROJECT_FROZEN') refreshWorkspace(queryClient, projectId);
    },
  });
}

export function useRecalculate(projectId: string) {
  return useMutation({ mutationFn: () => recalculate(projectId) });
}

/** After a recalculation completes: the new run is active everywhere. */
export function invalidateAfterRecalc(queryClient: QueryClient, projectId: string) {
  refreshWorkspace(queryClient, projectId);
  for (const key of [['gantt'], ['dashboard'], ['capacity'], ['schedule-runs'], ['notifications']]) {
    void queryClient.invalidateQueries({ queryKey: key });
  }
}

export function useUploadFile(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: FileUploadInput) => uploadFile(projectId, input),
    onSuccess: () => refreshWorkspace(queryClient, projectId),
  });
}

export function usePatchFile(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ fileId, body }: { fileId: string; body: FilePatchRequest }) => patchFile(projectId, fileId, body),
    onSuccess: () => refreshWorkspace(queryClient, projectId),
  });
}

export function useCommentMutations(projectId: string) {
  const queryClient = useQueryClient();
  const onSuccess = () => refreshWorkspace(queryClient, projectId);
  return {
    create: useMutation({ mutationFn: (bodyMd: string) => createComment(projectId, bodyMd), onSuccess }),
    edit: useMutation({
      mutationFn: ({ commentId, bodyMd }: { commentId: string; bodyMd: string }) => editComment(projectId, commentId, bodyMd),
      onSuccess,
    }),
    remove: useMutation({ mutationFn: (commentId: string) => deleteComment(projectId, commentId), onSuccess }),
  };
}

export function useOlderActivity(projectId: string, before: string | undefined) {
  return useQuery({
    queryKey: queryKeys.projectActivity(projectId, before),
    queryFn: ({ signal }) => fetchActivity(projectId, { before, limit: 50 }, { signal }),
    enabled: before !== undefined,
    retry: retryUnlessAuth,
  });
}

/** ADR 0014: stateless — no cache entry, no invalidation. Each call is its
 *  own question in, answer out; nothing here survives a re-render. */
export function useAskAgent(projectId: string) {
  return useMutation({ mutationFn: (question: string) => askAgent(projectId, question) });
}

export function useMentionSearch(q: string) {
  return useQuery({
    queryKey: queryKeys.mentionSearch(q),
    queryFn: ({ signal }) => searchMentions(q, { signal }),
    enabled: q.length >= 1,
    staleTime: 60_000,
    retry: false,
  });
}

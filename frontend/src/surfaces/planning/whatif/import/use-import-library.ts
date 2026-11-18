import * as React from 'react';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { ApiError, type DownloadedFile } from '@/lib/api/client';
import { isSuperAdminOnlyError, SUPER_ADMIN_ONLY_MESSAGE } from '@/lib/auth/super-admin';
import { saveBlob } from '@/lib/download';
import { useSessionStore } from '@/stores/session';

import { classifyWhatIfError } from '../use-whatif';
import {
  createSavedScenario,
  deleteSavedScenario,
  getImportFormat,
  getSavedScenario,
  ImportShapeError,
  listSavedScenarios,
  patchSavedScenario,
  putImportFormat,
  resetImportFormat,
  SCENARIO_PAGE,
  SCENARIO_PAGE_MAX,
} from './import-api';
import type { ImportFormatUpdate, SavedScenario, SaveScenarioBody } from './import-types';

/**
 * P41 (ADR 0055, docs/API_CONTRACT_P41.md E4): the TanStack Query side of the import
 * format and the saved-scenario library. Keys: `['whatif-import-format']` and
 * `['whatif-import-scenarios', sha?]`; every mutation invalidates its key. Responses are
 * used as served; nothing here derives a figure.
 */

export const FORMAT_KEY = ['whatif-import-format'] as const;
export const SCENARIOS_KEY = ['whatif-import-scenarios'] as const;

/**
 * P41-R01: the list is paged, so the library (an infinite query) and the per-file lookup
 * (one page) need distinct keys under the shared prefix; invalidating SCENARIOS_KEY still
 * refreshes both.
 */
export function scenariosKey(sha?: string | null): readonly unknown[] {
  return sha ? [...SCENARIOS_KEY, 'file', sha] : [...SCENARIOS_KEY, 'library'];
}

function scenarioDetailKey(id: string): readonly unknown[] {
  return [...SCENARIOS_KEY, 'detail', id];
}

/** Admin and Super Admin edit the import format (ADR 0055 D1). A UI narrowing; the PUT is the authority. */
export function useIsFormatAdmin(): boolean {
  const roles = useSessionStore((s) => s.me?.roles);
  return roles?.some((r) => r === 'Admin' || r === 'Super Admin') ?? false;
}

export function useImportFormat() {
  return useQuery({
    queryKey: FORMAT_KEY,
    queryFn: ({ signal }) => getImportFormat({ signal }),
    staleTime: 60_000,
    retry: false,
  });
}

export function useSaveImportFormat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ImportFormatUpdate) => putImportFormat(body),
    retry: false,
    onSuccess: (data) => qc.setQueryData(FORMAT_KEY, data),
    onSettled: () => qc.invalidateQueries({ queryKey: FORMAT_KEY }),
  });
}

export function useResetImportFormat() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (version: number) => resetImportFormat(version),
    retry: false,
    onSuccess: (data) => qc.setQueryData(FORMAT_KEY, data),
    onSettled: () => qc.invalidateQueries({ queryKey: FORMAT_KEY }),
  });
}

/**
 * The saved scenarios of ONE import, for the Scenario bar's selector: a single page of up
 * to 200 (the served cap), newest first.
 */
export function useSavedScenarios(sha: string | null, enabled = true) {
  return useQuery({
    queryKey: scenariosKey(sha),
    queryFn: ({ signal }) =>
      listSavedScenarios({ sha: sha ?? undefined, limit: SCENARIO_PAGE_MAX, offset: 0 }, { signal }),
    enabled: enabled && sha !== null,
    staleTime: 30_000,
    retry: false,
  });
}

/**
 * The library: every saved scenario the caller can see, 50 per page; `fetchNextPage` ("Load
 * more") while the loaded count is below the served `total`.
 */
export function useSavedScenarioLibrary() {
  return useInfiniteQuery({
    queryKey: scenariosKey(),
    queryFn: ({ signal, pageParam }) => listSavedScenarios({ limit: SCENARIO_PAGE, offset: pageParam }, { signal }),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((n, p) => n + p.items.length, 0);
      return loaded < last.total && last.items.length > 0 ? loaded : undefined;
    },
    staleTime: 30_000,
    retry: false,
  });
}

/** The frozen request + response of one saved scenario (fetched on Open / Add to compare). */
export function useFetchSavedScenario(): (id: string) => Promise<SavedScenario> {
  const qc = useQueryClient();
  return React.useCallback(
    (id: string) =>
      qc.fetchQuery({
        queryKey: scenarioDetailKey(id),
        queryFn: ({ signal }) => getSavedScenario(id, { signal }),
        staleTime: 5 * 60_000,
      }),
    [qc],
  );
}

export function useCreateSavedScenario() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SaveScenarioBody) => createSavedScenario(body),
    retry: false,
    onSuccess: (data) => qc.setQueryData(scenarioDetailKey(data.id), data),
    onSettled: () => qc.invalidateQueries({ queryKey: SCENARIOS_KEY }),
  });
}

export function useRenameSavedScenario() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, name, note }: { id: string; name: string; note?: string | null }) =>
      patchSavedScenario(id, note === undefined ? { name } : { name, note }),
    retry: false,
    onSettled: () => qc.invalidateQueries({ queryKey: SCENARIOS_KEY }),
  });
}

export function useDeleteSavedScenario() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteSavedScenario(id),
    retry: false,
    onSettled: () => qc.invalidateQueries({ queryKey: SCENARIOS_KEY }),
  });
}

/** Plain copy for a failed library / format / export call. */
export function libraryErrorMessage(error: unknown): string {
  if (error instanceof ImportShapeError) return 'The server answered in an unexpected format. Reload the page.';
  if (error instanceof ApiError) {
    if (error.status === 0) return 'The server could not be reached. Try again.';
    if (error.status === 401) return 'Your session has ended. Sign in again.';
    // P46 (ADR 0058 D1.4): deleting someone else's scenario, resetting the format.
    if (isSuperAdminOnlyError(error)) return SUPER_ADMIN_ONLY_MESSAGE;
    if (error.status === 403 && error.code === 'SCENARIO_FORBIDDEN')
      return 'Only the person who saved this scenario, an Admin or a Super Admin can change it.';
    if (error.status === 403) return 'You do not have permission to do this.';
    if (error.status === 404) return 'This scenario no longer exists or is outside your hubs.';
    if (error.status === 409 && error.code === 'FORMAT_VERSION_CONFLICT')
      return 'Someone else changed the format — reload.';
    if (error.status === 413) return 'This scenario is too large to save (more than 8 MB).';
    if (error.status === 422 && error.code === 'INVALID_SCENARIO_NAME') return 'Give the scenario a name.';
    if (error.status === 422 && error.code === 'INVALID_COMPARE') return 'Pick two to four different saved scenarios.';
    if (error.status === 422 && error.code === 'SCENARIO_LIMIT')
      return 'The saved-scenario limit is reached. Delete an old scenario first.';
    if (error.status === 422) return error.detail ? `Not accepted: ${error.detail}` : 'The server did not accept this.';
    // The What-if planner's "please wait" wording (with the Retry-After seconds when sent).
    if (error.status === 429) return classifyWhatIfError(error, 'scenario').message;
  }
  return 'Something went wrong. Try again.';
}

/**
 * Runs an authenticated download (fetch → blob → save). `pending` is the key of the
 * download in flight; `error` the last failure's copy.
 */
export function useDownload() {
  const [pending, setPending] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const run = React.useCallback(async (key: string, fetchFile: () => Promise<DownloadedFile>) => {
    setPending(key);
    setError(null);
    try {
      const { blob, filename } = await fetchFile();
      saveBlob(blob, filename);
    } catch (e) {
      setError(libraryErrorMessage(e));
    } finally {
      setPending(null);
    }
  }, []);
  return { pending, error, run, clearError: () => setError(null) };
}

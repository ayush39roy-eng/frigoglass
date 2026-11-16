import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { ApiError, type DownloadedFile } from '@/lib/api/client';
import { saveBlob } from '@/lib/download';
import { useSessionStore } from '@/stores/session';

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

export function scenariosKey(sha?: string | null): readonly unknown[] {
  return sha ? [...SCENARIOS_KEY, sha] : SCENARIOS_KEY;
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

/** The saved scenarios the caller can see; `sha` narrows to one import (served filter). */
export function useSavedScenarios(sha?: string | null, enabled = true) {
  return useQuery({
    queryKey: scenariosKey(sha),
    queryFn: ({ signal }) => listSavedScenarios(sha ?? undefined, { signal }),
    enabled,
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
    if (error.status === 429) return 'Too many requests. Wait a moment and try again.';
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

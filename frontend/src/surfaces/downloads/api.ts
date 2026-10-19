/**
 * Downloads page (P13-T15, API_CONTRACT_P13 §7). Hand-authored mirror of
 * `backend/schemas/export.py::ExportJobListItem`.
 */

import { useQuery } from '@tanstack/react-query';

import { apiDownload, apiGet, ApiError, type ApiRequestOptions, type DownloadedFile } from '@/lib/api/client';
import { queryKeys } from '@/lib/query-keys';
import type { Id } from '@/types/common';

export type ExportJobKind =
  | 'dashboard'
  | 'capacity'
  | 'matrix'
  | 'gantt'
  | 'project_registration'
  | 'capacity_planning';
export type ExportJobFormat = 'csv' | 'xlsx';
export type ExportJobStatus = 'queued' | 'running' | 'completed' | 'failed';

/** One row of `GET /export-jobs` — the caller's own jobs (Admin: all), newest first. */
export interface ExportJobListItem {
  id: Id;
  kind: ExportJobKind;
  format: ExportJobFormat;
  status: ExportJobStatus;
  created_at: string;
  completed_at: string | null;
  row_count: number | null;
  /** Exactly the name the download route serves. */
  file_name: string;
}

export const EXPORT_JOBS_LIMIT = 50;

type FetchCtx = Pick<ApiRequestOptions, 'signal'>;

export function fetchExportJobs(limit: number, ctx: FetchCtx = {}): Promise<ExportJobListItem[]> {
  return apiGet<ExportJobListItem[]>('/export-jobs', { ...ctx, query: { limit } });
}

/** The existing owner-or-Admin download route (409 until `completed`). */
export function downloadExportJob(job: Pick<ExportJobListItem, 'id' | 'file_name'>): Promise<DownloadedFile> {
  return apiDownload(`/exports/jobs/${job.id}/download`, { fallbackFilename: job.file_name });
}

function retryUnlessAuth(failureCount: number, error: Error): boolean {
  if (error instanceof ApiError && (error.isForbidden || error.isUnauthorized)) return false;
  return failureCount < 1;
}

/** Re-polls every 5 s while any listed job is still queued or running. */
export function useExportJobs(limit: number = EXPORT_JOBS_LIMIT) {
  return useQuery({
    queryKey: queryKeys.exportJobs(limit),
    queryFn: ({ signal }) => fetchExportJobs(limit, { signal }),
    retry: retryUnlessAuth,
    refetchInterval: (query) =>
      query.state.data?.some((j) => j.status === 'queued' || j.status === 'running') ? 5_000 : false,
  });
}

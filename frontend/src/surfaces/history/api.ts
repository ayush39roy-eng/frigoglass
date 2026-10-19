/**
 * Versions & History (P13-T15, API_CONTRACT_P13 §7). Read-only fetchers.
 * `ScheduleRunListItem` mirrors `backend/schemas/schedule_run.py::ScheduleRunSummary`.
 */

import { useQuery } from '@tanstack/react-query';

import { apiGet, ApiError, type ApiRequestOptions } from '@/lib/api/client';
import { fetchScheduleRunChanges } from '@/lib/api/priority-move';
import { queryKeys } from '@/lib/query-keys';
import type { Id } from '@/types/common';
import type { HubName, ScheduleRunStatus, SolverType } from '@/types/enums';

export interface ScheduleRunListItem {
  id: Id;
  version: number;
  solver_type: SolverType;
  status: ScheduleRunStatus;
  is_active: boolean;
  /** The scheduler's internal search limit — never displayed (ADR 0024). */
  horizon_weeks: number;
  current_week: number;
  trigger_reason: string | null;
  solver_status: string | null;
  created_at: string;
}

type FetchCtx = Pick<ApiRequestOptions, 'signal'>;

/** `GET /schedule-runs` — every run, newest first. */
export function fetchScheduleRuns(ctx: FetchCtx = {}): Promise<ScheduleRunListItem[]> {
  return apiGet<ScheduleRunListItem[]>('/schedule-runs', ctx);
}

interface ProjectNameRow {
  project_id: Id;
  project_name: string;
  hub: HubName;
}

/** `GET /dashboard/projects` (no filters) — only to put names on scenario
 *  changes, which carry ids. No financial fields are in that projection. */
export function fetchProjectNames(ctx: FetchCtx = {}): Promise<{ rows: ProjectNameRow[] }> {
  return apiGet<{ rows: ProjectNameRow[] }>('/dashboard/projects', ctx);
}

function retryUnlessAuth(failureCount: number, error: Error): boolean {
  if (error instanceof ApiError && (error.isForbidden || error.isUnauthorized)) return false;
  return failureCount < 1;
}

export function useScheduleRuns() {
  return useQuery({
    queryKey: queryKeys.scheduleRuns(),
    queryFn: ({ signal }) => fetchScheduleRuns({ signal }),
    retry: retryUnlessAuth,
  });
}

/** The served change list of `runId` against `againstId` (both immutable, I14). */
export function useRunChanges(runId: string | null, againstId: string | null) {
  return useQuery({
    queryKey: queryKeys.scheduleRunChanges(runId ?? '', againstId ?? ''),
    queryFn: ({ signal }) => fetchScheduleRunChanges(runId ?? '', againstId ?? '', { signal }),
    enabled: runId !== null && againstId !== null,
    retry: retryUnlessAuth,
    staleTime: Infinity,
  });
}

export function useProjectNameLookup(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.historyProjectNames(),
    queryFn: async ({ signal }) => {
      const { rows } = await fetchProjectNames({ signal });
      const lookup: Record<string, { name: string; hub: string } | undefined> = {};
      for (const r of rows) lookup[r.project_id] = { name: r.project_name, hub: r.hub };
      return lookup;
    },
    enabled,
    retry: retryUnlessAuth,
    staleTime: 5 * 60_000,
  });
}

/**
 * The run a selected run is compared with: the next older COMPLETED run in the
 * served (newest-first) list. A list lookup, not a schedule calculation.
 */
export function baselineFor(runs: readonly ScheduleRunListItem[], runId: string): ScheduleRunListItem | null {
  const i = runs.findIndex((r) => r.id === runId);
  if (i < 0) return null;
  return runs.slice(i + 1).find((r) => r.status === 'completed') ?? null;
}

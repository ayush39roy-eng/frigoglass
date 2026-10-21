/**
 * TanStack Query hooks for the Capacity Planning surface (P4-T07).
 *
 * Keys come from `lib/query-keys.ts` (single source of truth). Nothing here
 * derives a number or a scheduling decision — hooks return raw API payloads
 * (Invariant I9 — no independent calculation, including in the frontend).
 *
 * Cache-invalidation design (frontend-builder SKILL: "every mutation that
 * changes a capacity input invalidates the relevant capacity keys"):
 * - Engineer/Chamber CRUD invalidates `['engineers'|'chambers']` (the list
 *   itself) AND `capacityHubLoad`/`capacityUtilizationMatrix` — per
 *   `backend/api/routers/capacity.py`, the *capacity* (supply) figures on RPD
 *   Capacity (`design_capacity_weeks`, and the chamber/engineer rows shown in
 *   the utilization matrix) are computed LIVE from the current `Engineer`/
 *   `Chamber` tables, not from the active `ScheduleRun` snapshot — so editing
 *   an engineer's FTE or a chamber's `max_concurrent` changes those figures
 *   the moment this query refetches, with no recalculation needed.
 * - It deliberately does NOT invalidate `['schedule-runs', …]` / `['dashboard',
 *   …]` / `['gantt', …]` / the *load* half of `['capacity', …]` — those are
 *   sourced from the active `ScheduleRun` snapshot (Invariants I6/I7) and only
 *   change when a new run is computed, i.e. via Apply Logic below. Editing a
 *   resource does not itself recompute the schedule (same "recalc needed"
 *   contract as the Gantt freeze toggle / Registration's submit action).
 * - Apply Logic (`useApplyLogic`) is the opposite: it invalidates
 *   `['schedule-runs', …]`, `['dashboard', …]`, `['gantt', …]` and
 *   `['capacity', …]` broadly, because it computes AND ACTIVATES a new
 *   portfolio-wide `ScheduleRun` — every one of those surfaces' snapshot reads
 *   is now stale.
 */

import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { ApiError } from '@/lib/api/client';
import { queryKeys } from '@/lib/query-keys';

import {
  createChamber,
  createEngineer,
  deleteChamber,
  deleteEngineer,
  fetchActiveScheduleRun,
  fetchCapacitySummary,
  fetchResourceLoad,
  fetchResourceLoadOptions,
  fetchChambers,
  fetchEngineers,
  triggerApplyLogic,
  updateChamber,
  updateEngineer,
} from '../api/planning-api';
import type {
  CapacityBasis,
  ChamberCreateRequest,
  ChamberRead,
  ChamberUpdateRequest,
  EngineerCreateRequest,
  EngineerRead,
  EngineerUpdateRequest,
  ResourceLoadFilters,
} from '../api/types';

/**
 * P19-T04: keys for the two P19-T03 planning reads. Kept here (not in the shared
 * `lib/query-keys.ts`) because only this surface reads them and other agents were
 * editing the shared file at the time; move them there when convenient. Every
 * input that changes the response (basis, filters) is part of the key.
 */
export const planningKeys = {
  all: () => ['planning'] as const,
  capacitySummary: () => ['planning', 'capacity-summary'] as const,
  resourceLoad: (basis?: CapacityBasis, filters?: ResourceLoadFilters) =>
    basis === undefined
      ? (['planning', 'resource-load'] as const)
      : (['planning', 'resource-load', basis, filters ?? null] as const),
  resourceLoadOptions: () => ['planning', 'resource-load-options'] as const,
};

/** Do not retry an auth failure — a 401/403 will not fix itself on retry. */
function retryUnlessAuth(failureCount: number, error: Error): boolean {
  if (error instanceof ApiError && (error.isForbidden || error.isUnauthorized)) return false;
  return failureCount < 1;
}

// --- Engineers ---

export function useEngineerList(hubId: string | undefined) {
  return useQuery({
    // `hubId` is a user-facing filter — part of the key (the P4-T04 review
    // lesson on stale hub-scoped caches).
    queryKey: queryKeys.engineers(hubId),
    queryFn: ({ signal }) => fetchEngineers(hubId, { signal }),
    retry: retryUnlessAuth,
    placeholderData: (prev) => prev,
  });
}

function invalidateEngineerCapacityKeys(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: ['engineers'] });
  // P19-T04: the summary and the resource-load capacity read the live tables.
  void queryClient.invalidateQueries({ queryKey: planningKeys.all() });
  void queryClient.invalidateQueries({ queryKey: queryKeys.capacityHubLoad() });
  void queryClient.invalidateQueries({ queryKey: queryKeys.capacityUtilizationMatrix() });
}

export function useCreateEngineer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: EngineerCreateRequest) => createEngineer(body),
    onSuccess: () => invalidateEngineerCapacityKeys(queryClient),
  });
}

/**
 * Optimistic (P19-T04 inline edits): the edited input fields (FTE, allowed
 * categories, ...) are patched into every cached engineer list at once and
 * rolled back on error. Only the INPUTS the user typed are patched; served
 * figures (capacity) are left as they are until the refetch brings the
 * server's new values, so no number is ever computed here.
 */
export function useUpdateEngineer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ engineerId, body }: { engineerId: string; body: EngineerUpdateRequest }) =>
      updateEngineer(engineerId, body),
    onMutate: async ({ engineerId, body }) => {
      await queryClient.cancelQueries({ queryKey: ['engineers'] });
      const previous = queryClient.getQueriesData<EngineerRead[]>({ queryKey: ['engineers'] });
      queryClient.setQueriesData<EngineerRead[]>({ queryKey: ['engineers'] }, (rows) =>
        rows?.map((r) => (r.id === engineerId ? { ...r, ...stripUndefined(body) } : r)),
      );
      return { previous };
    },
    onError: (_err, _vars, context) => {
      for (const [key, data] of context?.previous ?? []) queryClient.setQueryData(key, data);
    },
    onSettled: () => invalidateEngineerCapacityKeys(queryClient),
  });
}

function stripUndefined<T extends object>(body: T): Partial<T> {
  return Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) as Partial<T>;
}

export function useDeleteEngineer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (engineerId: string) => deleteEngineer(engineerId),
    onSuccess: () => invalidateEngineerCapacityKeys(queryClient),
  });
}

// --- Chambers ---

export function useChamberList() {
  return useQuery({
    queryKey: queryKeys.chambers(),
    queryFn: ({ signal }) => fetchChambers({ signal }),
    retry: retryUnlessAuth,
  });
}

function invalidateChamberCapacityKeys(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: queryKeys.chambers() });
  void queryClient.invalidateQueries({ queryKey: planningKeys.all() });
  void queryClient.invalidateQueries({ queryKey: queryKeys.capacityHubLoad() });
  void queryClient.invalidateQueries({ queryKey: queryKeys.capacityUtilizationMatrix() });
}

export function useCreateChamber() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: ChamberCreateRequest) => createChamber(body),
    onSuccess: () => invalidateChamberCapacityKeys(queryClient),
  });
}

/** Optimistic, same rule as `useUpdateEngineer`: inputs only, figures wait
 *  for the refetch. */
export function useUpdateChamber() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ chamberId, body }: { chamberId: string; body: ChamberUpdateRequest }) =>
      updateChamber(chamberId, body),
    onMutate: async ({ chamberId, body }) => {
      await queryClient.cancelQueries({ queryKey: queryKeys.chambers() });
      const previous = queryClient.getQueryData<ChamberRead[]>(queryKeys.chambers());
      queryClient.setQueryData<ChamberRead[]>(queryKeys.chambers(), (rows) =>
        rows?.map((r) => (r.id === chamberId ? { ...r, ...stripUndefined(body) } : r)),
      );
      return { previous };
    },
    onError: (_err, _vars, context) => {
      if (context?.previous) queryClient.setQueryData(queryKeys.chambers(), context.previous);
    },
    onSettled: () => invalidateChamberCapacityKeys(queryClient),
  });
}

export function useDeleteChamber() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (chamberId: string) => deleteChamber(chamberId),
    onSuccess: () => invalidateChamberCapacityKeys(queryClient),
  });
}

// --- Apply Logic ---

/** Provenance caption only — never a headline number. Shares the
 *  `['schedule-runs', 'active']` key with every other surface's copy so the
 *  cache is reused. */
export function useActiveScheduleRun(enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.activeScheduleRun(),
    queryFn: ({ signal }) => fetchActiveScheduleRun({ signal }),
    retry: retryUnlessAuth,
    enabled,
  });
}

/** `POST /schedule-runs/greedy-recalc` — see `components/apply-logic-panel.tsx`
 *  for the "why this endpoint is Apply Logic" reasoning. Broadly invalidates
 *  every surface whose read model is sourced from the active `ScheduleRun`
 *  snapshot, because this action recomputes AND activates a new one. */
export function useApplyLogic() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => triggerApplyLogic(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['schedule-runs'] });
      void queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      void queryClient.invalidateQueries({ queryKey: ['gantt'] });
      void queryClient.invalidateQueries({ queryKey: ['capacity'] });
      // P19-T04: resource load reads the active run.
      void queryClient.invalidateQueries({ queryKey: planningKeys.all() });
    },
  });
}

// --- P19-T03 reads ---

export function useCapacitySummary() {
  return useQuery({
    queryKey: planningKeys.capacitySummary(),
    queryFn: ({ signal }) => fetchCapacitySummary({ signal }),
    retry: retryUnlessAuth,
  });
}

/** Lazy: `enabled` is false until the analytics section has been on screen. */
export function useResourceLoadOptions(enabled: boolean) {
  return useQuery({
    queryKey: planningKeys.resourceLoadOptions(),
    queryFn: ({ signal }) => fetchResourceLoadOptions({ signal }),
    retry: retryUnlessAuth,
    enabled,
    staleTime: 5 * 60_000,
  });
}

/** Lazy and keyed on basis + (debounced) filters; keeps the previous figures
 *  on screen while a new filter set loads. Per-engineer reads are audited
 *  server-side (ADR 0028), so nothing here polls or refetches on focus. */
export function useResourceLoad(basis: CapacityBasis, filters: ResourceLoadFilters, enabled: boolean) {
  return useQuery({
    queryKey: planningKeys.resourceLoad(basis, filters),
    queryFn: ({ signal }) => fetchResourceLoad(basis, filters, { signal }),
    retry: retryUnlessAuth,
    enabled,
    placeholderData: keepPreviousData,
    refetchOnWindowFocus: false,
  });
}

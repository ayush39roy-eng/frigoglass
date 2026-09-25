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

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { ApiError } from '@/lib/api/client';
import { queryKeys } from '@/lib/query-keys';

import {
  createChamber,
  createEngineer,
  deleteChamber,
  deleteEngineer,
  fetchActiveScheduleRun,
  fetchChambers,
  fetchEngineers,
  triggerApplyLogic,
  updateChamber,
  updateEngineer,
} from '../api/planning-api';
import type {
  ChamberCreateRequest,
  ChamberUpdateRequest,
  EngineerCreateRequest,
  EngineerUpdateRequest,
} from '../api/types';

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

export function useUpdateEngineer() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ engineerId, body }: { engineerId: string; body: EngineerUpdateRequest }) =>
      updateEngineer(engineerId, body),
    onSuccess: () => invalidateEngineerCapacityKeys(queryClient),
  });
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

export function useUpdateChamber() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ chamberId, body }: { chamberId: string; body: ChamberUpdateRequest }) =>
      updateChamber(chamberId, body),
    onSuccess: () => invalidateChamberCapacityKeys(queryClient),
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
    },
  });
}

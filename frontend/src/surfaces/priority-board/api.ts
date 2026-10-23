// Mirrors of backend/schemas/priority_board.py (P12 contract §2), reconciled
// field for field with the P12-T03 backend on 2026-10-10.

/**
 * Priority board (ADR 0018). The server groups, sorts and counts the cards and
 * serves every outcome from the active run. A drop is the existing P11 priority
 * move (`POST /projects/{id}/priority`), so there is no write here.
 */

import { useQuery } from '@tanstack/react-query';

import type { ServedHealth } from '@/components/shared/project-outcome-chips';
import type { TrackingStatus } from '@/components/shared/tracking-status-meta';
import { apiGet } from '@/lib/api/client';
import { queryKeys, sortedKeyList, type PriorityBoardFilters } from '@/lib/query-keys';
import type { ProjectFacets } from '@/surfaces/dashboard/api/types';
import type { Id } from '@/types/common';
import type { HubName, LabRegion, ProjectCategory, ProjectPriority, ProjectStatus } from '@/types/enums';

export interface PriorityBoardCard {
  project_id: Id;
  name: string;
  hub_id: Id;
  hub: HubName;
  category: ProjectCategory | null;
  status: ProjectStatus;
  /** P25-T03: the project's external code, null if none (tells similar names apart in the List layout). */
  external_code: string | null;
  /** Weighted priority score, as the Matrix serves it. */
  score: number | null;
  /** The stored score band; kept for existing clients, always equal to `score_band` (P25-T03). */
  band: ProjectPriority | null;
  /** P25-T03 (ADR 0036): the suggested band AFTER the hub's P1 capacity fill, as on Matrix rows. */
  suggested_band: ProjectPriority | null;
  /** P25-T03: the pure score band. */
  score_band: ProjectPriority | null;
  /** P25-T03: promoted to P1 by the hub's capacity fill. */
  capacity_fill: boolean;
  /** P25-T03: the served reason, shown verbatim in the tooltip. */
  capacity_fill_reason: string | null;
  /** True ⇒ pinned to P1, not draggable out (ADR 0018 §4). */
  hard_gated: boolean;
  is_vip: boolean;
  projected_end_week: number | null;
  within_year: boolean | null;
  health: ServedHealth | null;
  tracking_status: TrackingStatus;
}

export interface PriorityBoardColumn {
  priority: ProjectPriority;
  /** Served; equals `cards.length`. */
  count: number;
  /** P13-T12 (API_CONTRACT_P13 §6): the column's REMAINING design work from
   *  the current week, in weeks (2 dp), server-side, for the filtered set. Not
   *  the total planned load, so it differs from Capacity's load. Never summed
   *  from the cards. */
  design_weeks: number;
  /** P13-T12: the column's remaining lab work from the current week, in weeks. */
  lab_weeks: number;
  /** Sorted by score descending (nulls last), then name — by the server. */
  cards: PriorityBoardCard[];
}

export interface PriorityBoardResponse {
  /** The active run used for finish/health; null = none yet. */
  run_id: Id | null;
  /** Always five, in order P1, P2, P3, P4, Q. */
  columns: PriorityBoardColumn[];
}

export type { PriorityBoardFilters } from '@/lib/query-keys';

/** True when no toolbar filter is set (the key then keeps its P12 shape). */
export function isEmptyBoardFilters(filters: PriorityBoardFilters | undefined): boolean {
  return (
    !filters ||
    Object.values(filters).every((v) => v === undefined || v === '' || (Array.isArray(v) && v.length === 0))
  );
}

/** P31: the key form — category / type lists sorted, so press order never splits the cache. */
function keyBoardFilters(filters: PriorityBoardFilters): PriorityBoardFilters {
  return { ...filters, category: sortedKeyList(filters.category), type: sortedKeyList(filters.type) };
}

export function fetchPriorityBoard(
  hubId: string | null,
  signal?: AbortSignal,
  region: LabRegion | null = null,
  filters?: PriorityBoardFilters,
): Promise<PriorityBoardResponse> {
  return apiGet<PriorityBoardResponse>('/priority-board', {
    query: {
      hub_id: hubId ?? undefined,
      region: region ?? undefined,
      // P13-T12: every filter is applied by the server (§3 semantics); the
      // column counts and D/L weeks follow the filtered set.
      q: filters?.q || undefined,
      // P31: repeated params (OR within, AND across); an empty list sends nothing.
      category: filters?.category && filters.category.length > 0 ? filters.category : undefined,
      type: filters?.type && filters.type.length > 0 ? filters.type : undefined,
      status_: filters?.status_ || undefined,
      leader_engineer_id: filters?.leader_engineer_id || undefined,
    },
    signal,
  });
}

/** P13 (ADR 0025): `region` is the global country filter, keyed beside the hub.
 *  P13-T12: `filters` are the toolbar's server-side filters. */
export function usePriorityBoard(
  hubId: string | null,
  region: LabRegion | null = null,
  filters?: PriorityBoardFilters,
) {
  const keyFilters = isEmptyBoardFilters(filters) || filters === undefined ? undefined : keyBoardFilters(filters);
  return useQuery({
    queryKey: queryKeys.priorityBoard(hubId, region, keyFilters),
    queryFn: ({ signal }) => fetchPriorityBoard(hubId, signal, region, keyFilters),
    // Keep the board on screen while a new search / filter loads — but only
    // for the same hub and country, never another selection's columns.
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === hubId && previousQuery.queryKey[2] === region ? previous : undefined,
  });
}

/** The leader list of `GET /dashboard/projects/facets` (API_CONTRACT_P13 §3) —
 *  the same endpoint, type and cache entry as the Dashboard register's filters
 *  (`ProjectFacets`, already pinned by the backend contract test).
 *  GDPR (OQ #8): `name` is null unless the leader is the caller. */
type BoardLeaderFacets = Pick<ProjectFacets, 'leaders'>;

/** P13-T12: Leader filter options. Every role that can read the board
 *  (`matrix`) can read the Dashboard; `enabled` still guards it. */
export function useBoardLeaderFacets(hubId: string | null, region: LabRegion | null, enabled: boolean) {
  return useQuery({
    queryKey: queryKeys.dashboardProjectFacets(hubId, region),
    queryFn: ({ signal }) =>
      apiGet<BoardLeaderFacets>('/dashboard/projects/facets', {
        query: { hub_id: hubId ?? undefined, region: region ?? undefined },
        signal,
      }),
    enabled,
    staleTime: 60_000,
    retry: false,
  });
}

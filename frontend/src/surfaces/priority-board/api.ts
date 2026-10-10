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
import { queryKeys } from '@/lib/query-keys';
import type { Id } from '@/types/common';
import type { HubName, ProjectCategory, ProjectPriority, ProjectStatus } from '@/types/enums';

export interface PriorityBoardCard {
  project_id: Id;
  name: string;
  hub_id: Id;
  hub: HubName;
  category: ProjectCategory | null;
  status: ProjectStatus;
  /** Weighted priority score, as the Matrix serves it. */
  score: number | null;
  /** Score-derived band, as the Matrix serves it. */
  band: ProjectPriority | null;
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
  /** Sorted by score descending (nulls last), then name — by the server. */
  cards: PriorityBoardCard[];
}

export interface PriorityBoardResponse {
  /** The active run used for finish/health; null = none yet. */
  run_id: Id | null;
  /** Always five, in order P1, P2, P3, P4, Q. */
  columns: PriorityBoardColumn[];
}

export function fetchPriorityBoard(hubId: string | null, signal?: AbortSignal): Promise<PriorityBoardResponse> {
  return apiGet<PriorityBoardResponse>('/priority-board', { query: { hub_id: hubId ?? undefined }, signal });
}

export function usePriorityBoard(hubId: string | null) {
  return useQuery({
    queryKey: queryKeys.priorityBoard(hubId),
    queryFn: ({ signal }) => fetchPriorityBoard(hubId, signal),
  });
}

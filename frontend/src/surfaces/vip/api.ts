// Mirrors of backend/schemas/vip.py (P12 contract §6), reconciled field for
// field with the P12-T03 backend on 2026-10-10.

/**
 * VIP projects (ADR 0022). The server selects, ranks and flags every list; the
 * browser prints rank, marker and figures as served (I9, I12, I13).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { ServedHealth } from '@/components/shared/project-outcome-chips';
import type { TrackingStatus } from '@/components/shared/tracking-status-meta';
import { apiGet, apiSend } from '@/lib/api/client';
import { queryKeys } from '@/lib/query-keys';
import type { Id } from '@/types/common';
import type { HubName, ProjectCategory, ProjectPriority, WorkflowStepStatus } from '@/types/enums';

export type VipYear = 'plan' | 'next';

/** Allowed `limit` (contract §6: 10..15, default 15). */
export const VIP_LIMIT_DEFAULT = 15;

export interface VipCurrentStage {
  step_id: string;
  step_name: string;
  status: WorkflowStepStatus;
}

export interface VipProject {
  rank: number;
  selection: 'pinned' | 'auto';
  project_id: Id;
  name: string;
  category: ProjectCategory | null;
  priority: ProjectPriority | null;
  score: number | null;
  expected_end_week: number | null;
  projected_end_week: number | null;
  within_year: boolean | null;
  health: ServedHealth | null;
  /** Roll-up progress (I12), served. */
  progress_pct: number | null;
  current_stage: VipCurrentStage | null;
  tracking_status: TrackingStatus;
}

export interface VipHub {
  hub_id: Id;
  hub: HubName;
  pinned_count: number;
  /** More pins than `limit`: every pin is shown (ADR 0022 §3). */
  over_limit: boolean;
  projects: VipProject[];
}

export interface VipProjectsResponse {
  run_id: Id | null;
  year: VipYear;
  /** `[first, last]` horizon week of the year. */
  week_range: number[];
  limit: number;
  hubs: VipHub[];
}

export interface VipPinRequest {
  is_vip: boolean;
}

export interface VipPinResponse {
  project_id: Id;
  is_vip: boolean;
}

export function fetchVipProjects(
  params: { year: VipYear; hubId: string | null; limit: number },
  signal?: AbortSignal,
): Promise<VipProjectsResponse> {
  return apiGet<VipProjectsResponse>('/vip-projects', {
    query: { year: params.year, hub_id: params.hubId ?? undefined, limit: params.limit },
    signal,
  });
}

export function setProjectVip(projectId: string, isVip: boolean): Promise<VipPinResponse> {
  const body: VipPinRequest = { is_vip: isVip };
  return apiSend<VipPinResponse>('PUT', `/projects/${projectId}/vip`, body);
}

export function useVipProjects(params: { year: VipYear; hubId: string | null; limit: number }) {
  return useQuery({
    queryKey: queryKeys.vipProjects(params),
    queryFn: ({ signal }) => fetchVipProjects(params, signal),
  });
}

/** Pin / unpin. A pin never recalculates (ADR 0022 §4); only views that show the flag refetch. */
export function useSetVip() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, isVip }: { projectId: string; isVip: boolean }) => setProjectVip(projectId, isVip),
    onSuccess: () => {
      for (const key of [['vip-projects'], ['priority-board'], ['gantt'], ['dashboard', 'projects'], ['projects']]) {
        void queryClient.invalidateQueries({ queryKey: key });
      }
    },
  });
}

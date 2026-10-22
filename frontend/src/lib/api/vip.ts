/**
 * VIP (ADR 0022, superseded in part by ADR 0027).
 *
 * P14 (ADR 0027, docs/API_CONTRACT_P14.md §2): the curated per-area VIP board
 * shown on the Dashboard. The server serves the areas (OEM / Europe / India),
 * their hubs, the fixed pillar reference data, every count, and the live
 * facts of each linked project from the active run (I9). The browser renders
 * them; it never derives an area, a count or a project fact.
 *
 * The P12 `/vip-projects` mirrors below moved here from the deleted
 * `surfaces/vip/api.ts` when the `/vip` page left the nav (ADR 0027 §1). The
 * endpoint and `PUT /projects/{id}/vip` still exist server-side; the types
 * stay so the backend contract test can keep pairing them.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import type { ServedHealth } from '@/components/shared/project-outcome-chips';
import type { TrackingStatus } from '@/components/shared/tracking-status-meta';
import { queryKeys } from '@/lib/query-keys';
import type { HubFilterParams } from '@/stores/hub-filter';
import type { Id } from '@/types/common';
import type {
  HubName,
  LabRegion,
  ProjectCategory,
  ProjectPriority,
  ProjectStatus,
  WorkflowStepStatus,
} from '@/types/enums';

import { apiGet, apiSend } from './client';

// ---------------------------------------------------------------------------
// P12 `/vip-projects` (backend/schemas/vip.py), reconciled 2026-10-10.
// ---------------------------------------------------------------------------

export type VipYear = 'plan' | 'next';

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

// ---------------------------------------------------------------------------
// P14 `/vip-board` and `/vip-items` (contract §2).
// PLACEHOLDER — written against the contract while backend B builds it.
// ---------------------------------------------------------------------------

/** Wire values of `vip_items.area`. Amended for OQ #39 (ADR 0027 amendment):
 *  the area is the hub's `lab_region` — Greece / India / Romania, the same
 *  grouping as the ADR 0025 country filter (OEM hubs count as Greece). */
export type VipArea = LabRegion;

export const VIP_PILLARS = ['INNOVATION', 'MARKET_EXPANSION', 'PERFORMANCE'] as const;
export type VipPillar = (typeof VIP_PILLARS)[number];

export const VIP_STATUS_TAGS = [
  'ON_TRACK',
  'DELAYED',
  'HIGH_RISK',
  'COMMERCIALIZED',
  'IMPLEMENTED',
  'TBD',
  'UNDER_INVESTIGATION',
  'AWAITING_APPROVAL',
] as const;
export type VipStatusTag = (typeof VIP_STATUS_TAGS)[number];

/** Server-side limits (`models/vip.py`). */
export const VIP_TITLE_MAX = 200;
export const VIP_NOTE_MAX = 200;

/** Fixed pillar reference data, served with the board. */
export interface VipPillarInfo {
  key: VipPillar;
  /** "01", "02", "03". */
  number: string;
  label: string;
  headline: string;
  impact: string[];
}

/** A linked project's served live facts (active run, I9). No financial fields. */
export interface VipItemProject {
  id: Id;
  name: string;
  hub: HubName;
  priority: ProjectPriority | null;
  status: ProjectStatus;
  projected_end_week: number | null;
  within_year: boolean | null;
  health: ServedHealth | null;
}

export interface VipItem {
  id: Id;
  pillar: VipPillar;
  title: string;
  status_tag: VipStatusTag | null;
  status_note: string | null;
  highlighted: boolean;
  sort_order: number;
  /** One level of sub-items (same shape; their own `children` are empty). */
  children: VipItem[];
  /** Linked projects in the caller's scope. */
  projects: VipItemProject[];
  /** Linked projects outside the caller's scope — a count only. */
  hidden_project_count: number;
}

/** A VIP (highlighted) item named on the area tile, in served order. */
export interface VipItemRef {
  id: Id;
  title: string;
}

export interface VipBoardArea {
  area: VipArea;
  label: string;
  hubs: HubName[];
  item_count: number;
  highlighted_count: number;
  /** ADR 0040: projects pinned VIP (manual `is_vip`) in the area, visible to the caller. */
  vip_project_count: number;
  high_risk_count: number;
  linked_project_count: number;
  /** OQ #39: yellow highlight = VIP. The tile lists these ("2–3 VIP per hub"). */
  vip_items: VipItemRef[];
  items: VipItem[];
}

export interface VipBoardResponse {
  run_id: Id | null;
  pillars: VipPillarInfo[];
  /** In the order Greece, India, Romania; only areas in the caller's filtered scope. */
  areas: VipBoardArea[];
}

export interface VipItemCreateRequest {
  area: VipArea;
  pillar: VipPillar;
  title: string;
  status_tag?: VipStatusTag | null;
  status_note?: string | null;
  highlighted?: boolean;
  parent_id?: Id | null;
  sort_order?: number;
}

export interface VipItemUpdateRequest {
  pillar?: VipPillar;
  title?: string;
  status_tag?: VipStatusTag | null;
  status_note?: string | null;
  highlighted?: boolean;
  parent_id?: Id | null;
  sort_order?: number;
}

export interface VipItemLinksRequest {
  project_ids: Id[];
}

export function fetchVipBoard(params: HubFilterParams, signal?: AbortSignal): Promise<VipBoardResponse> {
  return apiGet<VipBoardResponse>('/vip-board', {
    query: { hub_id: params.hub_id, region: params.region },
    signal,
  });
}

export function createVipItem(body: VipItemCreateRequest): Promise<unknown> {
  return apiSend<unknown>('POST', '/vip-items', body);
}

export function updateVipItem(itemId: string, body: VipItemUpdateRequest): Promise<unknown> {
  return apiSend<unknown>('PATCH', `/vip-items/${encodeURIComponent(itemId)}`, body);
}

export function deleteVipItem(itemId: string): Promise<unknown> {
  return apiSend<unknown>('DELETE', `/vip-items/${encodeURIComponent(itemId)}`);
}

export function setVipItemProjects(itemId: string, projectIds: string[]): Promise<unknown> {
  const body: VipItemLinksRequest = { project_ids: projectIds };
  return apiSend<unknown>('PUT', `/vip-items/${encodeURIComponent(itemId)}/projects`, body);
}

/** `GET /vip-board` for the global hub / country filter (both in the key). */
export function useVipBoard(params: HubFilterParams) {
  return useQuery({
    queryKey: queryKeys.vipBoard(params),
    queryFn: ({ signal }) => fetchVipBoard(params, signal),
  });
}

export type VipItemWrite =
  | { kind: 'create'; body: VipItemCreateRequest }
  | { kind: 'update'; itemId: string; body: VipItemUpdateRequest }
  | { kind: 'delete'; itemId: string }
  | { kind: 'link'; itemId: string; projectIds: string[] };

function runVipWrite(write: VipItemWrite): Promise<unknown> {
  switch (write.kind) {
    case 'create':
      return createVipItem(write.body);
    case 'update':
      return updateVipItem(write.itemId, write.body);
    case 'delete':
      return deleteVipItem(write.itemId);
    case 'link':
      return setVipItemProjects(write.itemId, write.projectIds);
  }
}

/**
 * Every VIP item write (`MATRIX` WRITE). Since ADR 0040 a link no longer changes
 * `projects.is_vip` (only `PUT /projects/{id}/vip` does); the board views refetch.
 * Nothing recalculates (ADR 0027 §5).
 */
export function useVipItemWrite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: runVipWrite,
    onSuccess: (_data, write) => {
      const keys: (readonly unknown[])[] = [queryKeys.vipBoard()];
      if (write.kind === 'link' || write.kind === 'delete') {
        keys.push(['priority-board'], ['gantt'], ['dashboard', 'projects'], ['projects']);
      }
      for (const key of keys) void queryClient.invalidateQueries({ queryKey: key });
    },
  });
}

// ---------------------------------------------------------------------------
// `PUT /projects/{id}/vip` (owner ask 2026-10-22: make a project VIP from the
// Matrix). The server authorises it (Project Registration write, hub admin
// grant) and audits it; on success every reader of `is_vip` is re-read.
// ---------------------------------------------------------------------------

export function useSetProjectVip() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId, isVip }: { projectId: Id; isVip: boolean }) =>
      apiSend<VipPinResponse>('PUT', `/projects/${projectId}/vip`, { is_vip: isVip } satisfies VipPinRequest),
    onSuccess: () => {
      for (const key of ['priority-matrix', 'priority-board', 'vip-board', 'vip-projects', 'dashboard', 'projects', 'gantt']) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
    },
  });
}

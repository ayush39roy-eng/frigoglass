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
import { askEditConflict } from '@/stores/edit-conflict-host';
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
import { changedKeys, EditConflictDismissedError, sendEditWithBase, type EditBase } from './edit-conflict';

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
  /** P42 (API_CONTRACT_P42 §6): the band label; the stored flags (null when
   *  not in the active run) and the served non-counting text ("Not scheduled
   *  (P4)", "Queued — fits by W40"; null for a counting project). */
  priority_label?: string | null;
  counts_toward_year?: boolean | null;
  not_scheduled_priority?: boolean | null;
  outcome_label?: string | null;
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
  /** P47 (ADR 0059 C1): the value as read of each field sent; `{}` = no check. */
  base?: EditBase;
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
  /** P57 (ADR 0067): false for a Commercialized / Cancelled project (priority "Not applicable"). */
  priority_applicable: boolean;
  name: string;
  hub: HubName;
  priority: ProjectPriority | null;
  status: ProjectStatus;
  projected_end_week: number | null;
  within_year: boolean | null;
  health: ServedHealth | null;
  /** P42 (API_CONTRACT_P42 §6): the band label; the stored flags (null when
   *  not in the active run) and the served non-counting text ("Not scheduled
   *  (P4)", "Queued — fits by W40"; null for a counting project). */
  priority_label?: string | null;
  counts_toward_year?: boolean | null;
  not_scheduled_priority?: boolean | null;
  outcome_label?: string | null;
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
  /** P47 (ADR 0059 C1): the value as read of each field sent; `{}` = no check. */
  base?: EditBase;
}

export interface VipItemLinksRequest {
  project_ids: Id[];
  /** P47 (ADR 0059 C1): the value as read of each field sent; `{}` = no check. */
  base?: EditBase;
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
  /** P47 (ADR 0059): `original` = the item as read when the edit started; only
   *  the fields that differ from it are sent, each with its `base`. */
  | { kind: 'update'; itemId: string; body: VipItemUpdateRequest; original?: object }
  | { kind: 'delete'; itemId: string }
  /** P47: `originalProjectIds` = the linked projects as read (`base.project_ids`). */
  | { kind: 'link'; itemId: string; projectIds: string[]; originalProjectIds?: string[] };

/** A conflict-checked VIP write: the app-wide dialog asks whose value to keep. */
async function checked(body: object, original: object, send: (withBase: object) => Promise<unknown>): Promise<unknown> {
  if (Object.keys(body).length === 0) return null;
  const sent = await sendEditWithBase({ body, original, send, ask: askEditConflict });
  if (sent.outcome === 'dismissed') throw new EditConflictDismissedError();
  return sent.outcome === 'saved' ? sent.data : null;
}

function runVipWrite(write: VipItemWrite): Promise<unknown> {
  switch (write.kind) {
    case 'create':
      return createVipItem(write.body);
    case 'update': {
      if (!write.original) return updateVipItem(write.itemId, write.body);
      const original = write.original;
      const changes = Object.fromEntries(
        changedKeys(original, write.body).map((k) => [k, (write.body as Record<string, unknown>)[k]]),
      );
      return checked(changes, original, (withBase) => updateVipItem(write.itemId, withBase as VipItemUpdateRequest));
    }
    case 'delete':
      return deleteVipItem(write.itemId);
    case 'link':
      if (!write.originalProjectIds) return setVipItemProjects(write.itemId, write.projectIds);
      return checked({ project_ids: write.projectIds }, { project_ids: write.originalProjectIds }, (withBase) =>
        apiSend<unknown>('PUT', `/vip-items/${encodeURIComponent(write.itemId)}/projects`, withBase),
      );
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

/** Readers re-read after a pin settles (every reader of `is_vip`). */
const VIP_READER_KEYS = ['priority-matrix', 'priority-board', 'vip-board', 'vip-projects', 'dashboard', 'projects', 'gantt'];

/** A cached `priority-matrix` entry with `project_id`'s `is_vip` set to `isVip`;
 *  anything that is not a Matrix row (or row list) is returned unchanged. */
function withVipPin(data: unknown, projectId: Id, isVip: boolean): unknown {
  const pin = (item: unknown): unknown => {
    if (item === null || typeof item !== 'object') return item;
    const row = item as { project_id?: unknown; is_vip?: unknown };
    if (row.project_id !== projectId || !('is_vip' in row) || row.is_vip === isVip) return item;
    return { ...row, is_vip: isVip };
  };
  if (Array.isArray(data)) {
    let changed = false;
    const next = data.map((item) => {
      const out = pin(item);
      if (out !== item) changed = true;
      return out;
    });
    return changed ? next : data;
  }
  return pin(data);
}

interface VipPinContext {
  snapshot: [readonly unknown[], unknown][];
}

/**
 * P34-T02 (VIP star bug): the pin is shown at once. Before, the star only
 * changed when the whole `/priorities` list had been re-read (~1 s after the
 * 200), and the row then jumped into the VIP group at the top of the grid, so
 * the user saw nothing happen where they clicked. Now the cached Matrix rows
 * (`priority-matrix` lists and single rows) are updated optimistically, rolled
 * back on an error (403 included), and every reader is re-read once settled.
 * `is_vip` is a served flag flipped verbatim; nothing is derived.
 */
export function useSetProjectVip() {
  const queryClient = useQueryClient();
  return useMutation<VipPinResponse, Error, { projectId: Id; isVip: boolean }, VipPinContext>({
    // P47 (ADR 0059): the pin starts from the opposite of the asked value.
    mutationFn: async ({ projectId, isVip }) =>
      (await checked({ is_vip: isVip } satisfies VipPinRequest, { is_vip: !isVip }, (withBase) =>
        apiSend<VipPinResponse>('PUT', `/projects/${projectId}/vip`, withBase),
      )) as VipPinResponse,
    onMutate: async ({ projectId, isVip }) => {
      // An in-flight re-read must not overwrite the optimistic pin.
      await queryClient.cancelQueries({ queryKey: ['priority-matrix'] });
      const snapshot = queryClient.getQueriesData({ queryKey: ['priority-matrix'] });
      queryClient.setQueriesData({ queryKey: ['priority-matrix'] }, (data: unknown) => withVipPin(data, projectId, isVip));
      return { snapshot };
    },
    onError: (_err, _vars, context) => {
      for (const [key, data] of context?.snapshot ?? []) queryClient.setQueryData(key, data);
    },
    onSettled: () => {
      for (const key of VIP_READER_KEYS) {
        void queryClient.invalidateQueries({ queryKey: [key] });
      }
    },
  });
}

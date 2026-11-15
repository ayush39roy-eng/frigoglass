/**
 * Fetchers for the Workflow Settings surface (P9-T04, contract §3). Thin
 * wrappers over `apiGet` / `apiSendWithHeaders` — no transformation beyond
 * reading the `X-Schedule-Stale-Count` header the contract puts on every
 * successful PUT. Server-side RBAC: Admin reads, Super Admin writes; every PUT
 * is audit-logged and marks every schedulable project `schedule_stale`.
 */

import { apiGet, apiSend, apiSendWithHeaders, ApiError, type ApiRequestOptions } from '@/lib/api/client';

import type { WorkflowId } from '@/types/enums';

import type {
  ApplyPreviewResponse,
  BEquivalentRow,
  CategoryCreateRequest,
  CategoryCreateResponse,
  CategoryTimeline,
  ChamberSettingUpdateRequest,
  HubCalendarUpdateRequest,
  StepsUpdateRequest,
  TemplateApplyRequest,
  TemplateApplyResponse,
  TemplateChangeSet,
  TimelinePreviewRequest,
  TimelinePreviewResponse,
  WorkflowSettings,
  WorkflowSettingsSaveResult,
} from './types';

type FetchCtx = Pick<ApiRequestOptions, 'signal'>;

export const STALE_COUNT_HEADER = 'X-Schedule-Stale-Count';

export function fetchWorkflowSettings(ctx: FetchCtx = {}): Promise<WorkflowSettings> {
  return apiGet<WorkflowSettings>('/workflow-settings', ctx);
}

/** P13-T16: per-category earliest-start timelines (API_CONTRACT_P13 §5). */
export function fetchCategoryTimelines(workflow: WorkflowId, ctx: FetchCtx = {}): Promise<CategoryTimeline[]> {
  return apiGet<CategoryTimeline[]>('/workflow-settings/category-timelines', { ...ctx, query: { workflow } });
}

/** P13-T16: B-equivalent design / lab ratios (API_CONTRACT_P13 §5). */
export function fetchBEquivalent(workflow: WorkflowId, ctx: FetchCtx = {}): Promise<BEquivalentRow[]> {
  return apiGet<BEquivalentRow[]>('/workflow-settings/b-equivalent', { ...ctx, query: { workflow } });
}

async function put(path: string, body: unknown): Promise<WorkflowSettingsSaveResult> {
  const { data, headers } = await apiSendWithHeaders<WorkflowSettings>('PUT', path, body);
  const raw = headers.get(STALE_COUNT_HEADER);
  const parsed = raw === null ? Number.NaN : Number(raw);
  return { settings: data, staleCount: Number.isFinite(parsed) ? parsed : 0 };
}

export function saveSteps(workflowId: string, body: StepsUpdateRequest): Promise<WorkflowSettingsSaveResult> {
  return put(`/workflow-settings/steps/${workflowId}`, body);
}

// P33: `PUT /workflow-settings/lead-times` is retired (410 USE_TEMPLATE_APPLY);
// the Lead times tab saves through `applyTemplate` below (contract Part G / I).

// --- P33 (API_CONTRACT_P33 Parts B2, D, E): `workflow_templates.write` only. ---

/** D: stateless timeline with the overrides laid over the saved template. */
export function previewTimeline(body: TimelinePreviewRequest, ctx: FetchCtx = {}): Promise<TimelinePreviewResponse> {
  return apiSend<TimelinePreviewResponse>('POST', '/workflow-templates/timeline-preview', body, ctx);
}

/** E2: who would receive the change set. No writes. */
export function previewApply(body: TemplateChangeSet, ctx: FetchCtx = {}): Promise<ApplyPreviewResponse> {
  return apiSend<ApplyPreviewResponse>('POST', '/workflow-templates/apply-preview', body, ctx);
}

/** E3: write the template and the copies, then one recalculation. */
export function applyTemplate(body: TemplateApplyRequest): Promise<TemplateApplyResponse> {
  return apiSend<TemplateApplyResponse>('POST', '/workflow-templates/apply', body);
}

/** B2: add a category (copies a template, inserts at a rank). */
export function createCategory(body: CategoryCreateRequest): Promise<CategoryCreateResponse> {
  return apiSend<CategoryCreateResponse>('POST', '/workflow-templates/categories', body);
}

export function saveHubCalendar(
  hubId: string,
  body: HubCalendarUpdateRequest,
): Promise<WorkflowSettingsSaveResult> {
  return put(`/workflow-settings/hub-calendars/${hubId}`, body);
}

export function saveChamber(
  chamberId: string,
  body: ChamberSettingUpdateRequest,
): Promise<WorkflowSettingsSaveResult> {
  return put(`/workflow-settings/chambers/${chamberId}`, body);
}

export function retryUnlessAuth(failureCount: number, error: Error): boolean {
  if (error instanceof ApiError && (error.isForbidden || error.isUnauthorized)) return false;
  return failureCount < 1;
}

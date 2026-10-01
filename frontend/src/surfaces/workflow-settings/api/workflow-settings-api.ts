/**
 * Fetchers for the Workflow Settings surface (P9-T04, contract §3). Thin
 * wrappers over `apiGet` / `apiSendWithHeaders` — no transformation beyond
 * reading the `X-Schedule-Stale-Count` header the contract puts on every
 * successful PUT. Server-side RBAC: Admin reads, Super Admin writes; every PUT
 * is audit-logged and marks every schedulable project `schedule_stale`.
 */

import { apiGet, apiSendWithHeaders, ApiError, type ApiRequestOptions } from '@/lib/api/client';

import type {
  ChamberSettingUpdateRequest,
  HubCalendarUpdateRequest,
  LeadTimesUpdateRequest,
  StepsUpdateRequest,
  WorkflowSettings,
  WorkflowSettingsSaveResult,
} from './types';

type FetchCtx = Pick<ApiRequestOptions, 'signal'>;

export const STALE_COUNT_HEADER = 'X-Schedule-Stale-Count';

export function fetchWorkflowSettings(ctx: FetchCtx = {}): Promise<WorkflowSettings> {
  return apiGet<WorkflowSettings>('/workflow-settings', ctx);
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

export function saveLeadTimes(body: LeadTimesUpdateRequest): Promise<WorkflowSettingsSaveResult> {
  return put('/workflow-settings/lead-times', body);
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

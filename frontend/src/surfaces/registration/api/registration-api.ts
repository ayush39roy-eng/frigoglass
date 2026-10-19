/**
 * Fetchers for the Project Registration surface (P4-T06).
 *
 * Thin wrappers over `apiGet` / `apiSend` — no transformation, no derived
 * numbers, no client-side hard-gate decision. Each maps 1:1 to an endpoint in
 * `backend/api/routers/projects.py`.
 */

import { apiGet, apiSend, apiSendWithHeaders, type ApiRequestOptions } from '@/lib/api/client';
import { readRecalcHeaders, type PatchRecalcSignal } from '@/lib/api/priority-move';

import type {
  HardGateStatus,
  ProjectCreateRequest,
  ProjectListItem,
  ProjectRead,
  ProjectSubmitRequest,
  ProjectUpdateRequest,
} from './types';

type FetchCtx = Pick<ApiRequestOptions, 'signal'>;

export interface ProjectListParams {
  hubId?: string | undefined;
  /** P13-T17: case-insensitive substring of name or external code (≤ 100), server-side. */
  q?: string | undefined;
  category?: string | undefined;
  status?: string | undefined;
  priority?: string | undefined;
  type?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export function fetchProjects(
  params: ProjectListParams,
  ctx: FetchCtx = {},
): Promise<ProjectListItem[]> {
  return apiGet<ProjectListItem[]>('/projects', {
    ...ctx,
    query: {
      hub_id: params.hubId,
      q: params.q,
      category: params.category,
      status_: params.status,
      priority: params.priority,
      type_: params.type,
      limit: params.limit,
      offset: params.offset,
    },
  });
}

export function fetchProject(projectId: string, ctx: FetchCtx = {}): Promise<ProjectRead> {
  return apiGet<ProjectRead>(`/projects/${encodeURIComponent(projectId)}`, ctx);
}

export function fetchHardGateStatus(
  projectId: string,
  ctx: FetchCtx = {},
): Promise<HardGateStatus> {
  return apiGet<HardGateStatus>(`/projects/${encodeURIComponent(projectId)}/hard-gate-status`, ctx);
}

/** `POST /projects` — always created in `Draft`, regardless of how much of the
 *  body is filled in. */
export function createProject(body: ProjectCreateRequest): Promise<ProjectRead> {
  return apiSend<ProjectRead>('POST', '/projects', body);
}

/** A PATCH's body plus the P11 recalc signal from its response headers. */
export interface ProjectUpdateResult {
  project: ProjectRead;
  /** Set only when the PATCH changed priority (P11 contract §2, ADR 0015). */
  recalc: PatchRecalcSignal | null;
}

/** `PATCH /projects/{id}` — partial update. Never send `status` here to leave
 *  Draft; use `submitProject`, which runs the hard-gate check. A priority
 *  change schedules by itself (ADR 0015): the server says so in the
 *  `X-Schedule-Recalc` / `X-Schedule-Run-Id` / `X-Schedule-Baseline-Run-Id`
 *  headers, read verbatim here. */
export async function updateProject(
  projectId: string,
  body: ProjectUpdateRequest,
): Promise<ProjectUpdateResult> {
  const { data, headers } = await apiSendWithHeaders<ProjectRead>('PATCH', `/projects/${encodeURIComponent(projectId)}`, body);
  return { project: data, recalc: readRecalcHeaders(headers) };
}

/** `POST /projects/{id}/submit` — leave `Draft`. 422s with `missing_fields` if
 *  any hard-gate field is still unset. Does not itself trigger a schedule
 *  recalculation (mirrors the Gantt freeze toggle's "recalc needed" pattern —
 *  the newly-schedulable project is only picked up by the next run). */
export function submitProject(
  projectId: string,
  body: ProjectSubmitRequest,
): Promise<ProjectRead> {
  return apiSend<ProjectRead>('POST', `/projects/${encodeURIComponent(projectId)}/submit`, body);
}

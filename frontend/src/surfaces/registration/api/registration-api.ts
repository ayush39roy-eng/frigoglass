/**
 * Fetchers for the Project Registration surface (P4-T06).
 *
 * Thin wrappers over `apiGet` / `apiSend` — no transformation, no derived
 * numbers, no client-side hard-gate decision. Each maps 1:1 to an endpoint in
 * `backend/api/routers/projects.py`.
 */

import { apiGet, apiSend, type ApiRequestOptions } from '@/lib/api/client';

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
  return apiGet<ProjectRead>(`/projects/${projectId}`, ctx);
}

export function fetchHardGateStatus(
  projectId: string,
  ctx: FetchCtx = {},
): Promise<HardGateStatus> {
  return apiGet<HardGateStatus>(`/projects/${projectId}/hard-gate-status`, ctx);
}

/** `POST /projects` — always created in `Draft`, regardless of how much of the
 *  body is filled in. */
export function createProject(body: ProjectCreateRequest): Promise<ProjectRead> {
  return apiSend<ProjectRead>('POST', '/projects', body);
}

/** `PATCH /projects/{id}` — partial update. Never send `status` here to leave
 *  Draft; use `submitProject`, which runs the hard-gate check. */
export function updateProject(
  projectId: string,
  body: ProjectUpdateRequest,
): Promise<ProjectRead> {
  return apiSend<ProjectRead>('PATCH', `/projects/${projectId}`, body);
}

/** `POST /projects/{id}/submit` — leave `Draft`. 422s with `missing_fields` if
 *  any hard-gate field is still unset. Does not itself trigger a schedule
 *  recalculation (mirrors the Gantt freeze toggle's "recalc needed" pattern —
 *  the newly-schedulable project is only picked up by the next run). */
export function submitProject(
  projectId: string,
  body: ProjectSubmitRequest,
): Promise<ProjectRead> {
  return apiSend<ProjectRead>('POST', `/projects/${projectId}/submit`, body);
}

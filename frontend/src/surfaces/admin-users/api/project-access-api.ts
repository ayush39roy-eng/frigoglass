/**
 * Fetchers for project-level access grants (ADR 0012, P10-T02
 * `api/routers/project_access.py`). Thin 1:1 wrappers — no transformation.
 * Every endpoint is scoped to one project; there is no "list every grant
 * across every project" endpoint, so the Project Access tab (P10-T03) picks
 * a project first, then lists that project's grants.
 */

import { apiGet, apiSend, type ApiRequestOptions } from '@/lib/api/client';

import type { ManageableProjectRead, ProjectAccessGrantCreateRequest, ProjectAccessGrantRead } from './types';

type FetchCtx = Pick<ApiRequestOptions, 'signal'>;

/** `GET /users/me/manageable-projects` (P10-F02) — the Project Access tab's
 *  project picker data source. No surface-permission gate: any authenticated
 *  principal may call it, and it returns exactly the projects the CALLER
 *  could grant/revoke on, which is what the picker needs regardless of the
 *  caller's Registration/Gantt read access. */
export function fetchManageableProjects(ctx: FetchCtx = {}): Promise<ManageableProjectRead[]> {
  return apiGet<ManageableProjectRead[]>('/users/me/manageable-projects', ctx);
}

export function fetchProjectAccessGrants(
  projectId: string,
  ctx: FetchCtx = {},
): Promise<ProjectAccessGrantRead[]> {
  return apiGet<ProjectAccessGrantRead[]>(`/projects/${projectId}/access`, ctx);
}

export function createProjectAccessGrant(
  projectId: string,
  body: ProjectAccessGrantCreateRequest,
): Promise<ProjectAccessGrantRead> {
  return apiSend<ProjectAccessGrantRead>('POST', `/projects/${projectId}/access`, body);
}

export function revokeProjectAccessGrant(projectId: string, grantId: string): Promise<void> {
  return apiSend<void>('DELETE', `/projects/${projectId}/access/${grantId}`);
}

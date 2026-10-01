/**
 * Fetchers for the Project Workspace (P9 contract §7). Thin wrappers — no
 * derived values. Hub-scoped and RBAC-checked server-side (`project_workspace`);
 * every mutation writes an audit row. File downloads go through `apiDownload`
 * (bytes to a Blob, saved via an object URL) — never rendered inline.
 */

import { apiDownload, apiGet, apiSend, apiUpload, ApiError, type ApiRequestOptions } from '@/lib/api/client';

import type {
  ActivityItem,
  AskAgentResponse,
  CommentRead,
  FilePatchRequest,
  FileRead,
  FileUploadInput,
  MentionCandidate,
  RecalculateResponse,
  StagePatchRequest,
  WorkspaceResponse,
} from './types';

type FetchCtx = Pick<ApiRequestOptions, 'signal'>;

export function fetchWorkspace(projectId: string, ctx: FetchCtx = {}): Promise<WorkspaceResponse> {
  return apiGet<WorkspaceResponse>(`/projects/${projectId}/workspace`, ctx);
}

export function patchStage(projectId: string, stepId: string, body: StagePatchRequest): Promise<WorkspaceResponse> {
  return apiSend<WorkspaceResponse>('PATCH', `/projects/${projectId}/stages/${stepId}`, body);
}

export function recalculate(projectId: string): Promise<RecalculateResponse> {
  return apiSend<RecalculateResponse>('POST', `/projects/${projectId}/recalculate`);
}

export function uploadFile(projectId: string, input: FileUploadInput): Promise<FileRead> {
  const form = new FormData();
  form.append('file', input.file);
  form.append('display_name', input.display_name);
  form.append('category', input.category);
  if (input.description) form.append('description', input.description);
  return apiUpload<FileRead>(`/projects/${projectId}/files`, form);
}

export function patchFile(projectId: string, fileId: string, body: FilePatchRequest): Promise<FileRead> {
  return apiSend<FileRead>('PATCH', `/projects/${projectId}/files/${fileId}`, body);
}

export function downloadFile(projectId: string, file: FileRead) {
  return apiDownload(`/projects/${projectId}/files/${file.id}/download`, {
    fallbackFilename: file.display_name,
  });
}

export function createComment(projectId: string, bodyMd: string): Promise<CommentRead> {
  return apiSend<CommentRead>('POST', `/projects/${projectId}/comments`, { body_md: bodyMd });
}

export function editComment(projectId: string, commentId: string, bodyMd: string): Promise<CommentRead> {
  return apiSend<CommentRead>('PATCH', `/projects/${projectId}/comments/${commentId}`, { body_md: bodyMd });
}

export function deleteComment(projectId: string, commentId: string): Promise<void> {
  return apiSend<void>('DELETE', `/projects/${projectId}/comments/${commentId}`);
}

export function fetchActivity(
  projectId: string,
  params: { before?: string | undefined; limit?: number | undefined },
  ctx: FetchCtx = {},
): Promise<ActivityItem[]> {
  return apiGet<ActivityItem[]>(`/projects/${projectId}/activity`, {
    ...ctx,
    query: { before: params.before, limit: params.limit },
  });
}

/** Withheld / empty while OQ#8 is open — callers degrade to plain text. */
export async function searchMentions(q: string, ctx: FetchCtx = {}): Promise<MentionCandidate[]> {
  try {
    return await apiGet<MentionCandidate[]>('/users/mention-search', { ...ctx, query: { q } });
  } catch (err) {
    if (err instanceof ApiError && (err.status === 403 || err.status === 404)) return [];
    throw err;
  }
}

/** `POST /projects/{id}/ask-agent` (ADR 0014). Stateless — one question in,
 *  one answer out; nothing here is cached or persisted client-side. */
export function askAgent(projectId: string, question: string): Promise<AskAgentResponse> {
  return apiSend<AskAgentResponse>('POST', `/projects/${projectId}/ask-agent`, { question });
}

export function retryUnlessAuth(failureCount: number, error: Error): boolean {
  if (error instanceof ApiError && (error.isForbidden || error.isUnauthorized || error.status === 404)) return false;
  return failureCount < 1;
}

/**
 * Fetchers for the User / Role Admin surface (P9-T04, contract §2). Thin 1:1
 * wrappers over `apiGet` / `apiSend` — no transformation. The endpoints are
 * RBAC-gated server-side (`USER_ROLE_ADMIN`; Admin may touch non-admin roles
 * only, Super Admin all) and every mutation writes an audit row.
 */

import { apiGet, apiSend, ApiError, type ApiRequestOptions } from '@/lib/api/client';

import type { RoleRead, UserCreateRequest, UserList, UserRead, UserUpdateRequest } from './types';

type FetchCtx = Pick<ApiRequestOptions, 'signal'>;

export interface UserListParams {
  q?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

export function fetchUsers(params: UserListParams, ctx: FetchCtx = {}): Promise<UserList> {
  return apiGet<UserList>('/users', {
    ...ctx,
    query: { q: params.q, limit: params.limit, offset: params.offset },
  });
}

export function fetchRoles(ctx: FetchCtx = {}): Promise<RoleRead[]> {
  return apiGet<RoleRead[]>('/roles', ctx);
}

export function createUser(body: UserCreateRequest): Promise<UserRead> {
  return apiSend<UserRead>('POST', '/users', body);
}

export function updateUser(userId: string, body: UserUpdateRequest): Promise<UserRead> {
  return apiSend<UserRead>('PATCH', `/users/${userId}`, body);
}

export function retryUnlessAuth(failureCount: number, error: Error): boolean {
  if (error instanceof ApiError && (error.isForbidden || error.isUnauthorized)) return false;
  return failureCount < 1;
}

// PLACEHOLDER (P9 contract §1) — hand-authored mirror of `GET /me` and
// `GET /me/dev-users`. The backend for these endpoints is built concurrently in
// P9-T03; this file is reconciled against the regenerated OpenAPI in the P9
// gate (P3-T07 contract test). Same convention as every per-surface
// `api/types.ts` (see `src/types/README.md`).

import { apiGet, type ApiRequestOptions } from '@/lib/api/client';
import type { RoleName, SurfaceKey } from '@/types/enums';
import type { Id } from '@/types/common';

type FetchCtx = Pick<ApiRequestOptions, 'signal'>;

/** One cell of the resolved `permissions[surface]` table. */
export interface SurfacePermission {
  read: boolean;
  write: boolean;
}

/**
 * `GET /me` (any authenticated principal). `permissions` carries one key per
 * `core.rbac.Surface` value — the frontend gates navigation and write
 * controls on it; the SERVER remains the enforcement point (ADR 0010 §2: UI
 * gating is convenience, never security).
 */
export interface MeResponse {
  user_id: Id;
  email: string;
  full_name: string;
  roles: RoleName[];
  hub_scope_all: boolean;
  hub_ids: Id[];
  engineer_id: Id | null;
  permissions: Record<SurfaceKey, SurfacePermission>;
  /** `true` only when the backend runs with `RPD_DEV_MODE` on. */
  dev_mode: boolean;
  /** 2026-09-30 (ADR 0012, P10-F03): `true` iff the caller has >=1 direct
   *  report (`User.manager_id`) AND >=1 project where their own effective
   *  access is Admin (`GET /users/me/manageable-projects` non-empty) — i.e.
   *  they have at least one delegation to manage. Drives the `/admin/users`
   *  route guard OR (`routes.tsx`) for a manager-delegate who holds no
   *  `user_role_admin` surface permission at all. */
  is_delegate_manager: boolean;
}

/** One row of `GET /me/dev-users` (dev mode only; 404 otherwise). */
export interface DevUser {
  email: string;
  full_name: string;
  roles: RoleName[];
}

export function fetchMe(ctx: FetchCtx = {}): Promise<MeResponse> {
  return apiGet<MeResponse>('/me', ctx);
}

export function fetchDevUsers(ctx: FetchCtx = {}): Promise<DevUser[]> {
  return apiGet<DevUser[]>('/me/dev-users', ctx);
}

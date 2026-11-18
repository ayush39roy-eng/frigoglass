// PLACEHOLDER (P9 contract §1) — hand-authored mirror of `GET /me` and
// `GET /me/dev-users`. The backend for these endpoints is built concurrently in
// P9-T03; this file is reconciled against the regenerated OpenAPI in the P9
// gate (P3-T07 contract test). Same convention as every per-surface
// `api/types.ts` (see `src/types/README.md`).

import { apiGet, apiSend, type ApiRequestOptions } from '@/lib/api/client';
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
  /** P13-T15, source changed at P37 (API_CONTRACT_P37 §1, ADR 0052): the
   *  CALENDAR week (Europe/Athens, or the `RPD_CURRENT_WEEK` pin), 1..52. */
  current_week: number;
  /** P13-T15: weeks left in the 52-week year (`52 − current_week`),
   *  served — the header never subtracts. */
  weeks_left_in_year: number;
  /** P37: today's date in Europe/Athens (`YYYY-MM-DD`). The header shows this,
   *  never the browser's date. */
  as_of_date: string;
  /** P37: the planning year (`RPD_PLAN_YEAR`). Every year label derives from it. */
  plan_year: number;
  /** P37: the ISO year is past `plan_year`; the week stays 52 and
   *  `POST /check-ins` answers 409 `PLAN_YEAR_CLOSED` (R37-10). */
  plan_year_closed: boolean;
  /** P37: `"pinned"` when the server runs with `RPD_CURRENT_WEEK` set. */
  week_source: 'calendar' | 'pinned';
  /** P37: the next Monday 00:00 Europe/Athens (ISO-8601 with offset). The
   *  client refetches `/me` then. */
  week_ends_at: string;
  /** P37: the active run's week against the calendar week; null with no active
   *  run (R37-7). */
  plan_week: PlanWeek | null;
}

/** `GET /me` `plan_week` (API_CONTRACT_P37 §1). `current` ⇔ `run_week ==
 *  current_week` (R37-6). */
export interface PlanWeek {
  run_week: number;
  run_version: number;
  status: PlanWeekStatus;
}

export type PlanWeekStatus = 'current' | 'recalculating' | 'pending' | 'failed';

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

/** `POST /me/dev-login` body (P46, ADR 0058 L1). `username` may also be the email. */
export interface DevLoginRequest {
  username: string;
  password: string;
}

/**
 * P46 (ADR 0058 L1): the server checks a test login (dev mode only). 200 is the
 * `DevUser` to sign in as; 401 is one generic failure; 429 is rate-limited;
 * 404 means the server is not in dev mode.
 */
export function devLogin(body: DevLoginRequest): Promise<DevUser> {
  return apiSend<DevUser>('POST', '/me/dev-login', body);
}

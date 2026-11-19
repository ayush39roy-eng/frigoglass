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
  /** P13-T15; P53 (ADR 0063, R53-1): the ABSOLUTE calendar week from
   *  `week_base_year` W1 (2027 W1 = 53), Europe/Athens or the
   *  `RPD_CURRENT_WEEK` pin. Never re-based. */
  current_week: number;
  /** `plan_year_end_week − current_week`, served — the header never subtracts. */
  weeks_left_in_year: number;
  /** P37: today's date in Europe/Athens (`YYYY-MM-DD`). The header shows this,
   *  never the browser's date. */
  as_of_date: string;
  /** P53 (R53-1): the year of `current_week`. Every year label derives from it. */
  plan_year: number;
  /** P53 (R53-6): the year absolute week 1 belongs to (2026). Week labels use
   *  it; the browser holds no year constant (I40). Optional only so pre-P53
   *  fixtures still type-check; the server always sends it. */
  week_base_year: number;
  /** P53: first / last absolute week of `plan_year` (served, I40). */
  plan_year_start_week: number;
  plan_year_end_week: number;
  /** P53 (R53-2): the Admin setting N (1..10) and the search limit
   *  `current_week + 52 × N` the next run will use. */
  horizon_years: number;
  horizon_weeks: number;
  /** Deprecated at P53 (R53-1: there is no closed year); served `false` for one
   *  release. The UI no longer reads it. */
  plan_year_closed?: boolean;
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

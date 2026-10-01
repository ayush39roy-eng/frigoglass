// PLACEHOLDER (P9 contract §2) — hand-authored mirror of the `/users` and
// `/roles` admin endpoints (ADR 0010 §3). The backend is built concurrently in
// P9-T03; reconciled against the regenerated OpenAPI in the P9 gate (P3-T07
// contract test). Same convention as every per-surface `api/types.ts`.

import type { RoleName } from '@/types/enums';
import type { Id } from '@/types/common';

/** One row of `GET /users` / the body of `POST` / `PATCH` responses. */
export interface UserRead {
  id: Id;
  email: string;
  full_name: string;
  is_active: boolean;
  roles: RoleName[];
  hub_scope_all: boolean;
  hub_ids: Id[];
  engineer_id: Id | null;
  /** 2026-09-30 (ADR 0012): the direct manager for grant delegation
   *  (`services.project_access.can_manage_grant`'s "U.manager_id == M.id"
   *  check). `null` means no manager set. Settable only via `PATCH
   *  /users/{id}` by whoever already clears `USER_ROLE_ADMIN` WRITE
   *  (Admin/Super Admin) — no extra restriction beyond that guard. */
  manager_id: Id | null;
  /** Provisioned / linked through OIDC JIT (P3-T02) rather than created here. */
  oidc_linked: boolean;
  created_at: string;
  updated_at: string;
}

/** `GET /users?q=&limit=&offset=`. */
export interface UserList {
  total_count: number;
  items: UserRead[];
}

/** `POST /users` body (`extra="forbid"`). There are no passwords — sign-in is OIDC. */
export interface UserCreateRequest {
  email: string;
  full_name: string;
  roles: RoleName[];
  hub_scope_all: boolean;
  hub_ids: Id[];
  engineer_id?: Id | null;
}

/** `PATCH /users/{id}` body — any subset of the create fields plus
 *  `is_active` and `manager_id` (ADR 0012; `manager_id` is PATCH-only, there
 *  is no such field on `UserCreateRequest`). `manager_id: null` clears it. */
export interface UserUpdateRequest extends Partial<UserCreateRequest> {
  is_active?: boolean;
  manager_id?: Id | null;
}

/** One row of `GET /roles`. `assignable` is false for Admin / Super Admin when
 *  the CALLER is an Admin (only a Super Admin grants those — ADR 0010 §1). */
export interface RoleRead {
  name: RoleName;
  description: string;
  assignable: boolean;
}

/** The 409 the server returns when a change would leave no active Super Admin. */
export const LAST_SUPER_ADMIN_CODE = 'LAST_SUPER_ADMIN';

// --- Project-level access grants (ADR 0012, P10-T02/T03) ---
// Hand-authored mirror of `backend/schemas/project_access.py` and
// `models/enums.py::ProjectAccessRole`. Distinct from `RoleName` — this is
// the finer per-(project, user) grain the resolver's rule 5 reads.

export const PROJECT_ACCESS_ROLES = ['viewer', 'editor', 'admin'] as const;
export type ProjectAccessRole = (typeof PROJECT_ACCESS_ROLES)[number];

/** One row of `GET /projects/{id}/access` / the body of a successful
 *  `POST`. Deliberately carries only ids — the caller joins `user_id` /
 *  `granted_by_user_id` against the already-fetched user list for display,
 *  never a second derived name field. */
export interface ProjectAccessGrantRead {
  id: Id;
  project_id: Id;
  user_id: Id;
  project_role: ProjectAccessRole;
  granted_by_user_id: Id;
  created_at: string;
}

/** `POST /projects/{id}/access` body (`extra="forbid"` server-side). */
export interface ProjectAccessGrantCreateRequest {
  user_id: Id;
  project_role: ProjectAccessRole;
}

/** The 409 the server returns for a second active grant on the same
 *  `(project, user)` — the caller must revoke the existing one first. */
export const ACTIVE_GRANT_EXISTS_CODE = 'ACTIVE_GRANT_EXISTS';

/** One row of `GET /users/me/manageable-projects` (P10-F02): every project
 *  where the CALLER's own `effective_project_access` resolves to `"admin"` —
 *  exactly the set they could grant/revoke on. No surface-permission gate on
 *  that endpoint (works for an Engineer/Executive Viewer/Auditor manager-
 *  delegate who holds none), so this type deliberately carries only enough to
 *  identify a project for the picker — never `ProjectListItem`/`ProjectRead`,
 *  which carry the encrypted financial fields. */
export interface ManageableProjectRead {
  id: Id;
  name: string;
  hub_id: Id;
}

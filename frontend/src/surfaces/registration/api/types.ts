// PLACEHOLDER — hand-authored mirror of backend/schemas/project.py. P3's OpenAPI
// schema is not generated into this repo yet (see src/lib/api/README.md and the
// P4-T01 docs/MEMORY.md carry-forward note). P3-T07's contract test is the
// backstop for drift between these shapes and the real schema.
//
// Terminology note (P4-T06): "hard gate" here means the Project Registration
// required-fields gate (`docs/PROJECT_AND_STACK.md` §2: "Hard gates enforce
// required fields before a project can leave draft status" —
// `backend/services/project_hard_gates.py`). This is a DIFFERENT concept from
// the Prioritization Matrix's "hard gate → force P1" band override
// (`docs/DOMAIN_RULES.md` "Hard gates (override band, force P1)",
// `frontend/src/surfaces/matrix/components/hard-gate-badge.tsx`,
// `@/types/enums`'s `HardGateReason`). Do not conflate the two — this module
// never imports `HardGateReason`.

import type { ProjectCategory, ProjectPriority, ProjectStatus, ProjectType } from '@/types/enums';
import type { Id } from '@/types/common';

/** `POST /projects` request body (→ `backend/schemas/project.py::ProjectCreateRequest`).
 *  Only `name` and `hub_id` are required — every other field may be filled in
 *  later while the project sits in `Draft`. `extra="forbid"` server-side. */
export interface ProjectCreateRequest {
  name: string;
  external_code?: string | null;
  hub_id: Id;
  leader_engineer_id?: Id | null;
  category?: ProjectCategory | null;
  type?: ProjectType | null;
  priority?: ProjectPriority | null;
  actual_start_week?: number | null;
  delay_weeks?: number;
  reg_year?: number | null;
  carry_over?: boolean;
  comments?: string | null;
  /** Commercially sensitive — encrypted at rest server-side. Never log this
   *  value (CLAUDE.md). */
  customer_name?: string | null;
  /** Commercially sensitive — encrypted at rest server-side. Never log this
   *  value (CLAUDE.md). */
  tcogs_eur?: number | null;
  /** Commercially sensitive — encrypted at rest server-side. Never log this
   *  value (CLAUDE.md). */
  selling_price_eur?: number | null;
  /** Commercially sensitive — encrypted at rest server-side. Never log this
   *  value (CLAUDE.md). */
  gross_margin_pct?: number | null;
  capex_keur?: number | null;
  rm_savings_keur?: number | null;
}

/** `PATCH /projects/{id}` request body (→ `ProjectUpdateRequest`). Partial —
 *  every field optional, including `hub_id` (unlike `ProjectCreateRequest`,
 *  where it is required to create the row in the first place). A key present
 *  in the JSON body is treated as an explicit set server-side (Pydantic
 *  `exclude_unset`). Deliberately excludes `frozen` (Gantt-only) and `status`
 *  (leaving Draft goes through `POST /projects/{id}/submit`, which runs the
 *  hard-gate check — setting `status` away from Draft here 400s).
 *  `project-form.tsx` always sends every field on save (a full-form
 *  overwrite, not a sparse diff), so in practice this surface's own PATCH
 *  bodies always include `hub_id` too — the type is optional to match the
 *  backend schema precisely, not because this surface omits it. */
export type ProjectUpdateRequest = Partial<ProjectCreateRequest>;

/** `GET /projects` / `GET /projects/{id}` (→ `ProjectRead` / `ProjectListItem`,
 *  currently identical shapes). */
export interface ProjectRead {
  id: Id;
  name: string;
  external_code: string | null;
  hub_id: Id;
  leader_engineer_id: Id | null;
  category: ProjectCategory | null;
  type: ProjectType | null;
  priority: ProjectPriority | null;
  status: ProjectStatus;
  frozen: boolean;
  actual_start_week: number | null;
  delay_weeks: number;
  reg_year: number | null;
  carry_over: boolean;
  comments: string | null;
  customer_name: string | null;
  tcogs_eur: number | null;
  selling_price_eur: number | null;
  gross_margin_pct: number | null;
  capex_keur: number | null;
  rm_savings_keur: number | null;
  created_at: string;
  updated_at: string;
}

export type ProjectListItem = ProjectRead;

/** `GET /projects/{id}/hard-gate-status` (→ `HardGateStatus`). The single
 *  source of truth for whether a Draft project may leave Draft — the frontend
 *  never recomputes this list itself (Invariant I9's spirit: a gating decision
 *  is exactly the kind of thing that must not have two implementations). See
 *  `components/required-fields-hint.ts` for the client-side *responsiveness*
 *  mirror (asterisks on the form) — that mirror is explicitly not authoritative. */
export interface HardGateStatus {
  can_leave_draft: boolean;
  missing_fields: string[];
}

/** `POST /projects/{id}/submit` request body (→ `ProjectSubmitRequest`).
 *  `target_status` must be one of the four schedulable statuses — never
 *  Draft/Commercialized/On Hold. */
export interface ProjectSubmitRequest {
  target_status: ProjectStatus;
}

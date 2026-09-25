// PLACEHOLDER — hand-authored mirror of `backend/schemas/engineer.py`,
// `backend/schemas/chamber.py`, and the `ScheduleRunSummary`/`GreedyRecalcResponse`
// slice of `backend/schemas/schedule_run.py`. Hand-authored because P3's OpenAPI
// schema is not generated into this repo yet (see src/lib/api/README.md and the
// P4-T01 docs/MEMORY.md carry-forward note). P3-T07's contract test must catch
// drift between these shapes and the real schema.
//
// Scope note (P4-T07): this is the CRUD surface for Engineer/Chamber resource
// *configuration*. It is deliberately distinct from
// `surfaces/registration/api/engineers-api.ts::EngineerOption`, a minimal
// read-only id/name/hub_id lookup for the Project Registration leader picker —
// see that file's own module docstring for why the two are not merged.

import type { EngineerAllowedCategory, LabRegion, ScheduleRunStatus, SolverType } from '@/types/enums';
import type { Id } from '@/types/common';

/**
 * `GET /engineers` / `GET /engineers/{id}` row (`backend/schemas/engineer.py::EngineerRead`).
 *
 * `fte` is stored and shown here verbatim — per ADR 0002 (`docs/DOMAIN_RULES.md`
 * known defect #1 / `docs/OPEN_QUESTIONS.md` #2) it is a REPORTING field only:
 * it feeds the RPD Capacity surface's `design_capacity_weeks` figure but does
 * NOT gate the greedy/CP-SAT scheduler's booking rules in v1. Never implied
 * here to affect scheduling.
 */
export interface EngineerRead {
  id: Id;
  name: string;
  hub_id: Id;
  fte: number;
  allowed_categories: EngineerAllowedCategory[];
  user_id: Id | null;
  created_at: string;
  updated_at: string;
}

/** `POST /engineers` body (`EngineerCreateRequest`). `fte` defaults server-side
 *  to `1.0` if omitted; `gt=0`, no upper bound (see backend schema's own note —
 *  not DB-constrained to `<= 1` in case a future client answer allows
 *  multi-role `fte > 1.0`). */
export interface EngineerCreateRequest {
  name: string;
  hub_id: Id;
  fte?: number;
  allowed_categories?: EngineerAllowedCategory[];
  user_id?: Id | null;
}

/** `PATCH /engineers/{id}` body — every field optional (partial update). */
export type EngineerUpdateRequest = Partial<EngineerCreateRequest>;

/**
 * `GET /chambers` / `GET /chambers/{id}` row (`backend/schemas/chamber.py::ChamberRead`).
 *
 * Only `max_concurrent` gates lab-step booking (Invariant I2 / ADR 0003,
 * `docs/OPEN_QUESTIONS.md` #3) — `efficiency` and `weeks_per_chamber` are
 * stored, reportable fields surfaced here and on RPD Capacity, but do NOT
 * constrain the scheduler. Never implied here to affect booking.
 */
export interface ChamberRead {
  id: Id;
  code: string;
  lab_region: LabRegion;
  max_concurrent: number;
  platforms: number;
  efficiency: number;
  weeks_per_chamber: number;
  allowed_stages: string[];
  created_at: string;
  updated_at: string;
}

/** `POST /chambers` body (`ChamberCreateRequest`). `allowed_stages` must be
 *  lab-kind step ids only — `backend/api/routers/chambers.py::_validate_allowed_stages`
 *  422s otherwise; this is the authority, not this surface's picker. */
export interface ChamberCreateRequest {
  code: string;
  lab_region: LabRegion;
  max_concurrent: number;
  platforms?: number;
  efficiency?: number;
  weeks_per_chamber?: number;
  allowed_stages?: string[];
}

/** `PATCH /chambers/{id}` body — every field optional (partial update). */
export type ChamberUpdateRequest = Partial<ChamberCreateRequest>;

/** `GET /schedule-runs/active` (→ `ScheduleRunSummary`) — provenance display
 *  only for the Apply Logic panel; the run's own fields, never recomputed. */
export interface ScheduleRunSummary {
  id: Id;
  version: number;
  solver_type: SolverType;
  status: ScheduleRunStatus;
  is_active: boolean;
  horizon_weeks: number;
  current_week: number;
  trigger_reason: string | null;
  created_at: string;
}

/**
 * `POST /schedule-runs/greedy-recalc` response (`GreedyRecalcResponse`) — see
 * `components/apply-logic-panel.tsx`'s module docstring for why this endpoint,
 * not a bespoke "apply logic" endpoint, is what "Apply Logic" calls. Every
 * count here is the backend's own aggregate over `schedule_output.project_outcomes`
 * — never recomputed client-side (Invariant I9).
 */
export interface GreedyRecalcResponse {
  schedule_run: ScheduleRunSummary;
  project_count: number;
  left_out_count: number;
  within_year_count: number;
  spillover_count: number;
}

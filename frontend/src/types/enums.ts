// PLACEHOLDER — replace with OpenAPI-generated types in P3 (P3-T07 / P4 surface work).
// Hand-authored because P3 (the API layer + OpenAPI schema) does not exist yet.
// Enum VALUES are copied verbatim from backend/models/enums.py (pinned to docs/DOMAIN_RULES.md).
// Tracked as debt in the P4-T01 docs/MEMORY.md entry.

export const HUB_NAMES = [
  'R&D-Greece',
  'R&D-India',
  'PD-India',
  'PD-Romania',
  'OEM-HCK',
  'OEM-Seitek',
] as const;
export type HubName = (typeof HUB_NAMES)[number];

export const LAB_REGIONS = ['Greece', 'India', 'Romania'] as const;
export type LabRegion = (typeof LAB_REGIONS)[number];

// P9 (ADR 0007): non-OEM hubs use A+/A/B/C; OEM hubs (`Hub.is_oem`) use the three
// OEM categories. The full list is the `ProjectCategory` enum; the two subsets are
// what Project Registration offers per hub (`GET /reference/categories?hub_id=`,
// with these as the offline fallback — see `lib/api/reference.ts`).
export const NON_OEM_CATEGORIES = ['A+', 'A', 'B', 'C'] as const;
export const OEM_CATEGORIES = ['A-OEM', 'B-OEM', 'C-OEM'] as const;
export const PROJECT_CATEGORIES = [...NON_OEM_CATEGORIES, ...OEM_CATEGORIES] as const;
export type ProjectCategory = (typeof PROJECT_CATEGORIES)[number];

// Engineer eligibility superset — includes "OEM" (CAT_NOT_ALLOWED rule) and, since
// ADR 0007, the three explicit OEM project categories. A project is never "OEM".
export const ENGINEER_ALLOWED_CATEGORIES = [
  'A+',
  'A',
  'B',
  'C',
  'OEM',
  'A-OEM',
  'B-OEM',
  'C-OEM',
] as const;
export type EngineerAllowedCategory = (typeof ENGINEER_ALLOWED_CATEGORIES)[number];

// The two workflow templates (DOMAIN_RULES.md "Workflow templates", ADR 0007). A
// project's workflow is a function of its hub (`Hub.is_oem`).
export const WORKFLOW_IDS = ['PDD', 'OEM'] as const;
export type WorkflowId = (typeof WORKFLOW_IDS)[number];

export const PROJECT_PRIORITIES = ['P1', 'P2', 'P3', 'P4', 'Q'] as const;
export type ProjectPriority = (typeof PROJECT_PRIORITIES)[number];

/**
 * Every project status the API can carry (the wire enum, `backend/models/enums.py`).
 * `ProjectStatus` is derived from this list and stays complete: data may still hold
 * "In Buyoff" or "Draft" (the scheduler's status order includes In Buyoff; a new
 * project is created as Draft). Use it for typing and rendering, never as a list
 * of choices offered to the user — that is `UI_PROJECT_STATUSES`.
 */
export const ALL_PROJECT_STATUSES = [
  'In Buyoff',
  'Under Industrialization',
  'In Development',
  'In Queue',
  'Commercialized',
  'On Hold',
  'Draft',
  // P9 (OPEN_QUESTIONS #22): excluded from scheduling like Commercialized / On Hold / Draft.
  'Cancelled',
] as const;
export type ProjectStatus = (typeof ALL_PROJECT_STATUSES)[number];

/** Statuses kept in the data but never offered in the UI (P23-T01, owner request). */
export const UI_HIDDEN_PROJECT_STATUSES: readonly ProjectStatus[] = ['In Buyoff', 'Draft'];

/**
 * The statuses OFFERED in the UI (P23-T01): every filter, chip, select and legend
 * lists these. "In Buyoff" and "Draft" are left out (no project carries them); a
 * project that still has one renders its badge normally (`ProjectStatusBadge`).
 */
export const UI_PROJECT_STATUSES: readonly ProjectStatus[] = [
  'Under Industrialization',
  'In Development',
  'In Queue',
  'Commercialized',
  'On Hold',
  'Cancelled',
];

/**
 * @deprecated-name Kept for existing importers (the Matrix STATUS chips, P23-T01):
 * it is the UI list, `UI_PROJECT_STATUSES`. For the full wire set use
 * `ALL_PROJECT_STATUSES`.
 */
export const PROJECT_STATUSES: readonly ProjectStatus[] = UI_PROJECT_STATUSES;

// The four statuses the scheduler orders on (DOMAIN_RULES.md "Scheduling order").
// Scheduler semantics, not a UI list: keep In Buyoff here.
export const SCHEDULABLE_STATUSES = [
  'In Buyoff',
  'Under Industrialization',
  'In Development',
  'In Queue',
] as const;
export type SchedulableStatus = (typeof SCHEDULABLE_STATUSES)[number];

/** The schedulable statuses offered in the UI (P23-T01): leave-Draft target and
 *  the what-if hypothetical project status. In Buyoff is not offered. */
export const UI_SCHEDULABLE_STATUSES: readonly SchedulableStatus[] = [
  'Under Industrialization',
  'In Development',
  'In Queue',
];

export const PROJECT_TYPES = ['NM', 'CO', 'RC', 'NO', 'IMP', 'AC', 'SER'] as const;
export type ProjectType = (typeof PROJECT_TYPES)[number];

/**
 * The ONE display-label source for project types (filters, Matrix, Gantt,
 * Dashboard charts, Registration select). Mirrors `GET /reference/project-types`
 * (backend `domain_constants.PROJECT_TYPE_LABELS`, API_CONTRACT_P29 §1.2).
 * P29-T04 (ADR 0038 amendment 2026-10-22): the client's "Business Continuity"
 * (`BC`) projects are `RC`, relabelled "Regulatory / Business Compliance". The
 * wire value stays `RC`; there is no `BC` type.
 */
export const PROJECT_TYPE_LABELS: Record<ProjectType, string> = {
  NM: 'New Model',
  CO: 'Cost Optimization',
  RC: 'Regulatory / Business Compliance',
  NO: 'New Option',
  IMP: 'Improvement',
  // P30 (ADR 0041 §4, API_CONTRACT_P30 §1): no scoring tag (ADR 0038 §6).
  AC: 'Alternative Component',
  SER: 'Service',
};

/**
 * P27 (ADR 0038, `docs/API_CONTRACT_P27.md` §1): Registration "project nature"
 * tags, multi-select, in the server's canonical order (`backend/models/enums.py`
 * `ScoringTag`). Independent of the single `type` above. Ticking one makes the
 * server pre-fill its mapped dimension's score with 5; which dimension that is
 * comes from the served `tag_dimension_keys`, never from a client-side map.
 */
export const SCORING_TAGS = [
  'new_customer',
  'strategic_project',
  'new_options',
  'regulatory_compliance',
  'new_models',
  'improvement',
] as const;
export type ScoringTag = (typeof SCORING_TAGS)[number];

export const SCORING_TAG_LABELS: Record<ScoringTag, string> = {
  new_customer: 'New Customer',
  strategic_project: 'Strategic Project',
  new_options: 'New Options',
  regulatory_compliance: 'Regulatory / Business Compliance',
  new_models: 'New Models',
  improvement: 'Improvement',
};

// ADR 0007: `design` books the project leader, `lab` books a chamber, `elapsed`
// books nothing but occupies calendar weeks on the critical path.
export const WORKFLOW_STEP_KINDS = ['design', 'lab', 'elapsed'] as const;
export type WorkflowStepKind = (typeof WORKFLOW_STEP_KINDS)[number];

// Per-stage progress status (DOMAIN_RULES.md "Per-stage progress capture", ADR 0006).
export const WORKFLOW_STEP_STATUSES = ['Not Started', 'In Progress', 'Blocked', 'Done'] as const;
export type WorkflowStepStatus = (typeof WORKFLOW_STEP_STATUSES)[number];

/**
 * Display labels for the stage statuses (ADR 0017, 2026-10-09): the wire value
 * `Blocked` is SHOWN as "On Hold". The stored and API values are unchanged.
 * A stage on hold is not the project status `On Hold` (which takes the whole
 * project out of the plan): the project stays in the plan, waiting at a stage.
 */
export const WORKFLOW_STEP_STATUS_LABELS: Record<WorkflowStepStatus, string> = {
  'Not Started': 'Not Started',
  'In Progress': 'In Progress',
  Blocked: 'On Hold',
  Done: 'Done',
};

/** The label for a stage status (ADR 0017). Never use it to build an API value. */
export function stageStatusLabel(status: WorkflowStepStatus): string {
  return WORKFLOW_STEP_STATUS_LABELS[status];
}

// Capacity booking status (ADR 0016, P11 contract §4) — server-derived from
// booked % (full ≥ 100, near_full 85–<100, else available). Never re-derived.
export const BOOKING_STATUSES = ['available', 'near_full', 'full'] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export const HARD_GATE_REASONS = [
  'Regulatory deadline within 6 months',
  'Customer certification at risk (Coke/Pepsi)',
  'Active safety non-compliance',
] as const;
export type HardGateReason = (typeof HARD_GATE_REASONS)[number];

export const CURRENCY_CODES = ['EUR', 'USD', 'INR'] as const;
export type CurrencyCode = (typeof CURRENCY_CODES)[number];

export const SOLVER_TYPES = ['greedy', 'cp_sat'] as const;
export type SolverType = (typeof SOLVER_TYPES)[number];

export const SCHEDULE_RUN_STATUSES = [
  'queued',
  'running',
  'completed',
  'failed',
  'cancelled',
] as const;
export type ScheduleRunStatus = (typeof SCHEDULE_RUN_STATUSES)[number];

// The five named scheduling outcomes (DOMAIN_RULES.md booking rules + invariants I1/I2/I5).
export const SCHEDULE_OUTCOME_FLAGS = [
  'ENG_CONFLICT',
  'OVERLAP',
  'LEFT_OUT',
  'CAT_NOT_ALLOWED',
  'SPILLOVER',
] as const;
export type ScheduleOutcomeFlag = (typeof SCHEDULE_OUTCOME_FLAGS)[number];

export const ROLE_NAMES = [
  'Portfolio Manager',
  'Hub Planner',
  'Engineer',
  'Executive Viewer',
  'Auditor',
  'Admin',
  // ADR 0010: read + write on every surface; sole grantor of Admin / Super Admin.
  'Super Admin',
] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

// `backend/core/rbac.py::Surface` values — the keys of `GET /me`'s `permissions`
// table (P9 contract §1). Every nav item and every route guard names one of these.
export const SURFACE_KEYS = [
  'dashboard',
  'capacity',
  'matrix',
  'gantt',
  'project_workspace',
  'project_registration',
  'capacity_planning',
  'workflow_settings',
  'audit_log',
  'user_role_admin',
] as const;
export type SurfaceKey = (typeof SURFACE_KEYS)[number];

// Prioritization bands (DOMAIN_RULES.md "Bands"). "Q" is the queue/unscored pseudo-band
// used on the scheduling sort; band assignment itself only produces P1..P4.
export const PRIORITY_BANDS = ['P1', 'P2', 'P3', 'P4'] as const;
export type PriorityBand = (typeof PRIORITY_BANDS)[number];

// In-app notification triggers (P5-T06 `backend/models/enums.py::NotificationReason`,
// `docs/PROJECT_AND_STACK.md` §2's cross-cutting "Notifications" line): a
// *regression* detected by diffing a newly-activated schedule run's per-project
// outcome against the immediately prior active run for that project — never a
// description of the live schedule's current state in isolation.
// `stage_blocked` (P9-T03 follow-up, backend migration 8e2d4b6a1c90): raised by a
// progress edit that sets a stage to Blocked — not by a schedule-run diff, so
// its `schedule_run_id` is null.
export const NOTIFICATION_REASONS = ['delay_introduced', 'project_left_out', 'conflict_raised', 'stage_blocked'] as const;
export type NotificationReason = (typeof NOTIFICATION_REASONS)[number];

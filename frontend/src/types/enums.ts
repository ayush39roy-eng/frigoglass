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
  'OEM-Seltek',
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

export const PROJECT_STATUSES = [
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
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];

// The four statuses the scheduler orders on (DOMAIN_RULES.md "Scheduling order").
export const SCHEDULABLE_STATUSES = [
  'In Buyoff',
  'Under Industrialization',
  'In Development',
  'In Queue',
] as const;

export const PROJECT_TYPES = ['NM', 'CO', 'RC', 'NO', 'IMP'] as const;
export type ProjectType = (typeof PROJECT_TYPES)[number];

export const PROJECT_TYPE_LABELS: Record<ProjectType, string> = {
  NM: 'New Model',
  CO: 'Cost Optimization',
  RC: 'Regulatory / Compliance',
  NO: 'New Option',
  IMP: 'Improvement',
};

// ADR 0007: `design` books the project leader, `lab` books a chamber, `elapsed`
// books nothing but occupies calendar weeks on the critical path.
export const WORKFLOW_STEP_KINDS = ['design', 'lab', 'elapsed'] as const;
export type WorkflowStepKind = (typeof WORKFLOW_STEP_KINDS)[number];

// Per-stage progress status (DOMAIN_RULES.md "Per-stage progress capture", ADR 0006).
export const WORKFLOW_STEP_STATUSES = ['Not Started', 'In Progress', 'Blocked', 'Done'] as const;
export type WorkflowStepStatus = (typeof WORKFLOW_STEP_STATUSES)[number];

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

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

export const PROJECT_CATEGORIES = ['A+', 'A', 'B', 'C'] as const;
export type ProjectCategory = (typeof PROJECT_CATEGORIES)[number];

// Engineer eligibility superset — includes "OEM" (CAT_NOT_ALLOWED rule). A project is never "OEM".
export const ENGINEER_ALLOWED_CATEGORIES = ['A+', 'A', 'B', 'C', 'OEM'] as const;
export type EngineerAllowedCategory = (typeof ENGINEER_ALLOWED_CATEGORIES)[number];

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

export const WORKFLOW_STEP_KINDS = ['design', 'lab'] as const;
export type WorkflowStepKind = (typeof WORKFLOW_STEP_KINDS)[number];

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
] as const;
export type RoleName = (typeof ROLE_NAMES)[number];

// Prioritization bands (DOMAIN_RULES.md "Bands"). "Q" is the queue/unscored pseudo-band
// used on the scheduling sort; band assignment itself only produces P1..P4.
export const PRIORITY_BANDS = ['P1', 'P2', 'P3', 'P4'] as const;
export type PriorityBand = (typeof PRIORITY_BANDS)[number];

// In-app notification triggers (P5-T06 `backend/models/enums.py::NotificationReason`,
// `docs/PROJECT_AND_STACK.md` §2's cross-cutting "Notifications" line): a
// *regression* detected by diffing a newly-activated schedule run's per-project
// outcome against the immediately prior active run for that project — never a
// description of the live schedule's current state in isolation.
export const NOTIFICATION_REASONS = ['delay_introduced', 'project_left_out', 'conflict_raised'] as const;
export type NotificationReason = (typeof NOTIFICATION_REASONS)[number];

// PLACEHOLDER (P9 contract §7) — hand-authored mirror of the Project Workspace
// endpoints (`GET /projects/{id}/workspace`, stage PATCH, recalculate, files,
// comments, activity, mention search). The backend is built concurrently
// (P9-T03); reconciled against the regenerated OpenAPI in the P9 gate (P3-T07
// contract test). Same convention as every per-surface `api/types.ts`.

import type { HardGateReason, HubName, ProjectPriority, WorkflowStepKind, WorkflowStepStatus } from '@/types/enums';
import type { Id } from '@/types/common';
import type { ProjectRead } from '@/surfaces/registration/api/types';

/** I13: a pure function of the active run's stored outcome — never derived here. */
export type WorkspaceHealth = 'on_track' | 'at_risk' | 'off_track' | 'left_out' | 'blocked' | 'unscheduled';

export interface WorkspaceProject extends ProjectRead {
  hub: HubName;
  /** `null` while OQ#8 withholds named-engineer data. */
  leader_engineer_name: string | null;
}

export interface WorkspaceSchedule {
  has_active_run: boolean;
  run_version: number | null;
  expected_end_week: number | null;
  projected_end_week: number | null;
  unconstrained_end_week: number | null;
  slip_weeks: number | null;
  within_year: boolean | null;
  left_out: boolean;
  schedule_stale: boolean;
}

export interface WorkspaceStage {
  step_id: string;
  code: string;
  name: string;
  kind: WorkflowStepKind;
  sequence_order: number;
  predecessor_ids: string[];
  duration_weeks: number;
  skipped: boolean;
  planned_start_week: number | null;
  planned_end_week: number | null;
  actual_start_week: number | null;
  actual_end_week: number | null;
  status: WorkflowStepStatus;
  percent_complete: number;
  /** Server-derived remaining weeks (DOMAIN_RULES "Derived remaining duration"). */
  remaining_weeks: number | null;
  remaining_weeks_override: number | null;
  blocked_reason: string | null;
  assigned_engineer_name: string | null;
  assigned_chamber_code: string | null;
  overrun_weeks: number | null;
}

export interface WorkspacePriorityScore {
  strategic_project: number;
  new_customer: number;
  new_options: number;
  regulatory_compliance: number;
  quality_improvements: number;
  rm_savings: number;
  total_rm_savings: number;
  gross_margins: number;
  profitability: number;
  annual_volume: number;
  three_year_volume: number;
  new_models: number;
  capex_investment: number;
  hard_gates: HardGateReason[];
  /** P9-R03: nullable per `backend/schemas/workspace.py` — null until the
   *  score has been computed (e.g. not every dimension entered yet). */
  weighted_score: number | null;
  normalized_pct: number | null;
  suggested_band: ProjectPriority | null;
}

export const FILE_CATEGORIES = [
  'Drawing',
  'Test Report',
  'Certification',
  'Costing',
  'Supplier Doc',
  'Photo',
  'Other',
] as const;
export type FileCategory = (typeof FILE_CATEGORIES)[number];

export interface FileRead {
  id: Id;
  display_name: string;
  category: FileCategory;
  description: string | null;
  version: number;
  size_bytes: number;
  content_type: string;
  uploaded_by_name: string | null;
  created_at: string;
}

export interface CommentRead {
  id: Id;
  /** Rendered with the React-element-only Markdown subset (`lib/markdown.tsx`).
   *  The server's `body_html_sanitized` was removed in P9-R02 (security S-02). */
  body_md: string;
  author_name: string | null;
  author_user_id: Id;
  created_at: string;
  edited_at: string | null;
  /** Author and < 15 min since creation — decided by the server. */
  can_edit: boolean;
  mentioned_user_ids: Id[];
}

export type ActivityItem =
  | { kind: 'comment'; comment: CommentRead }
  | {
      kind: 'event';
      id: Id;
      occurred_at: string;
      actor_name: string | null;
      summary: string;
      audit_entry_id: Id;
    };

export interface WorkspaceResponse {
  project: WorkspaceProject;
  health: WorkspaceHealth;
  schedule: WorkspaceSchedule;
  /** Duration-weighted (I12), server-computed. `null` when the stages' total
   *  duration is 0 (nothing to weight) — shown as "No progress recorded", never 0%. */
  progress_pct: number | null;
  stages: WorkspaceStage[];
  priority_score: WorkspacePriorityScore | null;
  files: FileRead[];
  /** Latest 50, newest first. */
  activity: ActivityItem[];
}

export interface StagePatchRequest {
  status?: WorkflowStepStatus;
  percent_complete?: number;
  actual_start_week?: number | null;
  actual_end_week?: number | null;
  remaining_weeks_override?: number | null;
  blocked_reason?: string | null;
}

export interface RecalculateResponse {
  schedule_run_id: Id;
  task_id: string;
}

export interface FileUploadInput {
  file: File;
  display_name: string;
  category: FileCategory;
  description?: string | undefined;
}

export interface FilePatchRequest {
  display_name?: string;
  category?: FileCategory;
  description?: string | null;
}

export interface MentionCandidate {
  user_id: Id;
  display: string;
}

/** Server cap on a comment body (`CommentCreateRequest.body_md`, P9-R02). */
export const COMMENT_MAX_CHARS = 10_000;

/** 403 code when a comment is edited after the 15-minute window. */
export const EDIT_LOCKED_CODE = 'EDIT_LOCKED';

// --- Ask the agent (ADR 0014, P10-T02/T03) ---
// Hand-authored mirror of `backend/schemas/ask_agent.py`. Stateless: one
// question in, one plain-text answer out, no conversation state.

/** `POST /projects/{id}/ask-agent` body. Server caps `question` at 2000 chars. */
export const ASK_AGENT_QUESTION_MAX_CHARS = 2000;

export interface AskAgentRequest {
  question: string;
}

export interface AskAgentResponse {
  /** Plain prose, never Markdown/HTML (ADR 0014) — rendered as plain text,
   *  never `dangerouslySetInnerHTML`. */
  answer: string;
}

/** The 503 body shape is `{"error": "AGENT_UNAVAILABLE"}` — NOT the usual
 *  `{"detail","code"}` envelope (`api/routers/ask_agent.py` uses a raw
 *  `JSONResponse`) — so callers detect this by `status === 503` alone, not
 *  by `ApiError.code`. Kept as a named constant so a comparison never drifts
 *  into a magic number. */
export const ASK_AGENT_UNAVAILABLE_STATUS = 503;

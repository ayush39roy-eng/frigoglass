// PLACEHOLDER (P9 contract §3) — hand-authored mirror of `GET /workflow-settings`
// and its four `PUT`s (ADRs 0007 / 0008 / 0009). Built concurrently with the
// backend (P9-T03); reconciled against the regenerated OpenAPI in the P9 gate
// (P3-T07 contract test). Same convention as every per-surface `api/types.ts`.

import type {
  HubName,
  LabRegion,
  ProjectCategory,
  WorkflowId,
  WorkflowStepKind,
} from '@/types/enums';
import type { Id } from '@/types/common';

export interface WorkflowStepSetting {
  step_id: string;
  code: string;
  name: string;
  kind: WorkflowStepKind;
  /** Display / walk order — NOT a dependency (ADR 0009). */
  sequence_order: number;
  /** Steps of the same workflow this step starts after. Empty only on the first. */
  predecessor_ids: string[];
}

export interface WorkflowSetting {
  id: WorkflowId;
  name: string;
  steps: WorkflowStepSetting[];
}

/** One of the 98 lead-time rows (`docs/CLIENT_FORMULAS.md` §1). `weeks` may be 0 = skipped. */
export interface LeadTimeSetting {
  workflow_id: WorkflowId;
  category: ProjectCategory;
  step_id: string;
  weeks: number;
}

export interface HubCalendarSetting {
  hub_id: Id;
  hub: HubName;
  weekdays_per_week: number;
  national_holiday_days: number;
  medical_leave_days: number;
  casual_leave_days: number;
  annual_leave_days: number;
  weeks_in_year: number;
  /** Derived server-side (ADR 0008) — read-only here. */
  working_weeks_per_engineer: number;
}

export interface ChamberSetting {
  chamber_id: Id;
  code: string;
  lab_region: LabRegion;
  platforms: number;
  efficiency: number;
  maintenance_weeks: number;
  breakdown_weeks: number;
  calibration_weeks: number;
  /** Derived server-side (ADR 0008) — read-only here. */
  working_weeks_per_chamber: number;
  /** Derived server-side (ADR 0008) — read-only here. */
  efficient_lab_weeks: number;
}

/** `GET /workflow-settings` — also the body every successful `PUT` returns. */
export interface WorkflowSettings {
  workflows: WorkflowSetting[];
  lead_times: LeadTimeSetting[];
  hub_calendars: HubCalendarSetting[];
  chambers: ChamberSetting[];
  current_week: number;
  horizon_weeks: number;
  within_year_week: number;
  updated_at: string;
  updated_by: string | null;
}

/** `PUT /workflow-settings/steps/{workflow_id}` — all 14 steps. */
export interface StepsUpdateRequest {
  steps: { step_id: string; kind: WorkflowStepKind; predecessor_ids: string[] }[];
}

/** `PUT /workflow-settings/lead-times` — partial allowed, `weeks ≥ 0`. */
export interface LeadTimesUpdateRequest {
  lead_times: LeadTimeSetting[];
}

/** `PUT /workflow-settings/hub-calendars/{hub_id}` — the five editable fields. */
export interface HubCalendarUpdateRequest {
  weekdays_per_week: number;
  national_holiday_days: number;
  medical_leave_days: number;
  casual_leave_days: number;
  annual_leave_days: number;
}

/** `PUT /workflow-settings/chambers/{chamber_id}` — any subset. */
export interface ChamberSettingUpdateRequest {
  platforms?: number;
  efficiency?: number;
  maintenance_weeks?: number;
  breakdown_weeks?: number;
  calibration_weeks?: number;
}

/** A successful PUT: the full `GET` payload plus the `X-Schedule-Stale-Count` header. */
export interface WorkflowSettingsSaveResult {
  settings: WorkflowSettings;
  /** Projects now marked `schedule_stale` — from the response header, verbatim. */
  staleCount: number;
}

/** The 422 codes the steps endpoint can return (`{code, detail}` envelope). */
export const STEP_VALIDATION_CODES = ['CYCLE', 'SELF_REFERENCE', 'BAD_PREDECESSOR', 'EMPTY_PREDECESSORS'] as const;

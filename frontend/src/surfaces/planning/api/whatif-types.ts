// Hand-authored mirror of `backend/schemas/whatif.py` (P18-T02, ADR 0031,
// docs/API_CONTRACT_P18.md section 9). Kept honest by
// `backend/tests/test_openapi_frontend_contract.py` (every interface below is in
// its CONTRACT_TABLE). Every figure on the What-if surface is one of these fields,
// shown as served: the browser never computes booked %, counts, deltas or
// requirements (Invariant I9 / I19).

import type {
  BookingStatus,
  ProjectCategory,
  ProjectPriority,
  ProjectType,
  WorkflowId,
} from '@/types/enums';

export type WhatIfHub = 'R&D-Greece' | 'R&D-India' | 'PD-India' | 'PD-Romania' | 'OEM-HCK' | 'OEM-Seitek';
export type WhatIfRegion = 'Greece' | 'India' | 'Romania';
/** Wire mirror of `SchedulableStatusLiteral` (backend default "In Queue"). The UI
 *  offers only `WHATIF_STATUSES` (P23-T01, no In Buyoff); the type stays complete. */
export type WhatIfStatus = 'In Buyoff' | 'Under Industrialization' | 'In Development' | 'In Queue';
export type WhatIfBasis = 'year' | 'remaining';
export type WhatIfTarget = 'all_new_within_year' | 'no_existing_slips';
export type WhatIfOutcome = 'within_year' | 'spillover' | 'left_out' | 'blocked' | 'excluded' | 'data_error';

// --- scenario (request) ---------------------------------------------------------------

export interface AddProjectIn {
  hub: WhatIfHub;
  category: ProjectCategory;
  count?: number;
  project_type?: ProjectType | null;
  status?: WhatIfStatus;
  priority?: ProjectPriority | null;
  score?: number | null;
  workflow_id?: WorkflowId | null;
  certification_testing_required?: boolean;
}

export interface AddEngineerIn {
  hub: WhatIfHub;
  fte?: number;
  count?: number;
  allowed_categories?: ProjectCategory[] | null;
}

export interface RemoveEngineerCountIn {
  hub: WhatIfHub;
  count?: number;
}

export interface AddChamberIn {
  lab_region: WhatIfRegion;
  count?: number;
  platforms?: number | null;
  efficiency?: number | null;
  maintenance_weeks?: number | null;
  breakdown_weeks?: number | null;
  calibration_weeks?: number | null;
  allowed_stages?: string[] | null;
}

export interface ChamberDowntimeIn {
  chamber_id: string;
  maintenance_weeks?: number | null;
  breakdown_weeks?: number | null;
  calibration_weeks?: number | null;
}

export interface PriorityOverrideIn {
  project_id: string;
  priority: ProjectPriority;
}

export interface ChatScenario {
  add_projects?: AddProjectIn[];
  add_engineers?: AddEngineerIn[];
  remove_engineer_counts?: RemoveEngineerCountIn[];
  add_chambers?: AddChamberIn[];
  chamber_downtime?: ChamberDowntimeIn[];
}

export interface ScenarioRequest extends ChatScenario {
  remove_engineers?: string[];
  priority_overrides?: PriorityOverrideIn[];
}

export interface EstimateRequest {
  scenario?: ScenarioRequest;
  basis?: WhatIfBasis;
  designer_fte?: number;
}

export interface SimulateRequest {
  scenario?: ScenarioRequest;
}

export interface SolveRequest {
  scenario?: ScenarioRequest;
  target?: WhatIfTarget;
  designer_fte?: number;
  max_runs?: number;
  max_units_per_dimension?: number;
}

export interface AskRequest {
  question: string;
  prior_scenario?: ChatScenario | null;
}

// --- responses --------------------------------------------------------------------------

export interface ScopeInfo {
  all_hubs: boolean;
  hubs: string[];
  lab_regions: string[];
}

export interface HubDesignRequirementOut {
  hub: string;
  added_projects: number;
  extra_design_weeks: number;
  baseline_load_weeks: number;
  new_load_weeks: number;
  fte_before: number;
  fte_after_scenario: number;
  working_weeks_per_engineer: number;
  capacity_before: number;
  capacity_after_scenario: number;
  booked_pct_before: number | null;
  booked_pct_after: number | null;
  status_before: BookingStatus;
  status_after: BookingStatus;
  min_extra_designers: number;
  min_extra_fte: number;
  designer_fte: number;
  reachable: boolean;
}

export interface LabRegionRequirementOut {
  lab_region: string;
  added_projects: number;
  extra_lab_weeks: number;
  baseline_load_weeks: number;
  new_load_weeks: number;
  chambers_before: number;
  chambers_after_scenario: number;
  capacity_before: number;
  capacity_after_scenario: number;
  booked_pct_before: number | null;
  booked_pct_after: number | null;
  status_before: BookingStatus;
  status_after: BookingStatus;
  efficient_lab_weeks_per_new_chamber: number;
  min_extra_chambers: number;
  reachable: boolean;
}

export interface EstimateResponse {
  kind: 'estimate';
  scope: ScopeInfo;
  basis: WhatIfBasis;
  target_below_pct: number;
  extra_design_weeks_total: number;
  extra_lab_weeks_total: number;
  min_extra_designers_total: number;
  min_extra_chambers_total: number;
  /** Hubs / lab regions the scenario changes (sorted; empty for the zero scenario). The four
   *  totals above sum only the rows of these (P18-R02 D2b). */
  touched_hubs: string[];
  touched_lab_regions: string[];
  design: HubDesignRequirementOut[];
  lab: LabRegionRequirementOut[];
  workings: string[];
}

export interface ProjectResultOut {
  project_id: string;
  name: string;
  hub: string;
  category: string | null;
  priority: string | null;
  is_new: boolean;
  outcome: WhatIfOutcome;
  finish_week: number | null;
  within_year: boolean;
  unconstrained_end_week: number | null;
}

export interface UtilizationRowOut {
  scope: 'hub' | 'lab_region';
  key: string;
  load_weeks: number;
  capacity_year: number;
  booked_pct_year: number | null;
  status_year: BookingStatus;
  capacity_remaining: number;
  booked_pct_remaining: number | null;
  status_remaining: BookingStatus;
  units: number;
}

export interface ProjectChangeOut {
  project_id: string;
  name: string;
  hub: string;
  kind: 'newly_slipping' | 'recovered' | 'moved';
  before_outcome: WhatIfOutcome;
  after_outcome: WhatIfOutcome;
  before_finish_week: number | null;
  after_finish_week: number | null;
}

export interface ScenarioDiffOut {
  within_year_before: number;
  within_year_after: number;
  within_year_delta: number;
  existing_within_year_before: number;
  existing_within_year_after: number;
  new_projects_total: number;
  new_projects_within_year: number;
  newly_slipping: ProjectChangeOut[];
  recovered: ProjectChangeOut[];
  moved: ProjectChangeOut[];
}

export interface SimulateResponse {
  kind: 'simulation';
  scope: ScopeInfo;
  projects: ProjectResultOut[];
  outcome_counts_before: Record<string, number>;
  outcome_counts_after: Record<string, number>;
  utilization_before: UtilizationRowOut[];
  utilization_after: UtilizationRowOut[];
  diff: ScenarioDiffOut;
  new_project_ids: string[];
  added_engineer_ids: string[];
  added_chamber_ids: string[];
  removed_engineer_ids: string[];
  reassigned_project_ids: string[];
  greedy_runs: number;
  workings: string[];
}

export interface DesignerAdditionOut {
  hub: string;
  count: number;
}

export interface ChamberAdditionOut {
  lab_region: string;
  count: number;
}

export interface AdditionsOut {
  designers: DesignerAdditionOut[];
  chambers: ChamberAdditionOut[];
  total: number;
}

export interface UnattainableProjectOut {
  project_id: string;
  name: string;
  hub: string;
  category: string | null;
  unconstrained_end_week: number | null;
}

export interface SolveResponse {
  kind: 'solution';
  scope: ScopeInfo;
  target: WhatIfTarget;
  met: boolean;
  met_attainable: boolean;
  unattainable_project_ids: string[];
  unattainable_projects: UnattainableProjectOut[];
  semantics: string;
  capped: boolean;
  exact: boolean;
  additions: AdditionsOut;
  unmet_project_ids: string[];
  runs_used: number;
  run_cap: number;
  searched_designer_hubs: string[];
  searched_chamber_regions: string[];
  achieved: SimulateResponse | null;
  workings: string[];
}

export interface SnapshotChamberOut {
  chamber_id: string;
  code: string;
  platforms: number;
  efficiency: number;
}

export interface SnapshotHubOut {
  hub: string;
  lab_region: string;
  engineer_fte_total: number;
  design_load_weeks: number;
  design_capacity_year: number;
  design_capacity_remaining: number;
  design_booked_pct_year: number | null;
  design_booked_pct_remaining: number | null;
  design_booking_status_year: BookingStatus;
  lab_load_weeks: number;
  lab_capacity_year: number;
  lab_capacity_remaining: number;
  lab_booked_pct_year: number | null;
  lab_booked_pct_remaining: number | null;
  lab_booking_status_year: BookingStatus;
  chambers: SnapshotChamberOut[];
}

export interface CapacitySnapshotResponse {
  kind: 'capacity_snapshot';
  scope: ScopeInfo;
  current_week: number;
  year_end_week: number;
  near_full_threshold_pct: number;
  full_threshold_pct: number;
  has_active_schedule_run: boolean;
  hubs: SnapshotHubOut[];
}

export type ToolName =
  | 'estimate_requirements'
  | 'simulate_scenario'
  | 'find_minimum_additions'
  | 'get_capacity_snapshot';

export interface ToolRunOut {
  tool: ToolName;
  scenario: ChatScenario | null;
  error: string | null;
  result: EstimateResponse | SimulateResponse | SolveResponse | CapacitySnapshotResponse | null;
}

export interface AskResponse {
  answer: string;
  refused: boolean;
  grounded: boolean;
  ungrounded_numbers: string[];
  scenario: ChatScenario | null;
  results: ToolRunOut[];
  workings: string[];
  rounds_used: number;
  truncated: boolean;
}

import type {
  AskResponse,
  EstimateResponse,
  ProjectChangeOut,
  ProjectResultOut,
  ScopeInfo,
  SimulateResponse,
  SolveResponse,
  UtilizationRowOut,
} from '../api/whatif-types';

export const ALL_SCOPE: ScopeInfo = {
  all_hubs: true,
  hubs: ['R&D-Greece', 'R&D-India', 'PD-India', 'PD-Romania', 'OEM-HCK', 'OEM-Seltek'],
  lab_regions: ['Greece', 'India', 'Romania'],
};

export const INDIA_SCOPE: ScopeInfo = { all_hubs: false, hubs: ['PD-India'], lab_regions: ['India'] };

export function estimateFixture(over: Partial<EstimateResponse> = {}): EstimateResponse {
  return {
    kind: 'estimate',
    scope: ALL_SCOPE,
    basis: 'year',
    target_below_pct: 100,
    extra_design_weeks_total: 180,
    extra_lab_weeks_total: 100,
    min_extra_designers_total: 3,
    min_extra_chambers_total: 1,
    touched_hubs: ['PD-India'],
    touched_lab_regions: ['India'],
    design: [
      {
        hub: 'PD-India',
        added_projects: 10,
        extra_design_weeks: 180,
        baseline_load_weeks: 120,
        new_load_weeks: 300,
        fte_before: 4,
        fte_after_scenario: 4,
        working_weeks_per_engineer: 44,
        capacity_before: 176,
        capacity_after_scenario: 176,
        booked_pct_before: 68.18,
        booked_pct_after: 170.45,
        status_before: 'available',
        status_after: 'full',
        min_extra_designers: 3,
        min_extra_fte: 3,
        designer_fte: 1,
        reachable: true,
      },
    ],
    lab: [
      {
        lab_region: 'India',
        added_projects: 10,
        extra_lab_weeks: 100,
        baseline_load_weeks: 40,
        new_load_weeks: 140,
        chambers_before: 2,
        chambers_after_scenario: 2,
        capacity_before: 90,
        capacity_after_scenario: 90,
        booked_pct_before: 44.44,
        booked_pct_after: 155.56,
        status_before: 'available',
        status_after: 'full',
        efficient_lab_weeks_per_new_chamber: 45,
        min_extra_chambers: 1,
        reachable: true,
      },
    ],
    workings: ['Design PD-India: 10 x 18 = 180 extra weeks', 'Lab India: 10 x 10 = 100 extra weeks'],
    ...over,
  };
}

export function change(id: string, kind: ProjectChangeOut['kind']): ProjectChangeOut {
  return {
    project_id: id,
    name: `Project ${id}`,
    hub: 'PD-India',
    kind,
    before_outcome: kind === 'recovered' ? 'spillover' : 'within_year',
    after_outcome: kind === 'recovered' ? 'within_year' : 'spillover',
    before_finish_week: kind === 'recovered' ? 60 : 48,
    after_finish_week: kind === 'recovered' ? 50 : 61,
  };
}

function util(scope: 'hub' | 'lab_region', key: string, pct: number): UtilizationRowOut {
  return {
    scope,
    key,
    load_weeks: 100,
    capacity_year: 120,
    booked_pct_year: pct,
    status_year: pct >= 100 ? 'full' : pct >= 85 ? 'near_full' : 'available',
    capacity_remaining: 60,
    booked_pct_remaining: pct + 10,
    status_remaining: 'full',
    units: 4,
  };
}

export function simulateFixture(over: Partial<SimulateResponse> = {}): SimulateResponse {
  const newProject: ProjectResultOut = {
    project_id: 'whatif-p001-001',
    name: 'What-if project 1',
    hub: 'PD-India',
    category: 'A',
    priority: 'P3',
    is_new: true,
    outcome: 'spillover',
    finish_week: 70,
    within_year: false,
    unconstrained_end_week: 60,
  };
  return {
    kind: 'simulation',
    scope: ALL_SCOPE,
    projects: [newProject],
    outcome_counts_before: { within_year: 120, spillover: 30, left_out: 2, blocked: 1, excluded: 3, data_error: 0 },
    outcome_counts_after: { within_year: 117, spillover: 34, left_out: 2, blocked: 1, excluded: 3, data_error: 0 },
    utilization_before: [util('hub', 'PD-India', 60), util('lab_region', 'India', 50)],
    utilization_after: [util('hub', 'PD-India', 92), util('lab_region', 'India', 105)],
    diff: {
      within_year_before: 120,
      within_year_after: 117,
      within_year_delta: -3,
      existing_within_year_before: 120,
      existing_within_year_after: 117,
      new_projects_total: 1,
      new_projects_within_year: 0,
      newly_slipping: [change('s1', 'newly_slipping'), change('s2', 'newly_slipping'), change('s3', 'newly_slipping')],
      recovered: [change('r1', 'recovered')],
      moved: [],
    },
    new_project_ids: ['whatif-p001-001'],
    added_engineer_ids: [],
    added_chamber_ids: [],
    removed_engineer_ids: [],
    reassigned_project_ids: [],
    greedy_runs: 2,
    workings: ['Run 1: baseline', 'Run 2: scenario'],
    ...over,
  };
}

export function solveFixture(over: Partial<SolveResponse> = {}): SolveResponse {
  return {
    kind: 'solution',
    scope: ALL_SCOPE,
    target: 'all_new_within_year',
    met: true,
    met_attainable: true,
    unattainable_project_ids: [],
    unattainable_projects: [],
    semantics: 'met: every project of the target finishes inside the planning year. met_attainable: ...',
    capped: false,
    exact: true,
    additions: { designers: [{ hub: 'PD-India', count: 2 }], chambers: [{ lab_region: 'India', count: 1 }], total: 3 },
    unmet_project_ids: [],
    runs_used: 14,
    run_cap: 60,
    searched_designer_hubs: ['PD-India'],
    searched_chamber_regions: ['India'],
    achieved: simulateFixture(),
    workings: ['Region India solved alone: 1 chamber, 2 designers'],
    ...over,
  };
}

export function askFixture(over: Partial<AskResponse> = {}): AskResponse {
  return {
    answer: 'You need 3 more designers and 1 more chamber.',
    refused: false,
    grounded: true,
    ungrounded_numbers: [],
    scenario: {
      add_projects: [
        {
          hub: 'PD-India',
          category: 'A',
          count: 5,
          project_type: null,
          status: 'In Queue',
          priority: null,
          score: null,
          workflow_id: 'PDD',
          certification_testing_required: true,
        },
      ],
      add_engineers: [],
      remove_engineer_counts: [],
      add_chambers: [],
      chamber_downtime: [],
    },
    results: [
      {
        tool: 'estimate_requirements',
        scenario: null,
        error: null,
        result: estimateFixture(),
      },
    ],
    workings: ['Design PD-India: 5 x 18 = 90 weeks'],
    rounds_used: 1,
    truncated: false,
    ...over,
  };
}

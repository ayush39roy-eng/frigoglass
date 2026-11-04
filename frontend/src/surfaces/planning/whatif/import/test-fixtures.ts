// Synthetic plan-import fixtures shaped EXACTLY as docs/API_CONTRACT_P32.md B2 / B3
// (no client data). Used by the import tests with a mocked fetch.

import type {
  ImportParseResponse,
  ImportResultProject,
  ImportResultStep,
  ImportRow,
  ImportSimulateResponse,
  ImportStepMeta,
} from './import-types';

const LETTERS = 'ABCDEFGHIJKLMN'.split('');
const NAMES = [
  'Marketing Brief',
  'Concept',
  'Feasibility',
  'Design Freeze',
  'Detailed Design',
  'Prototype Test',
  'Design Update',
  'Pilot Build',
  'Certification',
  'Release Docs',
  'Tooling',
  'Validation',
  'Industrialization',
  'Handover',
];
const KINDS: ImportStepMeta['kind'][] = [
  'design',
  'design',
  'design',
  'design',
  'design',
  'lab',
  'design',
  'elapsed',
  'lab',
  'design',
  'elapsed',
  'lab',
  'design',
  'design',
];

function meta(workflow: 'PDD' | 'OEM'): ImportStepMeta[] {
  return LETTERS.map((l, i) => ({
    workflow,
    step_id: `${workflow}-${l}`,
    name: NAMES[i] ?? l,
    kind: KINDS[i] ?? 'design',
    sequence_order: i + 1,
    predecessor_ids: i === 0 ? [] : [`${workflow}-${LETTERS[i - 1] ?? 'A'}`],
  }));
}

export const STEPS_META: ImportStepMeta[] = [...meta('PDD'), ...meta('OEM')];

function weeks(workflow: 'PDD' | 'OEM', w: number): Record<string, number> {
  return Object.fromEntries(LETTERS.map((l) => [`${workflow}-${l}`, w]));
}

const baseRow: ImportRow = {
  key: 'row-5',
  file_row: 5,
  sn: '3',
  code: '26-00421',
  plant: 'Rom',
  name: 'Synthetic Cooler 750',
  hub: 'R&D-Greece',
  hub_raw: 'Greece',
  category: 'A',
  category_raw: 'A',
  lead_time_label: 'A',
  status: 'In Development',
  status_raw: 'Development',
  stage_step_id: 'PDD-D',
  stage_raw: 'PDD-D',
  rank: 3,
  priority: 'P1',
  priority_source: 'rank',
  engineer_raw: 'Nikos',
  leader: { kind: 'existing', engineer_id: 'eng-1', name: 'Nikos' },
  matched_project_id: 'plan-9',
  matched_project_name: 'Old Cooler 750',
  match_by: 'name',
  num_projects: 1,
  must_do: true,
  spillover_from_previous: null,
  complexity: 'H',
  est_duration_months: '6-12',
  certification_testing_required: true,
  step_weeks: weeks('PDD', 2),
  include: true,
};

export const ROWS: ImportRow[] = [
  baseRow,
  {
    ...baseRow,
    key: 'row-6',
    file_row: 6,
    sn: '4',
    code: null,
    name: 'Synthetic Freezer 300',
    hub: 'PD-India',
    hub_raw: 'India',
    category: 'B',
    category_raw: 'B',
    lead_time_label: 'B',
    status: 'In Queue',
    status_raw: 'Que',
    stage_step_id: null,
    stage_raw: null,
    rank: null,
    priority: 'P3',
    priority_source: 'default',
    engineer_raw: null,
    leader: { kind: 'auto' },
    matched_project_id: null,
    matched_project_name: null,
    match_by: null,
    must_do: null,
    complexity: null,
    est_duration_months: null,
  },
  {
    ...baseRow,
    key: 'row-7',
    file_row: 7,
    sn: '5',
    code: null,
    name: 'Synthetic OEM Chest',
    hub: 'PD-India',
    hub_raw: 'IND',
    category: 'C',
    category_raw: 'C+',
    lead_time_label: 'C+',
    status: 'In Queue',
    status_raw: 'In Que',
    stage_step_id: 'PDD-B',
    stage_raw: 'PDD-B',
    rank: null,
    priority: 'P2',
    priority_source: 'matched',
    engineer_raw: 'Antonis',
    leader: { kind: 'new', name: 'Antonis' },
    matched_project_id: null,
    matched_project_name: null,
    match_by: null,
  },
];

export const PARSE_RESPONSE: ImportParseResponse = {
  file_name: 'synthetic-plan.xlsx',
  projects_sheet: 'draft 1',
  steps_sheet: 'Process steps',
  base_year: 2026,
  current_week: 42,
  lead_times: [
    { workflow: 'PDD', label: 'A', weeks: weeks('PDD', 2) },
    { workflow: 'PDD', label: 'B', weeks: weeks('PDD', 3) },
    { workflow: 'PDD', label: 'C+', weeks: weeks('PDD', 1) },
    { workflow: 'OEM', label: 'B-OEM', weeks: weeks('OEM', 4) },
  ],
  steps_meta: STEPS_META,
  roster: [
    {
      engineer_id: 'eng-1',
      name: 'Nikos',
      hub: 'R&D-Greece',
      capacity_hub: 'R&D-Greece',
      fte: 1.0,
    },
    {
      engineer_id: 'eng-2',
      name: 'Lokesh',
      hub: 'PD-India',
      capacity_hub: 'PD-India',
      fte: 1.0,
    },
    {
      engineer_id: 'eng-3',
      name: 'Priya',
      hub: 'PD-India',
      capacity_hub: 'PD-India',
      fte: 0.5,
    },
  ],
  rows: ROWS,
  issues: [
    {
      row_key: 'row-6',
      file_row: 6,
      field: 'engineer',
      severity: 'warning',
      code: 'ENGINEER_MISSING',
      message: 'No engineer: auto-assigned.',
    },
    {
      row_key: 'row-7',
      file_row: 7,
      field: 'engineer',
      severity: 'warning',
      code: 'ENGINEER_UNKNOWN',
      message: 'Antonis is not on the roster: new designer.',
    },
    {
      row_key: 'row-7',
      file_row: 7,
      field: 'category',
      severity: 'info',
      code: 'CATEGORY_MAPPED',
      message: 'C+ is scheduled as C.',
    },
    {
      row_key: 'row-5',
      file_row: 5,
      field: null,
      severity: 'info',
      code: 'MATCHED',
      message: 'Matched to Old Cooler 750 by name.',
    },
  ],
  counts: {
    rows: 3,
    schedulable: 3,
    not_scheduled: 0,
    matched: 1,
    new: 2,
    auto_assign: 1,
    new_designers: 1,
  },
};

function step(id: string, seq: number, patch: Partial<ImportResultStep>): ImportResultStep {
  return {
    step_id: id,
    kind: KINDS[seq - 1] ?? 'design',
    sequence_order: seq,
    start_week: null,
    end_week: null,
    duration_weeks: 2,
    span_weeks: 2,
    skipped: false,
    done_before_import: false,
    status: 'Not Started',
    engineer_name: null,
    chamber_code: null,
    duration_override_weeks: 2,
    start_not_before_week: null,
    overlap_weeks: null,
    editable: 'move_resize',
    ...patch,
  };
}

/** row-5: A–C done before import, D In Progress 42–45, E 46–49, F (lab) 50–55, then the rest. */
function fileSteps(): ImportResultStep[] {
  let w = 50;
  return LETTERS.map((l, i) => {
    const id = `PDD-${l}`;
    const seq = i + 1;
    if (i < 3)
      return step(id, seq, {
        skipped: true,
        done_before_import: true,
        duration_weeks: 0,
        span_weeks: 0,
        editable: 'none',
        duration_override_weeks: 0,
      });
    if (i === 3)
      return step(id, seq, {
        start_week: 42,
        end_week: 45,
        duration_weeks: 4,
        span_weeks: 4,
        status: 'In Progress',
        engineer_name: 'Nikos',
        editable: 'resize',
      });
    if (i === 4)
      return step(id, seq, {
        start_week: 46,
        end_week: 49,
        duration_weeks: 4,
        span_weeks: 4,
        engineer_name: 'Nikos',
      });
    const start = w;
    w += 2;
    return step(id, seq, {
      start_week: start,
      end_week: start + 1,
      engineer_name: KINDS[i] === 'design' ? 'Nikos' : null,
      chamber_code: KINDS[i] === 'lab' ? 'CH-2' : null,
    });
  });
}

const fileProject: ImportResultProject = {
  ref: 'row-5',
  source: 'file',
  file_row: 5,
  replaces_project_id: 'plan-9',
  name: 'Synthetic Cooler 750',
  hub: 'R&D-Greece',
  capacity_hub: 'R&D-Greece',
  category: 'A',
  priority: 'P1',
  status: 'In Development',
  leader_name: 'Nikos',
  leader_ref: 'eng-1',
  leader_auto_assigned: false,
  outcome: 'within_year',
  start_week: 42,
  end_week: 67,
  finish_week: 67,
  unconstrained_end_week: 60,
  before_outcome: null,
  before_finish_week: null,
  eng_conflict: false,
  cat_not_allowed: false,
  no_chamber_step_id: null,
  data_error: null,
  within_plan_year: true,
  lab_overlap: false,
  no_leader: false,
  steps: fileSteps(),
};

const planProject: ImportResultProject = {
  ...fileProject,
  ref: 'plan-1',
  source: 'plan',
  file_row: null,
  replaces_project_id: null,
  name: 'Existing Plan Project',
  hub: 'PD-India',
  capacity_hub: 'PD-India',
  priority: 'P2',
  status: 'In Queue',
  leader_name: 'Lokesh',
  leader_ref: 'eng-2',
  outcome: 'spillover',
  start_week: 60,
  end_week: 110,
  finish_week: 110,
  before_outcome: 'within_year',
  before_finish_week: 100,
  steps: fileSteps().map((s) => ({ ...s, done_before_import: false })),
};

const autoProject: ImportResultProject = {
  ...fileProject,
  ref: 'row-6',
  file_row: 6,
  replaces_project_id: null,
  name: 'Synthetic Freezer 300',
  hub: 'PD-India',
  capacity_hub: 'PD-India',
  priority: 'P3',
  status: 'In Queue',
  leader_name: 'Priya',
  leader_ref: 'eng-3',
  leader_auto_assigned: true,
  outcome: 'left_out',
  start_week: null,
  end_week: null,
  finish_week: null,
  steps: fileSteps().map((s) => ({
    ...s,
    start_week: null,
    end_week: null,
    editable: 'none',
  })),
};

export const SIMULATE_RESPONSE: ImportSimulateResponse = {
  base_year: 2026,
  current_week: 42,
  plan_year_end_week: 104,
  horizon_weeks: 130,
  mode: 'merge',
  kpis: {
    projects_total: 240,
    file_projects: 3,
    plan_projects: 237,
    within_plan_year: 171,
    spillover: 52,
    left_out: 9,
    blocked: 4,
    excluded: 3,
    data_error: 1,
    file_within_plan_year: 2,
    file_scheduled: 3,
    before_within_plan_year: 160,
    after_within_plan_year_existing: 158,
    newly_slipping: 1,
    recovered: 0,
  },
  steps_meta: STEPS_META,
  projects: [fileProject, autoProject, planProject],
  capacity: {
    windows: [
      { key: 'y0', label: '2026 W42–W52', from_week: 42, to_week: 52 },
      { key: 'y1', label: '2027', from_week: 53, to_week: 104 },
    ],
    hubs: [
      {
        hub: 'PD-India',
        fte: 6.25,
        windows: [
          {
            key: 'y0',
            load_weeks: 50.5,
            capacity_weeks: 60,
            booked_pct: 84.17,
            status: 'near_full',
          },
          {
            key: 'y1',
            load_weeks: 210.5,
            capacity_weeks: 280,
            booked_pct: 75.18,
            status: 'available',
          },
        ],
      },
    ],
    lab_regions: [
      {
        region: 'India',
        chambers: 4,
        windows: [
          {
            key: 'y0',
            load_weeks: 40,
            capacity_weeks: 38,
            booked_pct: 105.26,
            status: 'full',
          },
          {
            key: 'y1',
            load_weeks: 100,
            capacity_weeks: 180,
            booked_pct: 55.56,
            status: 'available',
          },
        ],
      },
    ],
    weekly: {
      weeks: [42, 43, 44],
      hubs: { 'PD-India': { load: [5, 5.5, 6], capacity: [5.4, 5.4, 5.4] } },
      lab_regions: { India: { load: [3, 4, 2], capacity: [3.5, 3.5, 3.5] } },
    },
    designers: [
      {
        ref: 'eng-2',
        name: 'Lokesh',
        hub: 'PD-India',
        fte: 1,
        is_new: false,
        windows: [
          {
            key: 'y0',
            booked_weeks: 9,
            available_weeks: 9.6,
            booked_pct: 93.75,
            status: 'near_full',
          },
          {
            key: 'y1',
            booked_weeks: 40,
            booked_span_weeks: 44,
            available_weeks: 46.2,
            booked_pct: 86.58,
            status: 'near_full',
          },
        ],
      },
      {
        ref: 'new:1',
        name: 'Antonis',
        hub: 'PD-India',
        fte: 1,
        is_new: true,
        windows: [
          {
            key: 'y1',
            booked_weeks: 12,
            available_weeks: 46.2,
            booked_pct: 25.97,
            status: 'available',
          },
        ],
      },
    ],
  },
  changes: {
    newly_slipping: [
      {
        ref: 'plan-1',
        name: 'Existing Plan Project',
        hub: 'PD-India',
        before_finish_week: 100,
        after_finish_week: 110,
      },
    ],
    recovered: [],
    moved: [],
  },
  issues: [
    {
      ref: 'row-6',
      severity: 'warning',
      code: 'LEADER_AUTO_ASSIGNED',
      message: 'Priya was auto-assigned.',
    },
    {
      ref: 'row-6',
      severity: 'warning',
      code: 'LEFT_OUT',
      message: 'Not placed within the horizon.',
    },
  ],
  workings: ['Baseline: 237 projects; import: 3 rows.'],
};

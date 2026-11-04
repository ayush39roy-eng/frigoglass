// Synthetic plan-import fixtures shaped EXACTLY as docs/API_CONTRACT_P32.md B2 / B3
// (no client data). Used by the import tests with a mocked fetch.

import type {
  Breakdown,
  BreakdownBucket,
  ImportBreakdowns,
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
    derived_status: 0,
    not_a_project: 0,
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

type Counts = [total: number, within: number, spill: number, notPlaced: number];
function b(key: string, [total, within_year, spillover, not_placed]: Counts): BreakdownBucket {
  return { key, total, within_year, spillover, not_placed };
}
function block(
  file: number,
  plan: number,
  outcomes: Partial<Breakdown['outcomes']>,
  dims: Partial<Omit<Breakdown, 'total' | 'file' | 'plan' | 'outcomes'>>,
): Breakdown {
  return {
    total: file + plan,
    file,
    plan,
    outcomes: { within_year: 0, spillover: 0, left_out: 0, blocked: 0, data_error: 0, excluded: 0, ...outcomes },
    by_category: [],
    by_hub: [],
    by_priority: [],
    by_status: [],
    by_source: [],
    by_finish_quarter: [],
    ...dims,
  };
}

/**
 * C1 breakdowns over the three fixture projects: row-5 within the year (W67 = 2027 W15),
 * row-6 not placed, plan-1 spills over (W110 = 2028 W6).
 */
export const BREAKDOWNS: ImportBreakdowns = {
  years: [
    { key: 'all', label: 'All projects' },
    { key: '2026', label: 'Finish in 2026' },
    { key: '2027', label: 'Finish in 2027' },
    { key: 'later', label: 'Finish after 2027' },
    { key: 'not_placed', label: 'Not placed' },
  ],
  by_year: {
    all: block(
      2,
      1,
      { within_year: 1, spillover: 1, left_out: 1 },
      {
        by_category: [b('A', [3, 1, 1, 1])],
        by_hub: [b('R&D-Greece', [1, 1, 0, 0]), b('PD-India', [2, 0, 1, 1])],
        by_priority: [b('P1', [1, 1, 0, 0]), b('P2', [1, 0, 1, 0]), b('P3', [1, 0, 0, 1])],
        by_status: [b('In Development', [1, 1, 0, 0]), b('In Queue', [2, 0, 1, 1])],
        by_source: [b('file', [2, 1, 0, 1]), b('plan', [1, 0, 1, 0])],
        by_finish_quarter: [
          { key: '2027-Q2', label: "Q2 '27", count: 1 },
          { key: '2028-Q1', label: "Q1 '28", count: 1 },
        ],
      },
    ),
    '2026': block(0, 0, {}, {}),
    '2027': block(
      1,
      0,
      { within_year: 1 },
      {
        by_category: [b('A', [1, 1, 0, 0])],
        by_hub: [b('R&D-Greece', [1, 1, 0, 0])],
        by_priority: [b('P1', [1, 1, 0, 0])],
        by_status: [b('In Development', [1, 1, 0, 0])],
        by_source: [b('file', [1, 1, 0, 0])],
        by_finish_quarter: [{ key: '2027-Q2', label: "Q2 '27", count: 1 }],
      },
    ),
    later: block(
      0,
      1,
      { spillover: 1 },
      {
        by_category: [b('A', [1, 0, 1, 0])],
        by_hub: [b('PD-India', [1, 0, 1, 0])],
        by_priority: [b('P2', [1, 0, 1, 0])],
        by_status: [b('In Queue', [1, 0, 1, 0])],
        by_source: [b('plan', [1, 0, 1, 0])],
        by_finish_quarter: [{ key: '2028-Q1', label: "Q1 '28", count: 1 }],
      },
    ),
    not_placed: block(
      1,
      0,
      { left_out: 1 },
      {
        by_category: [b('A', [1, 0, 0, 1])],
        by_hub: [b('PD-India', [1, 0, 0, 1])],
        by_priority: [b('P3', [1, 0, 0, 1])],
        by_status: [b('In Queue', [1, 0, 0, 1])],
        by_source: [b('file', [1, 0, 0, 1])],
      },
    ),
  },
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
  breakdowns: BREAKDOWNS,
};

// --- P32-R07 drill-down fixture -------------------------------------------------------------

/** fileSteps() moved by `by` weeks (null weeks stay null). */
function shifted(by: number): ImportResultStep[] {
  return fileSteps().map((s) => ({
    ...s,
    start_week: s.start_week === null ? null : s.start_week + by,
    end_week: s.end_week === null ? null : s.end_week + by,
  }));
}
const unplacedSteps = (): ImportResultStep[] =>
  fileSteps().map((s) => ({ ...s, start_week: null, end_week: null, editable: 'none' as const }));

/**
 * Seven served projects covering every outcome, a 2026 / 2027 / later finish, an excluded file
 * row (only in "all"), a data-error row with no category ("unknown" bucket) and a blocked plan
 * project. `DRILL_BREAKDOWNS` is written by hand from the server's C1 rules over exactly these
 * rows, and the kpis are the server's scoped figures (2 more not-scheduled plan projects are
 * counted in `excluded` / `projects_total` / `plan_projects` but not returned, B3).
 */
const drillProjects: ImportResultProject[] = [
  { ...fileProject },
  { ...autoProject },
  { ...planProject, within_plan_year: false },
  {
    ...fileProject,
    ref: 'row-7',
    file_row: 7,
    replaces_project_id: null,
    name: 'Synthetic Display 120',
    category: 'B',
    priority: 'P2',
    status: 'Commercialized',
    leader_name: null,
    leader_ref: null,
    outcome: 'excluded',
    start_week: null,
    end_week: null,
    finish_week: null,
    within_plan_year: false,
    steps: unplacedSteps(),
  },
  {
    ...fileProject,
    ref: 'row-8-2',
    file_row: 8,
    replaces_project_id: null,
    name: 'Synthetic Chest 200 (2/2)',
    hub: 'PD-Romania',
    capacity_hub: 'PD-Romania',
    category: '',
    priority: 'P4',
    status: 'In Queue',
    leader_name: null,
    leader_ref: null,
    outcome: 'data_error',
    data_error: 'No lead time for the category.',
    start_week: null,
    end_week: null,
    finish_week: null,
    within_plan_year: false,
    steps: unplacedSteps(),
  },
  {
    ...planProject,
    ref: 'plan-2',
    name: 'Existing Greek Project',
    hub: 'R&D-Greece',
    capacity_hub: 'R&D-Greece',
    category: 'B',
    priority: 'P1',
    status: 'In Development',
    leader_name: 'Antonis',
    leader_ref: 'new:1',
    outcome: 'within_year',
    start_week: 42,
    end_week: 50,
    finish_week: 50,
    within_plan_year: true,
    before_outcome: 'within_year',
    before_finish_week: 48,
    steps: shifted(-17),
  },
  {
    ...planProject,
    ref: 'plan-3',
    name: 'Existing Blocked Project',
    category: 'A+',
    priority: 'P2',
    status: 'In Development',
    outcome: 'blocked',
    start_week: null,
    end_week: null,
    finish_week: null,
    within_plan_year: false,
    before_outcome: 'spillover',
    before_finish_week: 70,
    steps: unplacedSteps(),
  },
];

export const DRILL_BREAKDOWNS: ImportBreakdowns = {
  years: BREAKDOWNS.years,
  by_year: {
    all: block(
      4,
      3,
      { within_year: 2, spillover: 1, left_out: 1, blocked: 1, data_error: 1, excluded: 1 },
      {
        by_category: [b('A+', [1, 0, 0, 1]), b('A', [3, 1, 1, 1]), b('B', [2, 1, 0, 0]), b('unknown', [1, 0, 0, 1])],
        by_hub: [b('R&D-Greece', [3, 2, 0, 0]), b('PD-India', [3, 0, 1, 2]), b('PD-Romania', [1, 0, 0, 1])],
        by_priority: [b('P1', [2, 2, 0, 0]), b('P2', [3, 0, 1, 1]), b('P3', [1, 0, 0, 1]), b('P4', [1, 0, 0, 1])],
        by_status: [b('In Queue', [3, 0, 1, 2]), b('In Development', [3, 2, 0, 1]), b('Commercialized', [1, 0, 0, 0])],
        by_source: [b('file', [4, 1, 0, 2]), b('plan', [3, 1, 1, 1])],
        by_finish_quarter: [
          { key: '2026-Q4', label: "Q4 '26", count: 1 },
          { key: '2027-Q2', label: "Q2 '27", count: 1 },
          { key: '2028-Q1', label: "Q1 '28", count: 1 },
        ],
      },
    ),
    '2026': block(
      0,
      1,
      { within_year: 1 },
      {
        by_category: [b('B', [1, 1, 0, 0])],
        by_hub: [b('R&D-Greece', [1, 1, 0, 0])],
        by_priority: [b('P1', [1, 1, 0, 0])],
        by_status: [b('In Development', [1, 1, 0, 0])],
        by_source: [b('plan', [1, 1, 0, 0])],
        by_finish_quarter: [{ key: '2026-Q4', label: "Q4 '26", count: 1 }],
      },
    ),
    '2027': BREAKDOWNS.by_year['2027'] as Breakdown,
    later: BREAKDOWNS.by_year.later as Breakdown,
    not_placed: block(
      2,
      1,
      { left_out: 1, blocked: 1, data_error: 1 },
      {
        by_category: [b('A+', [1, 0, 0, 1]), b('A', [1, 0, 0, 1]), b('unknown', [1, 0, 0, 1])],
        by_hub: [b('PD-India', [2, 0, 0, 2]), b('PD-Romania', [1, 0, 0, 1])],
        by_priority: [b('P2', [1, 0, 0, 1]), b('P3', [1, 0, 0, 1]), b('P4', [1, 0, 0, 1])],
        by_status: [b('In Queue', [2, 0, 0, 2]), b('In Development', [1, 0, 0, 1])],
        by_source: [b('file', [2, 0, 0, 2]), b('plan', [1, 0, 0, 1])],
      },
    ),
  },
};

const capFigure = (key: string) => ({
  key,
  load_weeks: 10,
  capacity_weeks: 20,
  booked_pct: 50,
  status: 'available',
});

export const DRILL_RESPONSE: ImportSimulateResponse = {
  ...SIMULATE_RESPONSE,
  kpis: {
    projects_total: 9,
    file_projects: 4,
    plan_projects: 5,
    within_plan_year: 2,
    spillover: 1,
    left_out: 1,
    blocked: 1,
    excluded: 3,
    data_error: 1,
    file_within_plan_year: 1,
    file_scheduled: 3,
    before_within_plan_year: 2,
    after_within_plan_year_existing: 1,
    newly_slipping: 1,
    recovered: 0,
  },
  projects: drillProjects,
  capacity: {
    ...SIMULATE_RESPONSE.capacity,
    hubs: ['R&D-Greece', 'PD-India', 'PD-Romania'].map((hub) => ({
      hub,
      fte: 2,
      windows: [capFigure('y0'), capFigure('y1')],
    })),
    lab_regions: ['Greece', 'India', 'Romania'].map((region) => ({
      region,
      chambers: 2,
      windows: [capFigure('y0'), capFigure('y1')],
    })),
    designers: [
      { ref: 'eng-1', name: 'Nikos', hub: 'R&D-Greece', fte: 1, is_new: false, windows: [] },
      ...SIMULATE_RESPONSE.capacity.designers,
    ],
  },
  breakdowns: DRILL_BREAKDOWNS,
};

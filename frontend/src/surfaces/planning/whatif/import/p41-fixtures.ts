import type {
  ImportFormat,
  ImportPlanProject,
  ImportSimulateResponse,
  SavedScenario,
  SavedScenarioSummary,
} from './import-types';
import { PARSE_RESPONSE, SIMULATE_RESPONSE } from './test-fixtures';

/** Synthetic P41 payloads (docs/API_CONTRACT_P41.md); no real project, person or client data. */

const FIELDS: [string, string, string[]][] = [
  ['sn', 'S/N', ['s/n']],
  ['code', 'Project code', ['project code']],
  ['plant', 'Plant', ['plant']],
  ['expenses', 'Expenses', ['expenses']],
  ['priority', 'Priority', ['priority']],
  ['name', 'Project name', ['project description']],
  ['hub', 'Hub', ['rpd hub']],
  ['category', 'Category', ['project category']],
  ['stage', 'Stage', ['pdd project stage']],
  ['status', 'Status', ['status']],
  ['engineer', 'Design engineer', ['recommended design engineer']],
  ['spillover', 'Spillover', ['spillover']],
  ['num_projects', 'Number of projects', ['num of projects']],
  ['must_do', 'Must do', ['must do']],
  ['complexity', 'Complexity', ['complexity']],
  ['est_duration', 'Estimated duration (months)', ['est duration']],
];

export function p41Format(overrides: Partial<ImportFormat> = {}): ImportFormat {
  return {
    version: 3,
    is_default: false,
    fields: FIELDS.map(([key, label, aliases]) => ({
      key,
      label,
      required: key === 'name',
      aliases: [...aliases],
      default_aliases: [...aliases],
    })),
    updated_at: '2026-11-16T10:00:00Z',
    updated_by_name: 'Synthetic Admin',
    can_edit: true,
    ...overrides,
  };
}

export const PLAN_PROJECTS: ImportPlanProject[] = [
  { id: 'plan-1', name: 'Existing Plan Project', hub: 'PD-India', category: 'B', priority: 'P2', status: 'In Queue' },
  { id: 'plan-2', name: 'Existing Greek Project', hub: 'R&D-Greece', category: 'C', priority: 'P3', status: 'In Queue' },
];

/** The served simulate response with the P41 fields. */
export const P41_RESPONSE: ImportSimulateResponse = {
  ...SIMULATE_RESPONSE,
  kpis: { ...SIMULATE_RESPONSE.kpis, plan_excluded: 0 },
  plan_projects: PLAN_PROJECTS,
};

export const SHA_A = 'a'.repeat(64);
export const SHA_B = 'b'.repeat(64);

export function p41Summary(o: Partial<SavedScenarioSummary> = {}): SavedScenarioSummary {
  return {
    id: 'saved-1',
    name: 'Saved base',
    note: 'Synthetic note',
    source_file_name: 'synthetic-plan.xlsx',
    source_file_sha256: SHA_A,
    imported_at: '2026-11-17T09:00:00Z',
    created_at: '2026-11-17T09:30:00Z',
    created_by_name: 'Synthetic Planner',
    can_edit: true,
    mode: 'merge',
    plan_year_end_week: 104,
    simulated_week: 40,
    plan_version: 14,
    hub_codes: ['PD-India'],
    kpis: P41_RESPONSE.kpis,
    ...o,
  };
}

export function p41Saved(o: Partial<SavedScenarioSummary> = {}): SavedScenario {
  return {
    ...p41Summary(o),
    request: {
      mode: 'merge',
      plan_year_end_week: 104,
      expand_multi: true,
      rows: PARSE_RESPONSE.rows,
      edits: [],
      exclude_plan_project_ids: ['plan-2'],
    },
    result: P41_RESPONSE,
  };
}

import { describe, expect, it } from 'vitest';

import type { VipBoardResponse, VipItem, VipItemProject } from '@/lib/api/vip';

import type { CompletingWithinYearRow, ProjectFilterRow } from '../api/types';
import { P13_ROW_DEFAULTS } from '../test-fixtures';
import { selectOutcomeRows, selectRiskRows, vipHighlightedTotal, vipProjectsNotInYear } from './executive';

function wyRow(overrides: Partial<CompletingWithinYearRow> = {}): CompletingWithinYearRow {
  return {
    project_id: 'p-1',
    project_name: 'Project One',
    hub: 'PD-India',
    category: null,
    priority: 'P1',
    within_year: false,
    spillover: false,
    left_out: false,
    blocked: false,
    cat_not_allowed: false,
    last_step_end_week: null,
    type: null,
    status: 'In Development',
    not_started: false,
    ...overrides,
  };
}

function regRow(overrides: Partial<ProjectFilterRow> = {}): ProjectFilterRow {
  return {
    project_id: 'p-2',
    project_name: 'Project Two',
    hub: 'R&D-Greece',
    category: null,
    status: 'In Development',
    priority: null,
    is_vip: false,
    tracking_status: 'live',
    ...P13_ROW_DEFAULTS,
    ...overrides,
  };
}

function vipProject(overrides: Partial<VipItemProject> = {}): VipItemProject {
  return {
    id: 'p-3',
    name: 'VIP Project',
    hub: 'PD-Romania',
    priority: 'P1',
    status: 'In Development',
    projected_end_week: 60,
    within_year: false,
    health: null,
    ...overrides,
  };
}

function vipItem(overrides: Partial<VipItem> = {}): VipItem {
  return {
    id: 'item-1',
    pillar: 'INNOVATION',
    title: 'Smart Cooler',
    status_tag: null,
    status_note: null,
    highlighted: true,
    sort_order: 0,
    children: [],
    projects: [],
    hidden_project_count: 0,
    ...overrides,
  };
}

function board(overrides: Partial<VipBoardResponse> = {}): VipBoardResponse {
  return {
    run_id: 'run-1',
    pillars: [],
    areas: [
      {
        area: 'Greece',
        label: 'Greece',
        hubs: ['R&D-Greece'],
        item_count: 2,
        highlighted_count: 2,
        vip_project_count: 2,
        high_risk_count: 0,
        linked_project_count: 3,
        vip_items: [],
        items: [],
      },
      {
        area: 'India',
        label: 'India',
        hubs: ['PD-India'],
        item_count: 1,
        highlighted_count: 3,
        vip_project_count: 3,
        high_risk_count: 1,
        linked_project_count: 1,
        vip_items: [],
        items: [],
      },
    ],
    ...overrides,
  };
}

describe('vipHighlightedTotal', () => {
  it('adds the served per-area highlighted counts (presentation sum, same class as the header total)', () => {
    expect(vipHighlightedTotal(board())).toBe(5);
  });
  it('is null while the board is unresolved', () => {
    expect(vipHighlightedTotal(null)).toBeNull();
    // ADR 0040: the headline counts pinned projects, not highlighted slide items.
    const b = board();
    expect(vipHighlightedTotal({ ...b, areas: b.areas.map((a) => ({ ...a, vip_project_count: 0 })) })).toBe(0);
    expect(vipHighlightedTotal(undefined)).toBeNull();
  });
});

describe('vipProjectsNotInYear', () => {
  it('selects highlighted items’ projects with the served within_year === false, including one child level', () => {
    const b = board({
      areas: [
        {
          ...board().areas[0]!,
          items: [
            vipItem({
              id: 'a',
              projects: [vipProject({ id: 'risk-1', within_year: false })],
              children: [vipItem({ id: 'a-child', projects: [vipProject({ id: 'risk-2', within_year: false })] })],
            }),
            // Not highlighted → its projects are never risks.
            vipItem({ id: 'b', highlighted: false, projects: [vipProject({ id: 'no-risk-1', within_year: false })] }),
            // within_year true or null (no run) → no judgement, no risk.
            vipItem({
              id: 'c',
              projects: [
                vipProject({ id: 'no-risk-2', within_year: true }),
                vipProject({ id: 'no-risk-3', within_year: null }),
              ],
            }),
          ],
        },
      ],
    });
    expect(vipProjectsNotInYear(b).map((p) => p.id)).toEqual(['risk-1', 'risk-2']);
  });
});

describe('selectRiskRows (ADR 0039 §3)', () => {
  it('orders blocked → overdue → VIP-not-in-year and keeps served facts verbatim', () => {
    const rows = selectRiskRows(
      [wyRow({ project_id: 'b1', project_name: 'Blocked One', blocked: true }), wyRow({ project_id: 'ok', blocked: false })],
      [regRow({ project_id: 'o1', project_name: 'Overdue One', tracking_status: 'overdue' }), regRow({ project_id: 'live', tracking_status: 'live' })],
      board({
        areas: [
          {
            ...board().areas[0]!,
            items: [vipItem({ projects: [vipProject({ id: 'v1', name: 'VIP One', within_year: false })] })],
          },
        ],
      }),
    );
    expect(rows).toEqual([
      { projectId: 'b1', name: 'Blocked One', hub: 'PD-India', reason: 'blocked' },
      { projectId: 'o1', name: 'Overdue One', hub: 'R&D-Greece', reason: 'overdue' },
      { projectId: 'v1', name: 'VIP One', hub: 'PD-Romania', reason: 'vip_not_in_year' },
    ]);
  });

  it('de-duplicates by project id — the first reason wins', () => {
    const rows = selectRiskRows(
      [wyRow({ project_id: 'dup', project_name: 'Twice Flagged', blocked: true })],
      [regRow({ project_id: 'dup', project_name: 'Twice Flagged', tracking_status: 'overdue' })],
      board({
        areas: [
          {
            ...board().areas[0]!,
            items: [vipItem({ projects: [vipProject({ id: 'dup', name: 'Twice Flagged', within_year: false })] })],
          },
        ],
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ projectId: 'dup', reason: 'blocked' });
  });

  it('returns [] when nothing is flagged', () => {
    expect(selectRiskRows([wyRow()], [regRow()], board())).toEqual([]);
  });
});

describe('selectOutcomeRows (P28 addendum — KPI click-through)', () => {
  const rows = [
    wyRow({ project_id: 'w1', within_year: true }),
    wyRow({ project_id: 's1', spillover: true }),
    wyRow({ project_id: 'l1', left_out: true }),
    // P9-F02: blocked wins outright — never double-listed under within-year.
    wyRow({ project_id: 'b1', blocked: true, within_year: true }),
    // No served flag at all: in no bucket, not even "scheduled".
    wyRow({ project_id: 'u1' }),
  ];

  it('selects by the served flags through the one outcome precedence', () => {
    expect(selectOutcomeRows(rows, 'within_year').map((r) => r.project_id)).toEqual(['w1']);
    expect(selectOutcomeRows(rows, 'spillover').map((r) => r.project_id)).toEqual(['s1']);
    expect(selectOutcomeRows(rows, 'left_out').map((r) => r.project_id)).toEqual(['l1']);
    expect(selectOutcomeRows(rows, 'blocked').map((r) => r.project_id)).toEqual(['b1']);
  });

  it('"scheduled" = every row in one of the four buckets (matches outcomeTotal)', () => {
    expect(selectOutcomeRows(rows, 'scheduled').map((r) => r.project_id)).toEqual(['w1', 's1', 'l1', 'b1']);
  });
});

import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';

import { CARRY_OVER_YEAR } from '@/lib/domain-constants';
import { renderWithProviders } from '@/test/render';
import type { LabRegion, ProjectStatus } from '@/types/enums';

import type {
  CompletingWithinYearRow,
  HubTypePipelineRow,
  PipelineTotals,
  ProjectFilterRow,
  RegionSummary,
  StatusOverview,
} from '../api/types';
import { selectOutcomeRows } from '../lib/executive';
import { HubRankList } from './hub-rank-list';
import { PipelineRow } from './pipeline-row';
import { ProjectListProvider, type ProjectListScope } from './project-list-dialog';
import { StatusOverviewCards } from './status-overview-cards';

/** Owner ask 2026-11-13: clicking a Dashboard figure lists its projects. */

// jsdom: the shared VirtualDataTable's viewport measures 0 high, so the
// virtualizer is mocked to list every row (virtual-data-table.test.tsx pattern).
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 40,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ key: index, index, start: index * 40, size: 40 })),
    measureElement: () => undefined,
  }),
}));

const drill = vi.hoisted(() => ({ useDrilldownProjects: vi.fn() }));
vi.mock('../hooks/use-dashboard', () => ({
  useDrilldownProjects: (...a: unknown[]) => drill.useDrilldownProjects(...a) as unknown,
}));

let n = 0;
function project(over: Partial<ProjectFilterRow> & { region: LabRegion; status: ProjectStatus }): ProjectFilterRow {
  n += 1;
  return {
    project_id: `p-${String(n)}`,
    project_name: `Project ${String(n)}`,
    hub: over.region === 'India' ? 'PD-India' : over.region === 'Romania' ? 'PD-Romania' : 'R&D-Greece',
    category: 'B',
    priority: 'P2',
    is_vip: false,
    tracking_status: 'on_track',
    external_code: null,
    type: 'NM',
    leader_name: null,
    leader_engineer_id: null,
    current_step_code: null,
    current_step_name: null,
    end_week: null,
    outcome: null,
    reg_year: 2026,
    carry_over: false,
    plant: null,
    requesting_department: null,
    product_type: null,
    priority_rank: null,
    ...over,
  } as ProjectFilterRow;
}

const ROWS: ProjectFilterRow[] = [
  project({ project_name: 'Carry India', region: 'India', status: 'In Development', carry_over: true }),
  project({ project_name: 'Carry Greece', region: 'Greece', status: 'In Queue', carry_over: true }),
  project({ project_name: 'New India', region: 'India', status: 'In Development' }),
  project({ project_name: 'New Romania', region: 'Romania', status: 'Cancelled' }),
];

const SCOPE: ProjectListScope = { hubId: null, region: null, selection: { categories: [], types: [] } };

const TOTALS: PipelineTotals = {
  spillover_count: 2,
  new_count: 2,
  unregistered_count: 0,
  total_count: 4,
  spillover_share_pct: 50,
  new_share_pct: 50,
  unregistered_share_pct: 0,
};

const region = (r: LabRegion, total: number, spill: number, newly: number) => ({
  region: r,
  total_count: total,
  share_pct: total * 25,
  spillover_count: spill,
  newly_registered_count: newly,
  unregistered_count: 0,
  spillover_share_pct: spill * 50,
  newly_registered_share_pct: newly * 50,
  unregistered_share_pct: 0,
  status_counts: {},
  status_share_pct: {},
});
const SUMMARY: RegionSummary = {
  total_count: 4,
  regions: [region('Greece', 1, 1, 0), region('India', 2, 1, 1), region('Romania', 1, 0, 1)],
};

const STATUS: StatusOverview = {
  in_buyoff: 0,
  under_industrialization: 0,
  in_development: 2,
  in_queue: 1,
  other_counts: {},
  commercialized_count: 0,
  on_hold_count: 0,
  total_count: 4,
  in_development_share_pct: 50,
  under_industrialization_share_pct: 0,
  in_queue_share_pct: 25,
  commercialized_share_pct: 0,
  on_hold_share_pct: 0,
  other_statuses_count: 1,
  other_statuses_counts: { Cancelled: 1 },
  other_statuses_share_pct: 25,
};

function names(): string[] {
  const dialog = screen.getByTestId('project-list-dialog');
  return within(dialog)
    .getAllByRole('link')
    .map((a) => a.textContent ?? '');
}

beforeEach(() => {
  drill.useDrilldownProjects.mockReset();
  drill.useDrilldownProjects.mockReturnValue({
    data: { total_count: ROWS.length, rows: ROWS },
    isPending: false,
    isError: false,
  });
});

describe('Project pipeline cards', () => {
  it('a card lists its bucket: Spillover = carry-over projects', async () => {
    renderWithProviders(
      <ProjectListProvider scope={SCOPE}>
        <PipelineRow totals={TOTALS} regionSummary={SUMMARY} />
      </ProjectListProvider>,
    );
    await userEvent.click(screen.getByTestId('pipeline-open-spillover'));
    expect(screen.getByTestId('project-list-dialog-title')).toHaveTextContent(
      `Spillover ${String(CARRY_OVER_YEAR)} — 2 projects`,
    );
    expect(names()).toEqual(['Carry India', 'Carry Greece']);
  });

  it('a country chip lists that country within the bucket', async () => {
    renderWithProviders(
      <ProjectListProvider scope={SCOPE}>
        <PipelineRow totals={TOTALS} regionSummary={SUMMARY} />
      </ProjectListProvider>,
    );
    const newCard = screen.getByTestId('pipeline-card-new');
    await userEvent.click(within(newCard).getByRole('button', { name: /India: 1/ }));
    expect(screen.getByTestId('project-list-dialog-title')).toHaveTextContent(/India — 1 project$/);
    expect(names()).toEqual(['New India']);
  });

  it('fetches with the Dashboard scope (hub, country, category, type)', async () => {
    renderWithProviders(
      <ProjectListProvider
        scope={{ hubId: 'hub-1', region: 'India', selection: { categories: ['A'], types: ['NM'] } }}
      >
        <PipelineRow totals={TOTALS} regionSummary={SUMMARY} />
      </ProjectListProvider>,
    );
    await userEvent.click(screen.getByTestId('pipeline-open-total'));
    expect(drill.useDrilldownProjects).toHaveBeenLastCalledWith(
      { hub_id: 'hub-1', region: 'India', category: ['A'], type: ['NM'] },
      true,
    );
  });
});

describe('Status overview cards', () => {
  it('a status card lists its status; "Other statuses" lists the rest', async () => {
    renderWithProviders(
      <ProjectListProvider scope={SCOPE}>
        <StatusOverviewCards data={STATUS} />
      </ProjectListProvider>,
    );
    await userEvent.click(screen.getByTestId('status-open-in-development'));
    expect(names()).toEqual(['Carry India', 'New India']);
    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByTestId('status-open-other'));
    expect(names()).toEqual(['New Romania']);
  });

  it('says so when the fresh list disagrees with the served count', async () => {
    renderWithProviders(
      <ProjectListProvider scope={SCOPE}>
        <StatusOverviewCards data={{ ...STATUS, in_queue: 3 }} />
      </ProjectListProvider>,
    );
    await userEvent.click(screen.getByTestId('status-open-in-queue'));
    expect(screen.getByRole('status')).toHaveTextContent('The list now has 1');
  });

  it('is plain, non-clickable text outside a provider', () => {
    renderWithProviders(<StatusOverviewCards data={STATUS} />);
    expect(screen.queryByTestId('status-open-in-development')).not.toBeInTheDocument();
  });
});

describe('Top hubs by project count', () => {
  const HUB_ROWS: HubTypePipelineRow[] = [
    { hub: 'PD-India', type: 'NM', count: 2 },
    { hub: 'R&D-Greece', type: 'NM', count: 1 },
    { hub: 'PD-Romania', type: 'NM', count: 1 },
  ];

  it("shows each hub's share of ALL projects (not of the largest hub) and the served country chips", () => {
    renderWithProviders(<HubRankList rows={HUB_ROWS} pipelineTotal={4} regionSummary={SUMMARY} />);
    const items = within(screen.getByRole('list', { name: /Real project count per hub/i })).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('50%');
    expect(items[1]).toHaveTextContent('25%');
    expect(screen.getByTestId('hub-rank-summary')).toHaveTextContent('4 projects');
    expect(screen.getByRole('list', { name: 'Projects by country' })).toHaveTextContent('(50%)');
  });

  it('a hub row lists that hub', async () => {
    renderWithProviders(
      <ProjectListProvider scope={SCOPE}>
        <HubRankList rows={HUB_ROWS} pipelineTotal={4} regionSummary={SUMMARY} />
      </ProjectListProvider>,
    );
    await userEvent.click(screen.getByTestId('hub-rank-open-PD-India'));
    expect(names()).toEqual(['Carry India', 'New India']);
  });
});

describe('selectOutcomeRows past_year', () => {
  it('is spillover plus left out, matching the "Spillover (past W52)" tile', () => {
    const base = {
      hub: 'PD-India',
      category: 'B',
      priority: 'P2',
      cat_not_allowed: false,
      last_step_end_week: null,
      type: 'NM',
      status: 'In Development',
      not_started: false,
      within_year: false,
      spillover: false,
      left_out: false,
      blocked: false,
    } as const;
    const rows = [
      { ...base, project_id: 'a', project_name: 'a', within_year: true },
      { ...base, project_id: 'b', project_name: 'b', spillover: true },
      { ...base, project_id: 'c', project_name: 'c', left_out: true },
      { ...base, project_id: 'd', project_name: 'd', left_out: true, blocked: true },
    ] as CompletingWithinYearRow[];
    expect(selectOutcomeRows(rows, 'past_year').map((r) => r.project_id)).toEqual(['b', 'c']);
  });
});

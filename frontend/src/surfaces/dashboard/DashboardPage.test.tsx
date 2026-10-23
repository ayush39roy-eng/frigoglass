import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import { useHubFilterStore } from '@/stores/hub-filter';
import { ApiError } from '@/lib/api/client';
import type {
  CompletingWithinYear,
  DashboardAnalytics,
  HubTypePipelineRow,
  PipelineTotals,
  StatusOverview,
} from './api/types';

const hooks = {
  useCompletingWithinYear: vi.fn(),
  usePipelineTotals: vi.fn(),
  useStatusOverview: vi.fn(),
  useHubTypePipeline: vi.fn(),
  useActiveScheduleRun: vi.fn(),
  useDashboardProjects: vi.fn(),
  useRegionSummary: vi.fn(),
  useProjectFacets: vi.fn(),
  useDashboardAnalytics: vi.fn(),
  useCrossFilterBreakdowns: vi.fn(),
};

/** P31: no Dashboard category / type selection. */
const NO_SEL = expect.objectContaining({ categories: [], types: [] });

vi.mock('./hooks/use-dashboard', () => ({
  useCompletingWithinYear: (...a: unknown[]) => hooks.useCompletingWithinYear(...a),
  usePipelineTotals: (...a: unknown[]) => hooks.usePipelineTotals(...a),
  useStatusOverview: (...a: unknown[]) => hooks.useStatusOverview(...a),
  useHubTypePipeline: (...a: unknown[]) => hooks.useHubTypePipeline(...a),
  useActiveScheduleRun: (...a: unknown[]) => hooks.useActiveScheduleRun(...a),
  useDashboardProjects: (...a: unknown[]) => hooks.useDashboardProjects(...a),
  useRegionSummary: (...a: unknown[]) => hooks.useRegionSummary(...a),
  useProjectFacets: (...a: unknown[]) => hooks.useProjectFacets(...a),
  useDashboardAnalytics: (...a: unknown[]) => hooks.useDashboardAnalytics(...a),
  // P31: the cross-filter donuts read the same mocked payloads (the page calls
  // useDashboardAnalytics / usePipelineTotals just before this hook).
  useCrossFilterBreakdowns: (...a: unknown[]) => {
    hooks.useCrossFilterBreakdowns(...a);
    const analytics = hooks.useDashboardAnalytics.mock.results.at(-1)?.value as unknown;
    const totals = hooks.usePipelineTotals.mock.results.at(-1)?.value as unknown;
    return { type: { analytics, totals }, category: { analytics, totals } };
  },
}));
vi.mock('@/lib/api/reference', () => ({
  useHubs: () => ({
    data: [
      { id: 'hub-greece', name: 'R&D-Greece', lab_region: 'Greece', is_oem: false, capacity_hub_id: null, capacity_hub_name: null },
      { id: 'hub-pdin', name: 'PD-India', lab_region: 'India', is_oem: false, capacity_hub_id: null, capacity_hub_name: null },
      { id: 'hub-ro', name: 'PD-Romania', lab_region: 'Romania', is_oem: false, capacity_hub_id: null, capacity_hub_name: null },
    ],
  }),
}));
// P23-T03 as narrowed by ADR 0039 §4 (P28, owner-sanctioned supersession): the
// DETAILED view never asks for /capacity/hub-load. Owner ask 2026-10-23 removed
// the Executive view's "Hubs at a glance" (its only consumer), so NEITHER view
// asks for it now. Mocked so the absence is assertable in both views.
const capacityHook = { useHubLoadVsCapacity: vi.fn() };
vi.mock('@/surfaces/capacity/hooks/use-capacity', () => ({
  useHubLoadVsCapacity: (...a: unknown[]) => capacityHook.useHubLoadVsCapacity(...a),
}));

// P14: the VIP card's own fetch (tested in components/vip/vip-projects-card.test.tsx).
const vipHook = { useVipBoard: vi.fn() };
vi.mock('@/lib/api/vip', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/vip')>('@/lib/api/vip');
  return { ...actual, useVipBoard: (...a: unknown[]) => vipHook.useVipBoard(...a) };
});

import DashboardPage from './DashboardPage';
import { CARRY_OVER_YEAR } from '@/lib/domain-constants';

const pending = { data: undefined, isPending: true, isError: false, error: null, refetch: vi.fn() };
function ready<T>(data: T) {
  return { data, isPending: false, isError: false, error: null, refetch: vi.fn() };
}
function failed(error: Error) {
  return { data: undefined, isPending: false, isError: true, error, refetch: vi.fn() };
}

const withinYear: CompletingWithinYear = {
  has_active_schedule_run: true,
  schedule_run_version: 4,
  within_year_count: 9,
  spillover_count: 4,
  left_out_count: 2,
  blocked_count: 1,
  priority_delivery: [],
  rows: [],
};
const totals: PipelineTotals = {
  spillover_count: 76,
  new_count: 160,
  unregistered_count: 3,
  total_count: 239,
  spillover_share_pct: 31.8,
  new_share_pct: 66.95,
  unregistered_share_pct: 1.26,
};
const status: StatusOverview = {
  in_buyoff: 5,
  under_industrialization: 12,
  in_development: 40,
  in_queue: 100,
  other_counts: {},
  commercialized_count: 8,
  on_hold_count: 2,
  total_count: 239,
  in_development_share_pct: 16.74,
  under_industrialization_share_pct: 5.02,
  in_queue_share_pct: 41.84,
  commercialized_share_pct: 3.35,
  on_hold_share_pct: 0.84,
  other_statuses_count: 5,
  other_statuses_counts: { 'In Buyoff': 5 },
  other_statuses_share_pct: 2.09,
};
const hubType: HubTypePipelineRow[] = [{ hub: 'R&D-Greece', type: 'NM', count: 3 }];

beforeEach(() => {
  vi.clearAllMocks();
  // P28: no stored view choice leaks between tests (role default applies).
  window.localStorage.removeItem('rpd-dashboard-view');
  capacityHook.useHubLoadVsCapacity.mockReturnValue(pending);
  useHubFilterStore.setState({ hubId: null, region: null });
  vipHook.useVipBoard.mockReturnValue(ready({ run_id: null, pillars: [], areas: [] }));
  hooks.useActiveScheduleRun.mockReturnValue(ready(null));
  hooks.useRegionSummary.mockReturnValue(pending);
  hooks.useProjectFacets.mockReturnValue(ready({ leaders: [], steps: [] }));
  hooks.useDashboardAnalytics.mockReturnValue(pending);
  hooks.useDashboardProjects.mockReturnValue(ready({ total_count: 0, rows: [] }));
});

describe('DashboardPage', () => {
  it('P12 (ADR 0020): every card follows the global hub filter and the header shows "Hub: <name>"', () => {
    useHubFilterStore.setState({ hubId: 'hub-greece' });
    hooks.useCompletingWithinYear.mockReturnValue(ready(withinYear));
    hooks.usePipelineTotals.mockReturnValue(ready(totals));
    hooks.useStatusOverview.mockReturnValue(ready(status));
    hooks.useHubTypePipeline.mockReturnValue(ready(hubType));
    renderWithProviders(<DashboardPage />);
    expect(hooks.useCompletingWithinYear).toHaveBeenLastCalledWith('hub-greece', null, NO_SEL);
    expect(hooks.usePipelineTotals).toHaveBeenLastCalledWith('hub-greece', null, NO_SEL);
    expect(hooks.useStatusOverview).toHaveBeenLastCalledWith('hub-greece', null, NO_SEL);
    expect(hooks.useHubTypePipeline).toHaveBeenLastCalledWith('hub-greece', null, NO_SEL);
    expect(hooks.useDashboardProjects).toHaveBeenLastCalledWith(expect.objectContaining({ hub_id: 'hub-greece' }));
    expect(capacityHook.useHubLoadVsCapacity).not.toHaveBeenCalled();
    expect(screen.getByTestId('hub-filter-chip')).toBeInTheDocument();
  });

  it('always renders the surface heading', () => {
    hooks.useCompletingWithinYear.mockReturnValue(pending);
    hooks.usePipelineTotals.mockReturnValue(pending);
    hooks.useStatusOverview.mockReturnValue(pending);
    hooks.useHubTypePipeline.mockReturnValue(pending);
    renderWithProviders(<DashboardPage />);
    expect(screen.getByRole('heading', { name: 'Global RPD Dashboard' })).toBeInTheDocument();
  });

  it('renders every section from its own schedule-run-sourced payload on success', () => {
    hooks.useCompletingWithinYear.mockReturnValue(ready(withinYear));
    hooks.usePipelineTotals.mockReturnValue(ready(totals));
    hooks.useStatusOverview.mockReturnValue(ready(status));
    hooks.useHubTypePipeline.mockReturnValue(ready(hubType));
    renderWithProviders(<DashboardPage />);

    expect(screen.getByText('Completing within the year')).toBeInTheDocument();
    expect(screen.getByText('Status overview')).toBeInTheDocument();
    expect(screen.getByText('Project pipeline summary: Hub × Type')).toBeInTheDocument();
    expect(screen.getByText('All registered projects')).toBeInTheDocument();
    // headline within-year figure comes from the I9 endpoint
    expect(screen.getByTestId('schedule-run-provenance')).toHaveTextContent(/v4/);
  });

  // Narrowed to the DETAILED view by ADR 0039 §4 (P28); since the 2026-10-23
  // removal of "Hubs at a glance" the Executive view does not request it either
  // (asserted in the "P28 Executive view" suite below).
  it('P23-T03 (Detailed view): no "Capacity booked" card and no capacity request, even for a session that can read Capacity', () => {
    hooks.useCompletingWithinYear.mockReturnValue(ready(withinYear));
    hooks.usePipelineTotals.mockReturnValue(ready(totals));
    hooks.useStatusOverview.mockReturnValue(ready(status));
    hooks.useHubTypePipeline.mockReturnValue(ready(hubType));
    // Default session: Super Admin, Capacity read.
    renderWithProviders(<DashboardPage />);
    expect(screen.queryByTestId('capacity-booked-card')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Capacity booked' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Europe/)).not.toBeInTheDocument();
    expect(capacityHook.useHubLoadVsCapacity).not.toHaveBeenCalled();
  });

  it('degrades to an access notice (not a wall of errors) on a 403', () => {
    const forbidden = failed(new ApiError(403, 'forbidden'));
    hooks.useCompletingWithinYear.mockReturnValue(forbidden);
    hooks.usePipelineTotals.mockReturnValue(forbidden);
    hooks.useStatusOverview.mockReturnValue(forbidden);
    hooks.useHubTypePipeline.mockReturnValue(forbidden);
    renderWithProviders(<DashboardPage />);

    expect(
      screen.getByText(/does not have access to the Global RPD Dashboard/i),
    ).toBeInTheDocument();
    expect(screen.queryByText('Status overview')).not.toBeInTheDocument();
  });

  it('shows a per-section error (with the surface intact) when one endpoint fails non-auth', () => {
    hooks.useCompletingWithinYear.mockReturnValue(ready(withinYear));
    hooks.usePipelineTotals.mockReturnValue(ready(totals));
    hooks.useStatusOverview.mockReturnValue(failed(new ApiError(500, 'boom')));
    hooks.useHubTypePipeline.mockReturnValue(ready(hubType));
    renderWithProviders(<DashboardPage />);

    expect(screen.getByRole('alert')).toHaveTextContent(/Status overview counts could not be loaded/i);
    // the rest of the surface still renders
    expect(screen.getByText('Project pipeline summary: Hub × Type')).toBeInTheDocument();
  });
});

describe('DashboardPage — P13 country filter (ADR 0025)', () => {
  const regionSummary = {
    total_count: 236,
    regions: [
      {
        region: 'Greece',
        total_count: 30,
        share_pct: 12.71,
        spillover_count: 9,
        newly_registered_count: 21,
        unregistered_count: 0,
        spillover_share_pct: 0,
        newly_registered_share_pct: 0,
        unregistered_share_pct: 0,
        status_counts: { 'In Buyoff': 1, 'Under Industrialization': 4, 'In Development': 10, 'In Queue': 15, Commercialized: 2, 'On Hold': 0 },
        status_share_pct: { 'In Buyoff': 20, 'Under Industrialization': 33.33, 'In Development': 25, 'In Queue': 15 },
      },
      {
        region: 'India',
        total_count: 182,
        share_pct: 77.12,
        spillover_count: 59,
        newly_registered_count: 123,
        unregistered_count: 0,
        spillover_share_pct: 77.63,
        newly_registered_share_pct: 0,
        unregistered_share_pct: 0,
        status_counts: { 'In Buyoff': 3, 'Under Industrialization': 7, 'In Development': 27, 'In Queue': 80, Commercialized: 5 },
        status_share_pct: { 'In Buyoff': 60, 'Under Industrialization': 58.33, 'In Development': 67.5, 'In Queue': 80 },
      },
      {
        region: 'Romania',
        total_count: 24,
        share_pct: 10.17,
        spillover_count: 4,
        newly_registered_count: 20,
        unregistered_count: 0,
        spillover_share_pct: 0,
        newly_registered_share_pct: 0,
        unregistered_share_pct: 0,
        status_counts: { 'In Buyoff': 1, 'Under Industrialization': 1, 'In Development': 3, 'In Queue': 5, Commercialized: 0 },
        status_share_pct: { 'In Buyoff': 20, 'Under Industrialization': 8.33, 'In Development': 7.5, 'In Queue': 5 },
      },
    ],
  };

  function readyAll(): void {
    hooks.useCompletingWithinYear.mockReturnValue(ready(withinYear));
    hooks.usePipelineTotals.mockReturnValue(ready(totals));
    hooks.useStatusOverview.mockReturnValue(ready(status));
    hooks.useHubTypePipeline.mockReturnValue(ready(hubType));
  }

  it('every card follows the country filter and the header shows "Country: India"', () => {
    useHubFilterStore.setState({ hubId: null, region: 'India' });
    readyAll();
    renderWithProviders(<DashboardPage />);
    expect(hooks.useCompletingWithinYear).toHaveBeenLastCalledWith(null, 'India', NO_SEL);
    expect(hooks.usePipelineTotals).toHaveBeenLastCalledWith(null, 'India', NO_SEL);
    expect(hooks.useStatusOverview).toHaveBeenLastCalledWith(null, 'India', NO_SEL);
    expect(hooks.useHubTypePipeline).toHaveBeenLastCalledWith(null, 'India', NO_SEL);
    expect(hooks.useRegionSummary).toHaveBeenLastCalledWith(null, 'India', NO_SEL);
    expect(hooks.useDashboardProjects).toHaveBeenLastCalledWith(expect.objectContaining({ region: 'India' }));
    expect(capacityHook.useHubLoadVsCapacity).not.toHaveBeenCalled();
    expect(screen.getByTestId('hub-filter-chip')).toHaveTextContent('Country: India');
    expect(screen.getByRole('radio', { name: /India/ })).toHaveAttribute('aria-checked', 'true');
  });

  it('renders the served per-country chips under the status and pipeline cards', () => {
    readyAll();
    hooks.useRegionSummary.mockReturnValue(ready(regionSummary));
    renderWithProviders(<DashboardPage />);
    const inQueue = screen.getByRole('list', { name: 'In Queue by country' });
    // Served count + served share, verbatim (no browser arithmetic).
    expect(inQueue).toHaveTextContent('80');
    expect(inQueue).toHaveTextContent('(80%)');
    expect(screen.getByRole('list', { name: 'Total projects by country' })).toHaveTextContent('(77.12%)');
    const spill = screen.getByRole('list', { name: `Spillover ${String(CARRY_OVER_YEAR)} by country` });
    expect(spill).toHaveTextContent('59');
    expect(spill).toHaveTextContent('(77.63%)');
  });

  it('places the all-projects register directly after the status overview and links to it', () => {
    readyAll();
    renderWithProviders(<DashboardPage />);
    const register = screen.getByTestId('all-projects-register');
    expect(register).toHaveAttribute('id', 'all-projects');
    const statusHeading = screen.getByText('Status overview', { selector: 'h3, [class*="text-h1"]' });
    expect(statusHeading.compareDocumentPosition(register) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('button', { name: /All projects/ })).toBeInTheDocument();
  });
});

describe('DashboardPage — P17-R05 layout and scheduled-count labelling', () => {
  function readyAll() {
    hooks.useCompletingWithinYear.mockReturnValue(ready(withinYear));
    hooks.usePipelineTotals.mockReturnValue(ready(totals));
    hooks.useStatusOverview.mockReturnValue(
      ready({ ...status, other_statuses_counts: { 'In Buyoff': 5, Cancelled: 29 } }),
    );
    hooks.useHubTypePipeline.mockReturnValue(ready(hubType));
  }
  const follows = (a: Node, b: Node): boolean => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

  it('puts the pipeline row first, the status overview second, then everything else', () => {
    readyAll();
    renderWithProviders(<DashboardPage />);
    const pipeline = screen.getByTestId('pipeline-row');
    const statusHeading = screen.getByRole('heading', { name: 'Status overview' });
    const completing = screen.getByRole('heading', { name: 'Completing within the year' });
    const vip = screen.getByTestId('vip-projects-card');
    const header = screen.getByTestId('dashboard-total-projects');
    expect(follows(header, pipeline)).toBe(true);
    expect(follows(pipeline, statusHeading)).toBe(true);
    expect(follows(statusHeading, completing)).toBe(true);
    // P17-R08: VIP is a slim column beside the pipeline row, ahead of Status overview.
    expect(follows(pipeline, vip)).toBe(true);
    expect(follows(vip, statusHeading)).toBe(true);
    expect(follows(statusHeading, screen.getByText('Project pipeline summary: Hub × Type'))).toBe(true);
  });

  it('labels the header chip "scheduled", never "projects", and explains the gap from the served figures', async () => {
    readyAll();
    renderWithProviders(<DashboardPage />);
    const chip = screen.getByTestId('dashboard-total-projects');
    expect(chip).toHaveTextContent('16');
    expect(chip).toHaveTextContent(/scheduled/i);
    expect(chip).not.toHaveTextContent(/projects/i);
    await userEvent.click(within(chip).getByRole('button', { name: /scheduled project count/i }));
    expect(await screen.findByTestId('scheduled-count-note')).toHaveTextContent(
      '16 projects are planned in the active schedule run. The pipeline total is 239. Cancelled (29) and paused (status On Hold) (2) projects are not scheduled.',
    );
  });

  it('keeps the two On Hold figures apart: outcome tile vs served project-status count (P17-R07)', () => {
    readyAll();
    renderWithProviders(<DashboardPage />);
    const tile = screen.getByRole('group', { name: 'On Hold at a stage' });
    expect(within(tile).getByText(/^\d+$/).textContent).toBe('1');
    expect(within(tile).getByTestId('paused-projects-note')).toHaveTextContent(
      'Separately, 2 projects are paused (status On Hold) and are not in the plan.',
    );
    expect(screen.getByRole('region', { name: 'On Hold (project)' })).toBeInTheDocument();
    expect(screen.queryByRole('group', { name: 'On Hold' })).not.toBeInTheDocument();
  });

  it('labels the Completing-within-the-year badge "N scheduled of <pipeline total>" and the pipeline Total separately', () => {
    readyAll();
    renderWithProviders(<DashboardPage />);
    expect(screen.getByTestId('within-year-total-projects')).toHaveTextContent('16 scheduled of 239');
    expect(screen.queryByText(/\d total projects$/)).not.toBeInTheDocument();
    const total = screen.getByRole('region', { name: 'Total projects' });
    expect(within(total).getByTestId('pipeline-count-total')).toHaveTextContent('239');
    expect(within(total).getByTestId('pipeline-caption-total')).toHaveTextContent(/All statuses/);
  });

  it('falls back to "projects" on the chip when no schedule run is active', () => {
    readyAll();
    hooks.useCompletingWithinYear.mockReturnValue(
      ready({ ...withinYear, has_active_schedule_run: false, rows: [] }),
    );
    renderWithProviders(<DashboardPage />);
    expect(screen.getByTestId('dashboard-total-projects')).toHaveTextContent('239projects');
  });
});

const ANALYTICS_R08: DashboardAnalytics = {
  by_type: [{ key: 'NM', count: 3, share_pct: 100 }],
  by_category: [],
  by_hub: [{ key: 'R&D-Greece', count: 3, share_pct: 100 }],
  by_reg_year: [],
  completing_hub_type: [{ hub: 'R&D-Greece', type: 'NM', pipeline_count: 3, completing_count: 1, completing_pct: 33.33 }],
  completing_by_type: [{ key: 'NM', pipeline_count: 3, completing_count: 1, completing_pct: 33.33 }],
  completing_by_hub: [{ key: 'R&D-Greece', pipeline_count: 3, completing_count: 1, completing_pct: 33.33 }],
  has_active_schedule_run: true,
};

describe('DashboardPage — P17-R06/R08 rearrangement', () => {
  const rowsRun: CompletingWithinYear = {
    ...withinYear,
    rows: [
      {
        project_id: 'p1',
        project_name: 'Alpha cooler refresh',
        hub: 'R&D-Greece',
        category: 'A+',
        priority: 'P1',
        within_year: true,
        spillover: false,
        left_out: false,
        blocked: false,
        cat_not_allowed: false,
        last_step_end_week: 40,
        type: null,
        status: 'In Development',
        not_started: false,
      },
    ],
  };
  function readyAll(run: CompletingWithinYear = rowsRun) {
    hooks.useCompletingWithinYear.mockReturnValue(ready(run));
    hooks.usePipelineTotals.mockReturnValue(ready(totals));
    hooks.useStatusOverview.mockReturnValue(ready(status));
    hooks.useHubTypePipeline.mockReturnValue(ready(hubType));
  }
  const follows = (a: Node, b: Node): boolean => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

  it('2026-10-22 order: Status, profile + delivery rate, compact Completing, the Hub × Type row, the register LAST', async () => {
    readyAll();
    hooks.useDashboardAnalytics.mockReturnValue(ready(ANALYTICS_R08));
    renderWithProviders(<DashboardPage />);
    const status = screen.getByRole('heading', { name: 'Status overview' });
    const profile = await screen.findByText('Completion profile', undefined, { timeout: 5000 });
    const gauge = screen.getByRole('heading', { name: 'Delivery rate' });
    const completing = screen.getByRole('heading', { name: 'Completing within the year' });
    const pipelineTable = screen.getByRole('heading', { name: 'Project pipeline summary: Hub × Type' });
    const completingTable = screen.getByRole('heading', { name: 'Completing within year: Hub × Type' });
    const register = screen.getByTestId('all-projects-register');
    expect(follows(status, profile)).toBe(true);
    expect(follows(profile, gauge)).toBe(true);
    expect(follows(gauge, completing)).toBe(true);
    expect(follows(completing, pipelineTable)).toBe(true);
    expect(follows(pipelineTable, completingTable)).toBe(true);
    // The completion outcome donut is gone (its split repeats the cards above).
    expect(screen.queryByText('Completion outcome')).not.toBeInTheDocument();
    // The two tables and the chart share one band.
    const band = pipelineTable.closest('.grid');
    expect(band!.contains(completingTable)).toBe(true);
    const chart = await screen.findByRole('heading', { name: 'Pipeline vs completing' }, { timeout: 5000 });
    expect(band!.contains(chart)).toBe(true);
    await screen.findByRole('heading', { name: 'Portfolio analytics' }, { timeout: 5000 });
    const analytics = await screen.findByRole('heading', { name: 'Analytics & breakdown' }, { timeout: 5000 });
    expect(follows(analytics, register)).toBe(true);
    // Nothing after the register.
    const sections = screen.getAllByRole('heading', { level: 2 }).concat(screen.getAllByRole('heading', { level: 3 }));
    for (const h of sections) {
      if (!register.contains(h)) expect(follows(h, register)).toBe(true);
    }
  });

  it('P17-R08: the Hub × type bar chart is gone; the VIP card sits beside the pipeline row', () => {
    readyAll();
    renderWithProviders(<DashboardPage />);
    expect(screen.queryByLabelText('Project count per hub, split by project type')).not.toBeInTheDocument();
    expect(screen.queryByText('Hub × type pipeline')).not.toBeInTheDocument();
    const vip = screen.getByTestId('vip-projects-card');
    const pipelineBand = screen.getByTestId('pipeline-row').closest('.grid');
    expect(pipelineBand!.contains(vip)).toBe(true);
    expect(follows(vip, screen.getByRole('heading', { name: 'Status overview' }))).toBe(true);
  });

  it('P17-R08: a pipeline cell is a drill-down button', () => {
    readyAll();
    hooks.useDashboardAnalytics.mockReturnValue(ready(ANALYTICS_R08));
    renderWithProviders(<DashboardPage />);
    expect(screen.getByRole('button', { name: 'View 3 New Model projects in R&D-Greece' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View all 3 projects in R&D-Greece' })).toBeInTheDocument();
  });

  it('no longer shows the project outcomes table, the planning clock or the finish-week chart', async () => {
    readyAll();
    renderWithProviders(<DashboardPage />);
    await screen.findByRole('heading', { name: 'Portfolio analytics' }, { timeout: 5000 });
    expect(screen.queryByText('Project outcomes')).not.toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Per-project outcome from the active schedule run' })).not.toBeInTheDocument();
    expect(screen.queryByText('Planning week')).not.toBeInTheDocument();
    expect(screen.queryByText(/of the planning year elapsed/i)).not.toBeInTheDocument();
    expect(screen.queryByText('Finish-week distribution')).not.toBeInTheDocument();
    // The kept analytics cards are still there.
    expect(screen.getByRole('heading', { name: 'Delivery by priority' })).toBeInTheDocument();
    // "N scheduled" appears only as the header chip and the Completing badge.
    expect(screen.queryByText(/^\d+ scheduled$/, { selector: 'span.rounded-pill.bg-text' })).not.toBeInTheDocument();
  });

  it('renders no Planning clock fallback when no schedule run is active', () => {
    readyAll({ ...withinYear, has_active_schedule_run: false, schedule_run_version: null, rows: [] });
    renderWithProviders(<DashboardPage />);
    expect(screen.queryByText('Planning week')).not.toBeInTheDocument();
    expect(screen.getByText('No schedule computed yet')).toBeInTheDocument();
  });
});

describe('DashboardPage — P14 VIP projects card', () => {
  it('sits after the pipeline / KPI cards and before the register, and passes the global filter params', () => {
    hooks.useCompletingWithinYear.mockReturnValue(ready(withinYear));
    hooks.usePipelineTotals.mockReturnValue(ready(totals));
    hooks.useStatusOverview.mockReturnValue(ready(status));
    hooks.useHubTypePipeline.mockReturnValue(ready(hubType));
    useHubFilterStore.setState({ hubId: null, region: 'India' });
    renderWithProviders(<DashboardPage />);
    const vip = screen.getByTestId('vip-projects-card');
    expect(vipHook.useVipBoard).toHaveBeenCalledWith({ region: 'India' });
    const register = screen.getByTestId('all-projects-register');
    expect(vip.compareDocumentPosition(register) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const pipeline = screen.getAllByText('Project pipeline')[0]!;
    // P17-R05: the pipeline row and status overview now lead the page, ahead of the VIP card.
    expect(pipeline.compareDocumentPosition(vip) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('DashboardPage — P13-T10 analytics & breakdown', () => {
  const analytics: DashboardAnalytics = {
    by_type: [{ key: 'CO', count: 89, share_pct: 37.71 }],
    by_category: [{ key: 'B', count: 162, share_pct: 68.64 }],
    by_hub: [{ key: 'PD-India', count: 180, share_pct: 76.27 }],
    by_reg_year: [{ key: '2026', count: 160, share_pct: 67.8 }],
    completing_hub_type: [
      { hub: 'PD-India', type: 'CO', pipeline_count: 82, completing_count: 7, completing_pct: 8.54 },
    ],
    completing_by_type: [{ key: 'CO', pipeline_count: 89, completing_count: 10, completing_pct: 11.24 }],
    completing_by_hub: [{ key: 'PD-India', pipeline_count: 180, completing_count: 14, completing_pct: 7.78 }],
    has_active_schedule_run: true,
  };

  function readyAll() {
    hooks.useCompletingWithinYear.mockReturnValue(ready(withinYear));
    hooks.usePipelineTotals.mockReturnValue(ready(totals));
    hooks.useStatusOverview.mockReturnValue(ready(status));
    hooks.useHubTypePipeline.mockReturnValue(ready(hubType));
  }

  it('follows the global hub / country filter', () => {
    useHubFilterStore.setState({ hubId: null, region: 'Romania' });
    readyAll();
    renderWithProviders(<DashboardPage />);
    expect(hooks.useDashboardAnalytics).toHaveBeenLastCalledWith(null, 'Romania', NO_SEL);
  });

  it('renders the served section after the hub × type pipeline, with the served total in each donut', async () => {
    readyAll();
    hooks.useDashboardAnalytics.mockReturnValue(ready(analytics));
    renderWithProviders(<DashboardPage />);
    const heading = await screen.findByRole('heading', { name: 'Analytics & breakdown' }, { timeout: 5000 });
    const hubType = screen.getAllByText('Project pipeline summary: Hub × Type')[0]!;
    expect(hubType.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Pipeline projects by project type' })).toHaveTextContent(
      'Cost Optimization: 89 (37.71%)',
    );
    expect(screen.getByRole('table', { name: /completing within the year/i })).toHaveTextContent('7 8.54%');
    // Per-hub Total column = served completing_by_hub.
    expect(screen.getByRole('row', { name: /PD-India/ })).toHaveTextContent('14 7.78%');
    // Donut centres show the served PipelineTotals.total_count (239), not a client sum.
    expect(screen.getAllByText('239').length).toBeGreaterThanOrEqual(2);
  });

  it('shows a per-section error without blanking the page', () => {
    readyAll();
    hooks.useDashboardAnalytics.mockReturnValue(failed(new Error('boom')));
    renderWithProviders(<DashboardPage />);
    expect(screen.getByText('The analytics breakdown could not be loaded.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Global RPD Dashboard' })).toBeInTheDocument();
  });
});

/**
 * P28 — Executive view (ADR 0039). The toggle, the view-resolution precedence
 * in situ. (The ADR 0039 §4 hub-load fetch went with "Hubs at a glance",
 * owner ask 2026-10-23: the Executive view no longer requests it.)
 */
describe('DashboardPage — P28 Executive view (ADR 0039)', () => {
  function readyAll(): void {
    hooks.useCompletingWithinYear.mockReturnValue(ready(withinYear));
    hooks.usePipelineTotals.mockReturnValue(ready(totals));
    hooks.useStatusOverview.mockReturnValue(ready(status));
    hooks.useHubTypePipeline.mockReturnValue(ready(hubType));
  }

  it('defaults to Detailed (Super Admin session) and shows the Executive | Detailed radiogroup', () => {
    readyAll();
    renderWithProviders(<DashboardPage />);
    const toggle = screen.getByTestId('dashboard-view-toggle');
    expect(toggle).toHaveAttribute('role', 'radiogroup');
    expect(within(toggle).getByRole('radio', { name: /Detailed/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByTestId('executive-view')).not.toBeInTheDocument();
    expect(screen.getByTestId('all-projects-register')).toBeInTheDocument();
  });

  it('clicking Executive switches the view, persists to localStorage, shows Upcoming completions (no hub-load request), and keeps focus', async () => {
    readyAll();
    const user = userEvent.setup();
    renderWithProviders(<DashboardPage />);
    const execButton = screen.getByTestId('dashboard-view-executive');
    await user.click(execButton);

    expect(screen.getByTestId('executive-view')).toBeInTheDocument();
    // The detailed register is gone; the exec KPI strip is here.
    expect(screen.queryByTestId('all-projects-register')).not.toBeInTheDocument();
    expect(screen.getByTestId('exec-kpi-strip')).toBeInTheDocument();
    // Per-user persistence (ADR 0039 §2).
    expect(window.localStorage.getItem('rpd-dashboard-view')).toBe('executive');
    // Owner ask 2026-10-23: "Upcoming completions" replaced "Hubs at a glance",
    // built from the served within-year rows — no /capacity/hub-load request.
    expect(screen.getByTestId('exec-upcoming-card')).toBeInTheDocument();
    expect(screen.queryByTestId('exec-hubs-card')).not.toBeInTheDocument();
    expect(capacityHook.useHubLoadVsCapacity).not.toHaveBeenCalled();
    // Focus is not lost on the switch (the toggle never unmounts).
    expect(screen.getByTestId('dashboard-view-executive')).toHaveFocus();
    // Switching back re-establishes the Detailed page.
    await user.click(screen.getByTestId('dashboard-view-detailed'));
    expect(screen.queryByTestId('executive-view')).not.toBeInTheDocument();
    expect(window.localStorage.getItem('rpd-dashboard-view')).toBe('detailed');
  });

  it('deep link: ?view=executive on / renders the Executive view (URL beats the stored choice)', () => {
    readyAll();
    window.localStorage.setItem('rpd-dashboard-view', 'detailed');
    renderWithProviders(<DashboardPage />, { route: '/?view=executive' });
    expect(screen.getByTestId('executive-view')).toBeInTheDocument();
    expect(
      within(screen.getByTestId('dashboard-view-toggle')).getByRole('radio', { name: /Executive/ }),
    ).toHaveAttribute('aria-checked', 'true');
  });

  it('stored choice beats the role default', () => {
    readyAll();
    window.localStorage.setItem('rpd-dashboard-view', 'executive');
    renderWithProviders(<DashboardPage />);
    expect(screen.getByTestId('executive-view')).toBeInTheDocument();
  });

  it('role default: roles exactly ["Executive Viewer"] land on Executive; Executive Viewer + another role lands on Detailed', () => {
    readyAll();
    renderWithProviders(<DashboardPage />, { session: { roles: ['Executive Viewer'] } });
    expect(screen.getByTestId('executive-view')).toBeInTheDocument();
  });

  it('role default is Detailed when Executive Viewer is not the only role', () => {
    readyAll();
    renderWithProviders(<DashboardPage />, { session: { roles: ['Executive Viewer', 'Auditor'] } });
    expect(screen.queryByTestId('executive-view')).not.toBeInTheDocument();
  });

  it('the Executive view sends the global hub / country filter on its own reads', () => {
    useHubFilterStore.setState({ hubId: null, region: 'India' });
    readyAll();
    window.localStorage.setItem('rpd-dashboard-view', 'executive');
    renderWithProviders(<DashboardPage />);
    // Overdue check-ins come from the register's endpoint under the same filter,
    // with NO extra filters (ADR 0039 §3).
    expect(hooks.useDashboardProjects).toHaveBeenLastCalledWith({ hub_id: undefined, region: 'India' });
    expect(vipHook.useVipBoard).toHaveBeenCalledWith({ region: 'India' });
  });

  it('no active run: the strip falls back to the pipeline total with a notice; run panels are hidden', () => {
    hooks.useCompletingWithinYear.mockReturnValue(
      ready({ ...withinYear, has_active_schedule_run: false, schedule_run_version: null }),
    );
    hooks.usePipelineTotals.mockReturnValue(ready(totals));
    hooks.useStatusOverview.mockReturnValue(ready(status));
    hooks.useHubTypePipeline.mockReturnValue(ready(hubType));
    window.localStorage.setItem('rpd-dashboard-view', 'executive');
    renderWithProviders(<DashboardPage />);
    expect(screen.getByTestId('exec-no-run-notice')).toBeInTheDocument();
    expect(screen.getByTestId('exec-kpi-pipeline')).toHaveTextContent('239');
    expect(screen.queryByTestId('exec-delivery-gauge')).not.toBeInTheDocument();
    expect(screen.queryByTestId('exec-provenance')).not.toBeInTheDocument();
  });
});

describe('DashboardPage — P31 Dashboard-wide category / type selection', () => {
  function readyAll(): void {
    hooks.useCompletingWithinYear.mockReturnValue(ready(withinYear));
    hooks.usePipelineTotals.mockReturnValue(ready(totals));
    hooks.useStatusOverview.mockReturnValue(ready(status));
    hooks.useHubTypePipeline.mockReturnValue(ready(hubType));
  }

  it('reads repeated URL params and sends them with EVERY Dashboard query; the bar shows them pressed', () => {
    readyAll();
    renderWithProviders(<DashboardPage />, { route: '/?category=A%2B&category=A&type=NM' });
    const sel = expect.objectContaining({ categories: ['A+', 'A'], types: ['NM'] });
    for (const hook of [
      hooks.useCompletingWithinYear,
      hooks.usePipelineTotals,
      hooks.useStatusOverview,
      hooks.useHubTypePipeline,
      hooks.useRegionSummary,
      hooks.useDashboardAnalytics,
      hooks.useCrossFilterBreakdowns,
    ]) {
      expect(hook).toHaveBeenLastCalledWith(null, null, sel);
    }
    // The register (same selection, repeated params).
    expect(hooks.useDashboardProjects).toHaveBeenLastCalledWith(
      expect.objectContaining({ category: ['A+', 'A'], type: ['NM'] }),
    );
    const bar = screen.getByTestId('dashboard-selection-bar');
    const cats = within(bar).getByRole('group', { name: 'Category' });
    expect(within(cats).getByRole('button', { name: 'A+' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(cats).getByRole('button', { name: 'A' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(cats).getByRole('button', { name: 'B' })).toHaveAttribute('aria-pressed', 'false');
    expect(within(cats).getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'false');
    const types = within(bar).getByRole('group', { name: 'Type' });
    expect(within(types).getByRole('button', { name: 'New Model' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(types).getByRole('button', { name: 'Unmapped' })).toBeInTheDocument();
  });

  it('a legacy single-value link still parses; toggling chips re-queries; Clear empties both lists', async () => {
    readyAll();
    const user = userEvent.setup();
    renderWithProviders(<DashboardPage />, { route: '/?category=B' });
    expect(hooks.usePipelineTotals).toHaveBeenLastCalledWith(null, null, expect.objectContaining({ categories: ['B'], types: [] }));
    const bar = screen.getByTestId('dashboard-selection-bar');
    await user.click(within(within(bar).getByRole('group', { name: 'Category' })).getByRole('button', { name: 'A+' }));
    await user.click(within(within(bar).getByRole('group', { name: 'Type' })).getByRole('button', { name: 'Cost Optimization' }));
    // Canonical (option) order, whatever the press order.
    expect(hooks.usePipelineTotals).toHaveBeenLastCalledWith(
      null,
      null,
      expect.objectContaining({ categories: ['A+', 'B'], types: ['CO'] }),
    );
    await user.click(within(bar).getByRole('button', { name: 'Clear' }));
    expect(hooks.usePipelineTotals).toHaveBeenLastCalledWith(null, null, NO_SEL);
    expect(within(bar).queryByRole('button', { name: 'Clear' })).not.toBeInTheDocument();
  });
});


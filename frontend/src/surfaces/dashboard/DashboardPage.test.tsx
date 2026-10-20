import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';

import { renderWithProviders } from '@/test/render';
import { useHubFilterStore } from '@/stores/hub-filter';
import { ApiError } from '@/lib/api/client';
import { ROLE_MATRIX } from '@/test/roles';
import { areaRow, SUMMARY_P11 } from '@/surfaces/capacity/test-fixtures';
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
};

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
}));
vi.mock('@/lib/api/reference', () => ({
  useHubs: () => ({
    data: [
      { id: 'hub-greece', name: 'R&D-Greece', lab_region: 'Greece', is_oem: false },
      { id: 'hub-pdin', name: 'PD-India', lab_region: 'India', is_oem: false },
      { id: 'hub-ro', name: 'PD-Romania', lab_region: 'Romania', is_oem: false },
    ],
  }),
}));
// P11: the "Capacity booked" card shares the Capacity surface's hook.
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
  useHubFilterStore.setState({ hubId: null, region: null });
  vipHook.useVipBoard.mockReturnValue(ready({ run_id: null, pillars: [], areas: [] }));
  hooks.useActiveScheduleRun.mockReturnValue(ready(null));
  hooks.useRegionSummary.mockReturnValue(pending);
  hooks.useProjectFacets.mockReturnValue(ready({ leaders: [], steps: [] }));
  hooks.useDashboardAnalytics.mockReturnValue(pending);
  hooks.useDashboardProjects.mockReturnValue(ready({ total_count: 0, rows: [] }));
  capacityHook.useHubLoadVsCapacity.mockReturnValue(
    ready({ has_active_schedule_run: true, schedule_run_version: 4, remaining_weeks: 47, rows: [], ...SUMMARY_P11, areas: [areaRow()] }),
  );
});

describe('DashboardPage', () => {
  it('P12 (ADR 0020): every card follows the global hub filter and the header shows "Hub: <name>"', () => {
    useHubFilterStore.setState({ hubId: 'hub-greece' });
    hooks.useCompletingWithinYear.mockReturnValue(ready(withinYear));
    hooks.usePipelineTotals.mockReturnValue(ready(totals));
    hooks.useStatusOverview.mockReturnValue(ready(status));
    hooks.useHubTypePipeline.mockReturnValue(ready(hubType));
    renderWithProviders(<DashboardPage />);
    expect(hooks.useCompletingWithinYear).toHaveBeenLastCalledWith('hub-greece', null);
    expect(hooks.usePipelineTotals).toHaveBeenLastCalledWith('hub-greece', null);
    expect(hooks.useStatusOverview).toHaveBeenLastCalledWith('hub-greece', null);
    expect(hooks.useHubTypePipeline).toHaveBeenLastCalledWith('hub-greece', null);
    expect(hooks.useDashboardProjects).toHaveBeenLastCalledWith(expect.objectContaining({ hub_id: 'hub-greece' }));
    expect(capacityHook.useHubLoadVsCapacity).toHaveBeenLastCalledWith({ hubId: 'hub-greece', region: null });
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
    expect(screen.getByText('Hub × type pipeline')).toBeInTheDocument();
    expect(screen.getByText('All registered projects')).toBeInTheDocument();
    // headline within-year figure comes from the I9 endpoint
    expect(screen.getByTestId('schedule-run-provenance')).toHaveTextContent(/v4/);
  });

  it('P11: shows the "Capacity booked" card for a session that can read Capacity', () => {
    hooks.useCompletingWithinYear.mockReturnValue(ready(withinYear));
    hooks.usePipelineTotals.mockReturnValue(ready(totals));
    hooks.useStatusOverview.mockReturnValue(ready(status));
    hooks.useHubTypePipeline.mockReturnValue(ready(hubType));
    renderWithProviders(<DashboardPage />);
    expect(screen.getByTestId('capacity-booked-card')).toBeInTheDocument();
    expect(screen.getByTestId('dash-booked-Europe-design')).toHaveTextContent('72.44 %');
  });

  it('P11: hides the "Capacity booked" card (and never asks for it) without Capacity read', () => {
    hooks.useCompletingWithinYear.mockReturnValue(ready(withinYear));
    hooks.usePipelineTotals.mockReturnValue(ready(totals));
    hooks.useStatusOverview.mockReturnValue(ready(status));
    hooks.useHubTypePipeline.mockReturnValue(ready(hubType));
    // Dashboard read, Capacity none.
    renderWithProviders(<DashboardPage />, {
      session: { roles: ['Engineer'], permissions: { ...ROLE_MATRIX.Engineer, dashboard: { read: true, write: false } } },
    });
    expect(screen.queryByTestId('capacity-booked-card')).not.toBeInTheDocument();
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
    expect(screen.getByText('Hub × type pipeline')).toBeInTheDocument();
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
    expect(hooks.useCompletingWithinYear).toHaveBeenLastCalledWith(null, 'India');
    expect(hooks.usePipelineTotals).toHaveBeenLastCalledWith(null, 'India');
    expect(hooks.useStatusOverview).toHaveBeenLastCalledWith(null, 'India');
    expect(hooks.useHubTypePipeline).toHaveBeenLastCalledWith(null, 'India');
    expect(hooks.useRegionSummary).toHaveBeenLastCalledWith(null, 'India');
    expect(hooks.useDashboardProjects).toHaveBeenLastCalledWith(expect.objectContaining({ region: 'India' }));
    expect(capacityHook.useHubLoadVsCapacity).toHaveBeenLastCalledWith({ hubId: null, region: 'India' });
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

describe('DashboardPage — P14 VIP projects card', () => {
  it('sits after the KPI cards and before the register, and passes the global filter params', () => {
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
    // After the row-1 KPI cards, before the row-2/3 panels.
    expect(vip.compareDocumentPosition(pipeline) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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
    expect(hooks.useDashboardAnalytics).toHaveBeenLastCalledWith(null, 'Romania');
  });

  it('renders the served section after the hub × type pipeline, with the served total in each donut', async () => {
    readyAll();
    hooks.useDashboardAnalytics.mockReturnValue(ready(analytics));
    renderWithProviders(<DashboardPage />);
    const heading = await screen.findByRole('heading', { name: 'Analytics & breakdown' }, { timeout: 5000 });
    const hubType = screen.getAllByText('Hub × type pipeline')[0]!;
    expect(hubType.compareDocumentPosition(heading) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('list', { name: 'Pipeline projects by project type' })).toHaveTextContent(
      'Cost Optimization: 89 (37.71%)',
    );
    expect(screen.getByRole('table', { name: /completing within the year/i })).toHaveTextContent('7 (8.54%)');
    // Per-hub Total column = served completing_by_hub.
    expect(screen.getByRole('row', { name: /PD-India/ })).toHaveTextContent('14 (7.78%)');
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

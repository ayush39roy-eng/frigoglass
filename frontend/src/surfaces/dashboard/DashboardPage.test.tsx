import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';

import { renderWithProviders } from '@/test/render';
import { useHubFilterStore } from '@/stores/hub-filter';
import { ApiError } from '@/lib/api/client';
import { ROLE_MATRIX } from '@/test/roles';
import { areaRow, SUMMARY_P11 } from '@/surfaces/capacity/test-fixtures';
import type {
  CompletingWithinYear,
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
};

vi.mock('./hooks/use-dashboard', () => ({
  useCompletingWithinYear: (...a: unknown[]) => hooks.useCompletingWithinYear(...a),
  usePipelineTotals: (...a: unknown[]) => hooks.usePipelineTotals(...a),
  useStatusOverview: (...a: unknown[]) => hooks.useStatusOverview(...a),
  useHubTypePipeline: (...a: unknown[]) => hooks.useHubTypePipeline(...a),
  useActiveScheduleRun: (...a: unknown[]) => hooks.useActiveScheduleRun(...a),
  useDashboardProjects: (...a: unknown[]) => hooks.useDashboardProjects(...a),
}));
vi.mock('@/lib/api/reference', () => ({ useHubs: () => ({ data: [] }) }));
// P11: the "Capacity booked" card shares the Capacity surface's hook.
const capacityHook = { useHubLoadVsCapacity: vi.fn() };
vi.mock('@/surfaces/capacity/hooks/use-capacity', () => ({
  useHubLoadVsCapacity: (...a: unknown[]) => capacityHook.useHubLoadVsCapacity(...a),
}));

import DashboardPage from './DashboardPage';

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
const totals: PipelineTotals = { spillover_count: 30, new_count: 206, total_count: 236 };
const status: StatusOverview = {
  in_buyoff: 5,
  under_industrialization: 12,
  in_development: 40,
  in_queue: 100,
  other_counts: {},
};
const hubType: HubTypePipelineRow[] = [{ hub: 'R&D-Greece', type: 'NM', count: 3 }];

beforeEach(() => {
  vi.clearAllMocks();
  useHubFilterStore.setState({ hubId: null });
  hooks.useActiveScheduleRun.mockReturnValue(ready(null));
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
    expect(hooks.useCompletingWithinYear).toHaveBeenLastCalledWith('hub-greece');
    expect(hooks.usePipelineTotals).toHaveBeenLastCalledWith('hub-greece');
    expect(hooks.useStatusOverview).toHaveBeenLastCalledWith('hub-greece');
    expect(hooks.useHubTypePipeline).toHaveBeenLastCalledWith('hub-greece');
    expect(hooks.useDashboardProjects).toHaveBeenLastCalledWith(expect.objectContaining({ hub_id: 'hub-greece' }));
    expect(capacityHook.useHubLoadVsCapacity).toHaveBeenLastCalledWith({ hubId: 'hub-greece' });
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
    expect(screen.getByText('Project breakdown')).toBeInTheDocument();
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

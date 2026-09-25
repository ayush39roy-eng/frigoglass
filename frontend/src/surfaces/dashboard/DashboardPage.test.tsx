import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';

import { renderWithProviders } from '@/test/render';
import { ApiError } from '@/lib/api/client';
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
  useCompletingWithinYear: () => hooks.useCompletingWithinYear(),
  usePipelineTotals: () => hooks.usePipelineTotals(),
  useStatusOverview: () => hooks.useStatusOverview(),
  useHubTypePipeline: () => hooks.useHubTypePipeline(),
  useActiveScheduleRun: () => hooks.useActiveScheduleRun(),
  useDashboardProjects: () => hooks.useDashboardProjects(),
}));
vi.mock('@/lib/api/reference', () => ({ useHubs: () => ({ data: [] }) }));

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
  hooks.useActiveScheduleRun.mockReturnValue(ready(null));
  hooks.useDashboardProjects.mockReturnValue(ready({ total_count: 0, rows: [] }));
});

describe('DashboardPage', () => {
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

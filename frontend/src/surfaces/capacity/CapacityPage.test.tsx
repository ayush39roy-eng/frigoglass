import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';

import { renderWithProviders } from '@/test/render';
import { ApiError } from '@/lib/api/client';
import type { ClassBreakdown, HubCapacitySummary, UtilizationMatrix } from './api/types';

const hooks = {
  useHubLoadVsCapacity: vi.fn(),
  useClassBreakdown: vi.fn(),
  useUtilizationMatrix: vi.fn(),
  useActiveScheduleRun: vi.fn(),
};

vi.mock('./hooks/use-capacity', () => ({
  useHubLoadVsCapacity: () => hooks.useHubLoadVsCapacity(),
  useClassBreakdown: () => hooks.useClassBreakdown(),
  useUtilizationMatrix: () => hooks.useUtilizationMatrix(),
  useActiveScheduleRun: () => hooks.useActiveScheduleRun(),
}));
vi.mock('./components/hub-load-chart', () => ({ HubLoadChart: () => <div data-testid="hub-load-chart" /> }));
vi.mock('./components/class-breakdown-chart', () => ({
  ClassBreakdownChart: () => <div data-testid="class-breakdown-chart" />,
}));

import CapacityPage from './CapacityPage';

const pending = { data: undefined, isPending: true, isError: false, error: null, refetch: vi.fn() };
function ready<T>(data: T) {
  return { data, isPending: false, isError: false, error: null, refetch: vi.fn() };
}
function failed(error: Error) {
  return { data: undefined, isPending: false, isError: true, error, refetch: vi.fn() };
}

const hubLoad: HubCapacitySummary = {
  has_active_schedule_run: true,
  schedule_run_version: 6,
  remaining_weeks: 47,
  rows: [
    {
      hub: 'R&D-Greece',
      design_load_weeks: 120,
      design_capacity_weeks: 94.5,
      lab_load_units: 18.5,
      lab_capacity_units: 47,
    },
  ],
};
const classBreakdown: ClassBreakdown = {
  has_active_schedule_run: true,
  schedule_run_version: 6,
  rows: [{ category: 'A+', deliverable_count: 4, left_out_count: 1 }],
};
const utilization: UtilizationMatrix = {
  has_active_schedule_run: true,
  schedule_run_version: 6,
  engineers: [],
  chambers: [
    { chamber_id: 'c1', code: 'GR-1', lab_region: 'Greece', max_concurrent: 2, week_counts: { '33': 2 } },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  hooks.useActiveScheduleRun.mockReturnValue(ready(null));
});

describe('CapacityPage', () => {
  it('always renders the surface heading and the reporting-basis notice', () => {
    hooks.useHubLoadVsCapacity.mockReturnValue(pending);
    hooks.useClassBreakdown.mockReturnValue(pending);
    hooks.useUtilizationMatrix.mockReturnValue(pending);
    renderWithProviders(<CapacityPage />);
    expect(screen.getByRole('heading', { name: 'RPD Capacity' })).toBeInTheDocument();
    expect(screen.getByText('How to read these figures')).toBeInTheDocument();
    expect(screen.getByText(/scheduler overbooked anyone/i)).toBeInTheDocument();
  });

  it('renders every panel from its own schedule-run-sourced payload on success', () => {
    hooks.useHubLoadVsCapacity.mockReturnValue(ready(hubLoad));
    hooks.useClassBreakdown.mockReturnValue(ready(classBreakdown));
    hooks.useUtilizationMatrix.mockReturnValue(ready(utilization));
    renderWithProviders(<CapacityPage />);

    // verbatim I6/I7 load figure from the hub-load endpoint
    expect(screen.getByText('120')).toBeInTheDocument();
    expect(screen.getByText('Class breakdown — deliverable vs. left out')).toBeInTheDocument();
    expect(screen.getByText('Resource utilization matrix')).toBeInTheDocument();
    // the GDPR placeholder is always where the named-engineer view would be
    expect(screen.getByText(/pending GDPR sign-off/i)).toBeInTheDocument();
    // provenance names the exact active run version
    expect(screen.getAllByTestId('schedule-run-provenance')[0]).toHaveTextContent(/v6/);
  });

  it('degrades to an access notice (not a wall of errors) on a 403', () => {
    const forbidden = failed(new ApiError(403, 'forbidden'));
    hooks.useHubLoadVsCapacity.mockReturnValue(forbidden);
    hooks.useClassBreakdown.mockReturnValue(forbidden);
    hooks.useUtilizationMatrix.mockReturnValue(forbidden);
    renderWithProviders(<CapacityPage />);

    expect(screen.getByText(/does not have access to RPD Capacity/i)).toBeInTheDocument();
    expect(screen.queryByText('Resource utilization matrix')).not.toBeInTheDocument();
  });

  it('shows a per-section error with the rest of the surface intact on a non-auth failure', () => {
    hooks.useHubLoadVsCapacity.mockReturnValue(ready(hubLoad));
    hooks.useClassBreakdown.mockReturnValue(failed(new ApiError(500, 'boom')));
    hooks.useUtilizationMatrix.mockReturnValue(ready(utilization));
    renderWithProviders(<CapacityPage />);

    expect(screen.getByRole('alert')).toHaveTextContent(
      /deliverable vs. left-out breakdown could not be loaded/i,
    );
    expect(screen.getByText('Resource utilization matrix')).toBeInTheDocument();
  });

  it('shows the no-schedule-run empty state without erroring', () => {
    const noRun: HubCapacitySummary = {
      has_active_schedule_run: false,
      schedule_run_version: null,
      remaining_weeks: 47,
      rows: [],
    };
    hooks.useHubLoadVsCapacity.mockReturnValue(ready(noRun));
    hooks.useClassBreakdown.mockReturnValue(
      ready({ has_active_schedule_run: false, schedule_run_version: null, rows: [] }),
    );
    hooks.useUtilizationMatrix.mockReturnValue(
      ready({
        has_active_schedule_run: false,
        schedule_run_version: null,
        engineers: [],
        chambers: [],
      }),
    );
    renderWithProviders(<CapacityPage />);
    expect(screen.getAllByText('No schedule computed yet').length).toBeGreaterThan(0);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

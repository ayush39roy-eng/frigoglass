import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import { useHubFilterStore } from '@/stores/hub-filter';
import { ApiError } from '@/lib/api/client';
import type { ClassBreakdown, EngineerUtilizationResponse, HubCapacitySummary, UtilizationMatrix } from './api/types';
import { areaRow, classRow, hubRow, SUMMARY_P11, totalsRow } from './test-fixtures';

const hooks = {
  useHubLoadVsCapacity: vi.fn(),
  useClassBreakdown: vi.fn(),
  useUtilizationMatrix: vi.fn(),
  useActiveScheduleRun: vi.fn(),
  useEngineerUtilization: vi.fn(),
};

vi.mock('./hooks/use-capacity', () => ({
  useHubLoadVsCapacity: (...a: unknown[]) => hooks.useHubLoadVsCapacity(...a),
  useClassBreakdown: (...a: unknown[]) => hooks.useClassBreakdown(...a),
  useUtilizationMatrix: (...a: unknown[]) => hooks.useUtilizationMatrix(...a),
  useActiveScheduleRun: () => hooks.useActiveScheduleRun(),
  useEngineerUtilization: () => hooks.useEngineerUtilization(),
}));
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
  ...SUMMARY_P11,
  remaining_weeks: 47,
  rows: [hubRow({ hub: 'R&D-Greece', lab_region: 'Greece', design_load_weeks: 120 })],
};
const classBreakdown: ClassBreakdown = {
  has_active_schedule_run: true,
  schedule_run_version: 6,
  rows: [classRow({ category: 'A+', deliverable_count: 4, left_out_count: 1, total_count: 5 })],
};
const utilization: UtilizationMatrix = {
  has_active_schedule_run: true,
  schedule_run_version: 6,
  engineers: [],
  chambers: [
    { chamber_id: 'c1', code: 'GR-1', lab_region: 'Greece', max_concurrent: 2, week_counts: { '33': 2 } },
  ],
};

const engUtil: EngineerUtilizationResponse = {
  week_range: [1, 4],
  current_week: 2,
  engineers: [
    {
      id: 'e1', name: 'Priya N', hub: 'R&D-Greece', role: 'Designer', total_booked: 3.5, total_capacity: 4, utilization_pct: 87.5,
      weeks: [1, 2, 3, 4].map((week) => ({ week, booked: 0.5 + week * 0.1, capacity: 1, utilization_pct: 60 + week * 10 })),
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  useHubFilterStore.setState({ hubId: null, region: null });
  hooks.useActiveScheduleRun.mockReturnValue(ready(null));
  hooks.useEngineerUtilization.mockReturnValue(pending);
});

describe('CapacityPage', () => {
  it('P12 (ADR 0020): every panel (incl. the area strip source) follows the global hub filter, with the "Hub:" chip', () => {
    useHubFilterStore.setState({ hubId: 'hub-india' });
    hooks.useHubLoadVsCapacity.mockReturnValue(pending);
    hooks.useClassBreakdown.mockReturnValue(pending);
    hooks.useUtilizationMatrix.mockReturnValue(pending);
    renderWithProviders(<CapacityPage />);
    expect(hooks.useHubLoadVsCapacity).toHaveBeenLastCalledWith({ hubId: 'hub-india', region: null });
    expect(hooks.useClassBreakdown).toHaveBeenLastCalledWith('hub-india', null);
    expect(screen.getByTestId('hub-filter-chip')).toBeInTheDocument();
  });

  it('P13 (ADR 0025): every panel follows the country filter, with the "Country:" chip', () => {
    useHubFilterStore.setState({ hubId: null, region: 'Romania' });
    hooks.useHubLoadVsCapacity.mockReturnValue(pending);
    hooks.useClassBreakdown.mockReturnValue(pending);
    hooks.useUtilizationMatrix.mockReturnValue(pending);
    renderWithProviders(<CapacityPage />);
    expect(hooks.useHubLoadVsCapacity).toHaveBeenLastCalledWith({ hubId: null, region: 'Romania' });
    expect(hooks.useClassBreakdown).toHaveBeenLastCalledWith(null, 'Romania');
    expect(screen.getByTestId('hub-filter-chip')).toHaveTextContent('Country: Romania');
  });

  it('always renders the surface heading and the reporting-basis notice', async () => {
    // P4-T03 hard constraint: the honest-framing callout is carried by this
    // surface in EVERY query state, including while all three panels are still
    // pending. Since the 2026-10-01 client text cleanup it is a popover in the
    // page header rather than a four-paragraph aside, so the affordance is
    // asserted here and its (unchanged) copy is asserted behind it.
    const user = userEvent.setup();
    hooks.useHubLoadVsCapacity.mockReturnValue(pending);
    hooks.useClassBreakdown.mockReturnValue(pending);
    hooks.useUtilizationMatrix.mockReturnValue(pending);
    renderWithProviders(<CapacityPage />);
    expect(screen.getByRole('heading', { name: 'RPD Capacity' })).toBeInTheDocument();

    const notice = screen.getByRole('button', { name: 'How to read these figures' });
    expect(notice).toBeInTheDocument();

    await user.click(notice);
    expect(screen.getByText(/scheduler overbooked anyone/i)).toBeInTheDocument();
  });

  it('P11: leads with the served Europe / India area strip, which follows the horizon toggle', async () => {
    const user = userEvent.setup();
    hooks.useHubLoadVsCapacity.mockReturnValue(
      ready({ ...hubLoad, areas: [areaRow(), areaRow({ area: 'India', hubs: ['PD-India'], lab_regions: ['India'] })] }),
    );
    hooks.useClassBreakdown.mockReturnValue(ready(classBreakdown));
    hooks.useUtilizationMatrix.mockReturnValue(ready(utilization));
    renderWithProviders(<CapacityPage />);
    expect(screen.getAllByTestId('capacity-area-card')).toHaveLength(2);
    expect(screen.getByTestId('area-Europe-design')).toHaveTextContent('72.44 %');
    await user.click(screen.getByRole('radio', { name: 'YTD 2026' }));
    expect(screen.getByTestId('area-strip-horizon')).toHaveTextContent(/Remaining year/);
    expect(screen.getByTestId('area-Europe-design')).toHaveTextContent('108.7 %');
  });

  it('P13-T11: KPI cards and the matrix TOTAL row render the served totals verbatim, following the horizon', async () => {
    const user = userEvent.setup();
    const rows = [
      hubRow({ hub: 'PD-India' }),
      hubRow({
        hub: 'R&D-India',
        design_load_weeks: 16,
        design_load_by_priority: { P1: 16, P2: 0, P3: 0, P4: 0, Queue: 0 },
      }),
    ];
    // Served totals (illustrative, deliberately not the rows' sum: the page must not add rows up).
    const totals = totalsRow({
      hubs: ['PD-India', 'R&D-India'],
      design_load_weeks: 603,
      design_capacity_year: 290.1,
      design_booked_pct_year: 207.86,
      design_booked_pct_remaining: 299.5,
      design_load_by_priority: { P1: 416, P2: 100, P3: 50, P4: 0, Queue: 37 },
    });
    hooks.useHubLoadVsCapacity.mockReturnValue(ready({ ...hubLoad, rows, totals }));
    hooks.useClassBreakdown.mockReturnValue(ready(classBreakdown));
    hooks.useUtilizationMatrix.mockReturnValue(ready(utilization));
    renderWithProviders(<CapacityPage />);

    expect(screen.getByRole('group', { name: 'Design load' })).toHaveTextContent('207.86 %');
    expect(screen.getByTestId('kpi-design-capacity-value')).toHaveTextContent('290.1');
    expect(screen.getByTestId('kpi-Design load-P1')).toHaveTextContent('416');
    expect(screen.getByTestId('kpi-Lab load-P1')).toHaveTextContent('300');
    expect(screen.getByLabelText('Lab load by lab region')).toHaveTextContent('India: 496.5');

    // Matrix (behind its disclosure): one row per hub, served buckets verbatim, served booked % as Util.
    await user.click(screen.getByRole('button', { name: 'Show hub utilization matrix' }));
    expect(screen.getByTestId('util-PD-India-P2-D')).toHaveTextContent('100');
    expect(screen.getByTestId('util-PD-India-Queue-L')).toHaveTextContent('100');
    expect(screen.getByTestId('util-row-PD-India')).toHaveTextContent('232.36 %');
    const total = screen.getByTestId('util-row-total');
    expect(total).toHaveTextContent('603');
    expect(total).toHaveTextContent('207.86 %');

    await user.click(screen.getByRole('radio', { name: 'YTD 2026' }));
    expect(screen.getByTestId('util-row-total')).toHaveTextContent('299.5 %');
    expect(screen.getByRole('group', { name: 'Design load' })).toHaveTextContent('299.5 %');
  });

  it('renders the client layout in order: KPI cards, class cards, charts, booked tiles, summary table, then the collapsed sections', () => {
    hooks.useHubLoadVsCapacity.mockReturnValue(ready({ ...hubLoad, areas: [areaRow()] }));
    hooks.useClassBreakdown.mockReturnValue(ready(classBreakdown));
    renderWithProviders(<CapacityPage />);

    const order = [
      screen.getByTestId('capacity-kpi-row'),
      screen.getByTestId('class-breakdown-panel'),
      screen.getByTestId('load-capacity-charts'),
      screen.getByTestId('area-booking-strip'),
      screen.getByTestId('hub-summary-table'),
      screen.getByTestId('capacity-more-detail'),
    ];
    for (let i = 1; i < order.length; i++) {
      const prev = order[i - 1];
      const next = order[i];
      expect(prev && next && prev.compareDocumentPosition(next) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    // four KPI cards with the served totals
    expect(screen.getByRole('group', { name: 'Design capacity' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Design load' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Lab capacity' })).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Lab load' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Class breakdown — deliverable vs. left out' })).toBeInTheDocument();
    expect(screen.getByText('Design Load vs Capacity by Hub')).toBeInTheDocument();
    // provenance names the exact active run version
    expect(screen.getAllByTestId('schedule-run-provenance')[0]).toHaveTextContent(/v6/);
  });

  it('collapsed sections render and fetch nothing until opened (engineer utilization is audited per read)', async () => {
    const user = userEvent.setup();
    hooks.useHubLoadVsCapacity.mockReturnValue(ready(hubLoad));
    hooks.useClassBreakdown.mockReturnValue(ready(classBreakdown));
    hooks.useUtilizationMatrix.mockReturnValue(ready(utilization));
    hooks.useEngineerUtilization.mockReturnValue(ready(engUtil));
    renderWithProviders(<CapacityPage />);

    expect(hooks.useUtilizationMatrix).not.toHaveBeenCalled();
    expect(hooks.useEngineerUtilization).not.toHaveBeenCalled();
    expect(screen.queryByText('Resource utilization matrix')).not.toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Engineer utilization by week' })).not.toBeInTheDocument();
    expect(screen.queryByText('Priya N')).not.toBeInTheDocument();

    const chambers = screen.getByRole('button', { name: 'Show chamber utilization' });
    expect(chambers).toHaveAttribute('aria-expanded', 'false');
    await user.click(chambers);
    expect(hooks.useUtilizationMatrix).toHaveBeenLastCalledWith(null, null);
    expect(screen.getByText('Resource utilization matrix')).toBeInTheDocument();
    expect(hooks.useEngineerUtilization).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Show engineer utilization' }));
    expect(hooks.useEngineerUtilization).toHaveBeenCalled();
    // ADR 0028: the Engineers x weeks heatmap replaces the old GDPR placeholder
    expect(screen.getByRole('table', { name: 'Engineer utilization by week' })).toBeInTheDocument();
    expect(screen.getByText('Priya N')).toBeInTheDocument();

    // closing hides it again
    await user.click(screen.getByRole('button', { name: 'Hide engineer utilization' }));
    expect(screen.queryByText('Priya N')).not.toBeInTheDocument();
  });

  it('header toggles: YTD 2026 / Full year is the one horizon; Days is disabled (no served weekdays_per_week)', async () => {
    const user = userEvent.setup();
    hooks.useHubLoadVsCapacity.mockReturnValue(ready(hubLoad));
    hooks.useClassBreakdown.mockReturnValue(ready(classBreakdown));
    renderWithProviders(<CapacityPage />);
    expect(screen.getByRole('radio', { name: 'Full year' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Weeks' })).toHaveAttribute('aria-checked', 'true');
    const days = screen.getByRole('radio', { name: 'Days' });
    expect(days).toHaveAttribute('aria-disabled', 'true');
    await user.click(days);
    expect(screen.getByRole('radio', { name: 'Weeks' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: 'Days' })).toHaveAttribute('aria-checked', 'false');
    await user.click(screen.getByRole('radio', { name: 'YTD 2026' }));
    expect(screen.getByRole('radio', { name: 'YTD 2026' })).toHaveAttribute('aria-checked', 'true');
    // the one state drives the KPI card too
    expect(screen.getByTestId('kpi-design-capacity-value')).toHaveTextContent('179.75');
  });

  it('keeps the exports reachable', () => {
    hooks.useHubLoadVsCapacity.mockReturnValue(ready(hubLoad));
    hooks.useClassBreakdown.mockReturnValue(ready(classBreakdown));
    renderWithProviders(<CapacityPage />);
    expect(screen.getByRole('button', { name: /download/i })).toBeInTheDocument();
  });

  it('degrades to an access notice (not a wall of errors) on a 403', () => {
    const forbidden = failed(new ApiError(403, 'forbidden'));
    hooks.useHubLoadVsCapacity.mockReturnValue(forbidden);
    hooks.useClassBreakdown.mockReturnValue(forbidden);
    hooks.useUtilizationMatrix.mockReturnValue(forbidden);
    renderWithProviders(<CapacityPage />);

    expect(screen.getByText(/does not have access to RPD Capacity/i)).toBeInTheDocument();
    expect(screen.queryByTestId('capacity-kpi-row')).not.toBeInTheDocument();
  });

  it('shows a per-section error with the rest of the surface intact on a non-auth failure', () => {
    hooks.useHubLoadVsCapacity.mockReturnValue(ready(hubLoad));
    hooks.useClassBreakdown.mockReturnValue(failed(new ApiError(500, 'boom')));
    hooks.useUtilizationMatrix.mockReturnValue(ready(utilization));
    renderWithProviders(<CapacityPage />);

    expect(screen.getByRole('alert')).toHaveTextContent(
      /deliverable vs. left-out breakdown could not be loaded/i,
    );
    expect(screen.getByTestId('hub-summary-table')).toBeInTheDocument();
  });

  it('shows the no-schedule-run empty state without erroring', () => {
    const noRun: HubCapacitySummary = {
      has_active_schedule_run: false,
      schedule_run_version: null,
      ...SUMMARY_P11,
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

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

  it('P19-T02: capacity booked is per HUB only (no Europe / India areas, even though `areas` is still served), following the horizon', async () => {
    const user = userEvent.setup();
    hooks.useHubLoadVsCapacity.mockReturnValue(
      ready({ ...hubLoad, areas: [areaRow(), areaRow({ area: 'India', hubs: ['PD-India'], lab_regions: ['India'] })] }),
    );
    hooks.useClassBreakdown.mockReturnValue(ready(classBreakdown));
    renderWithProviders(<CapacityPage />);
    expect(screen.queryByTestId('capacity-area-card')).not.toBeInTheDocument();
    expect(screen.queryByText(/Europe/)).not.toBeInTheDocument();
    expect(screen.getAllByTestId(/^booked-hub-/)).toHaveLength(1);
    expect(screen.getByTestId('booked-lab-R&D-Greece')).toHaveTextContent('Lab (Greece region)');
    expect(screen.getByTestId('booked-design-R&D-Greece')).toHaveTextContent('232.36%');
    await user.click(screen.getByRole('radio', { name: 'YTD 2026' }));
    expect(screen.getByTestId('booked-strip-horizon')).toHaveTextContent(/Remaining year/);
    expect(screen.getByTestId('booked-design-R&D-Greece')).toHaveTextContent('326.56%');
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

    // Matrix (inline since P19-T02): one row per hub, served buckets verbatim, served booked % as Util.
    expect(screen.queryByRole('button', { name: 'Show hub utilization matrix' })).not.toBeInTheDocument();
    expect(screen.getByTestId('util-PD-India-P2-D')).toHaveTextContent('100');
    expect(screen.getByTestId('util-PD-India-Queue-L')).toHaveTextContent('100');
    expect(screen.getByTestId('util-row-PD-India')).toHaveTextContent('232.36%');
    const total = screen.getByTestId('util-row-total');
    expect(total).toHaveTextContent('603');
    expect(total).toHaveTextContent('207.86%');

    await user.click(screen.getByRole('radio', { name: 'YTD 2026' }));
    expect(screen.getByTestId('util-row-total')).toHaveTextContent('299.5%');
    expect(screen.getByRole('group', { name: 'Design load' })).toHaveTextContent('299.5 %');
  });

  it('renders the client layout in order: KPI cards, class cards, charts, booked tiles, summary table, inline hub matrix, class chart, then chamber / engineer sections', () => {
    hooks.useHubLoadVsCapacity.mockReturnValue(ready({ ...hubLoad, areas: [areaRow()] }));
    hooks.useClassBreakdown.mockReturnValue(ready(classBreakdown));
    renderWithProviders(<CapacityPage />);

    const order = [
      screen.getByTestId('capacity-kpi-row'),
      screen.getByTestId('class-breakdown-panel'),
      screen.getByTestId('load-capacity-charts'),
      screen.getByTestId('hub-booking-strip'),
      screen.getByTestId('hub-summary-table'),
      screen.getByTestId('section-hub-matrix'),
      // P19-T05 (owner ruling): the class chart moved down, above the chamber / engineer disclosures.
      screen.getByTestId('class-chart-section'),
      screen.getByTestId('section-chambers'),
      screen.getByTestId('section-engineers'),
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
    // the class chart is no longer inside the class cards panel, and stays collapsed
    expect(screen.getByTestId('class-breakdown-panel')).not.toContainElement(screen.getByTestId('class-chart-section'));
    expect(screen.getByRole('button', { name: 'Show class chart' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('class-breakdown-chart')).not.toBeInTheDocument();
    expect(screen.getByText('Design Load vs Capacity by Hub')).toBeInTheDocument();
    // provenance names the exact active run version
    expect(screen.getAllByTestId('schedule-run-provenance')[0]).toHaveTextContent(/v6/);
  });

  it('P19-T02: the hub utilization matrix is inline and expanded (a section with a heading, no disclosure)', () => {
    hooks.useHubLoadVsCapacity.mockReturnValue(ready(hubLoad));
    hooks.useClassBreakdown.mockReturnValue(ready(classBreakdown));
    renderWithProviders(<CapacityPage />);
    const section = screen.getByRole('region', { name: 'Global resource utilization matrix' });
    expect(section).toHaveAttribute('data-testid', 'section-hub-matrix');
    expect(screen.getByRole('heading', { name: 'Global resource utilization matrix' })).toBeInTheDocument();
    expect(screen.getByTestId('util-row-R&D-Greece')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /hub utilization matrix/i })).not.toBeInTheDocument();
    // built from the hub-load rows already on the page: the chamber/engineer reads stay unfetched
    expect(hooks.useUtilizationMatrix).not.toHaveBeenCalled();
    expect(hooks.useEngineerUtilization).not.toHaveBeenCalled();
  });

  it('chamber and engineer sections stay collapsed and fetch nothing until opened (engineer utilization is audited per read)', async () => {
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

  it('P19-T05: Weeks | Days and YTD | Full year are one view state; all four combinations show the served fields', async () => {
    const user = userEvent.setup();
    hooks.useHubLoadVsCapacity.mockReturnValue(ready(hubLoad));
    hooks.useClassBreakdown.mockReturnValue(ready(classBreakdown));
    renderWithProviders(<CapacityPage />);
    const weeks = screen.getByRole('radio', { name: 'Weeks' });
    const days = screen.getByRole('radio', { name: 'Days' });
    expect(weeks).toHaveAttribute('aria-checked', 'true');
    expect(days).toHaveAttribute('aria-checked', 'false');
    expect(days).not.toHaveAttribute('aria-disabled');
    expect(screen.queryByText(/does not serve it|not serve.*yet/i)).not.toBeInTheDocument();

    const cap = (): HTMLElement => screen.getByTestId('kpi-design-capacity-value');
    const booked = (): HTMLElement => screen.getByTestId('booked-design-R&D-Greece');

    // 1. Weeks + Full year
    expect(cap()).toHaveTextContent('252.62');
    expect(screen.getByRole('group', { name: 'Design capacity' })).toHaveTextContent('wks');
    expect(booked()).toHaveTextContent('232.36%');
    expect(booked()).toHaveTextContent('120 of 252.62 engineer-wks');

    // 2. Days + Full year
    await user.click(days);
    expect(days).toHaveAttribute('aria-checked', 'true');
    expect(cap()).toHaveTextContent('1,515.72');
    expect(screen.getByRole('group', { name: 'Design capacity' })).toHaveTextContent('days');
    expect(booked()).toHaveTextContent('232.36%');
    expect(booked()).toHaveTextContent('3,522 of 1,515.72 engineer-days');
    expect(screen.getByTestId('booked-lab-R&D-Greece')).toHaveTextContent('2,979 of 1,117.32 chamber-days');
    expect(screen.getAllByTestId('priority-load-chart-axis').map((e) => e.textContent)).toEqual(['engineer-days', 'chamber-days']);
    expect(screen.getByTestId('util-matrix-unit-note')).toHaveTextContent('Capacity and load in days');
    expect(screen.getByTestId('util-row-R&D-Greece')).toHaveTextContent('1,515.72');
    expect(screen.getByTestId('util-row-total')).toHaveTextContent('3,522');

    // 3. Days + YTD 2026
    await user.click(screen.getByRole('radio', { name: 'YTD 2026' }));
    expect(days).toHaveAttribute('aria-checked', 'true');
    expect(cap()).toHaveTextContent('1,078.5');
    expect(booked()).toHaveTextContent('326.56%');
    expect(booked()).toHaveTextContent('3,522 of 1,078.5 engineer-days');

    // 4. Weeks + YTD 2026
    await user.click(weeks);
    expect(screen.getByRole('radio', { name: 'YTD 2026' })).toHaveAttribute('aria-checked', 'true');
    expect(cap()).toHaveTextContent('179.75');
    expect(booked()).toHaveTextContent('326.56%');
    expect(screen.getByTestId('util-matrix-unit-note')).toHaveTextContent('All values in weeks');
  });

  it('P19-T05: the unit toggle is reachable and operable by keyboard', async () => {
    const user = userEvent.setup();
    hooks.useHubLoadVsCapacity.mockReturnValue(ready(hubLoad));
    hooks.useClassBreakdown.mockReturnValue(ready(classBreakdown));
    renderWithProviders(<CapacityPage />);
    const weeks = screen.getByRole('radio', { name: 'Weeks' });
    // the checked item is the radio group's tab stop (roving tab index); arrows move, Space / Enter select
    weeks.focus();
    expect(weeks).toHaveFocus();
    await user.keyboard('{ArrowRight}');
    const days = screen.getByRole('radio', { name: 'Days' });
    expect(days).toHaveFocus();
    await user.keyboard(' ');
    expect(days).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('kpi-design-capacity-value')).toHaveTextContent('1,515.72');
    await user.keyboard('{ArrowLeft}');
    await user.keyboard('{Enter}');
    expect(screen.getByRole('radio', { name: 'Weeks' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('kpi-design-capacity-value')).toHaveTextContent('252.62');
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

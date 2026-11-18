import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { seriousAxeViolations } from '@/test/axe';
import { renderWithProviders } from '@/test/render';

import type { HubCapacityRow } from '@/surfaces/capacity/api/types';
import { greeceRow, hubRow } from '@/surfaces/capacity/test-fixtures';

const capacityHook = { useHubLoadVsCapacity: vi.fn() };
vi.mock('@/surfaces/capacity/hooks/use-capacity', () => ({
  useHubLoadVsCapacity: (...a: unknown[]) => capacityHook.useHubLoadVsCapacity(...a),
}));

import { HubLoadStrip, LEGEND_TOOLTIP, TO_FINISH_TOOLTIP } from './hub-load-strip';

const ALL = { hubIds: [], regions: [] };

function served(rows: HubCapacityRow[]): void {
  capacityHook.useHubLoadVsCapacity.mockReturnValue({
    data: { has_active_schedule_run: true, rows, near_full_threshold_pct: 85, full_threshold_pct: 100 },
    isPending: false,
    isError: false,
  });
}

function widthOf(testId: string): number {
  return parseFloat(screen.getByTestId(testId).style.width);
}

beforeEach(() => {
  vi.clearAllMocks();
});

/** P45-T02 (D45-1..D45-3). Every figure below is a fixture value as served. */
describe('HubLoadStrip — P45 shading and "To finish" lines', () => {
  it('draws P1 / P2 / other segments from the served split, scaled to the capped served booked %', () => {
    // PD-India: booked 232.36 % → bar 100 %; design 587 = 400 P1 + 100 P2 + 50 P3 + 0 P4 + 37 Q.
    // R&D-Greece at a served 50 % booked: 131 = 60 P1 + 40 P2 + 20 P3 + 0 P4 + 11 Q.
    served([hubRow(), greeceRow({ design_booked_pct_year: 50, design_booking_status_year: 'available' })]);
    renderWithProviders(<HubLoadStrip hub={ALL} enabled />);

    expect(widthOf('hub-load-PD-India-design-seg-P1')).toBeCloseTo((100 * 400) / 587, 6);
    expect(widthOf('hub-load-PD-India-design-seg-P2')).toBeCloseTo((100 * 100) / 587, 6);
    expect(widthOf('hub-load-PD-India-design-seg-P3')).toBeCloseTo((100 * 50) / 587, 6);
    expect(widthOf('hub-load-PD-India-design-seg-P4')).toBe(0);
    expect(widthOf('hub-load-PD-India-design-seg-Queue')).toBeCloseTo((100 * 37) / 587, 6);
    // Lab from the served lab split (496.5 = 300 + 96.5 + 0 + 0 + 100).
    expect(widthOf('hub-load-PD-India-lab-seg-P1')).toBeCloseTo((100 * 300) / 496.5, 6);
    expect(widthOf('hub-load-PD-India-lab-seg-P2')).toBeCloseTo((100 * 96.5) / 496.5, 6);

    expect(widthOf('hub-load-R&D-Greece-design-seg-P1')).toBeCloseTo((50 * 60) / 131, 6);
    expect(widthOf('hub-load-R&D-Greece-design-seg-P2')).toBeCloseTo((50 * 40) / 131, 6);

    // Shades in the bar's booking-status hue: P1 darkest, P2 mid, the rest lightest.
    expect(screen.getByTestId('hub-load-PD-India-design-seg-P1')).toHaveClass('bg-danger');
    expect(screen.getByTestId('hub-load-PD-India-design-seg-P2')).toHaveClass('bg-danger/55');
    expect(screen.getByTestId('hub-load-PD-India-design-seg-Queue')).toHaveClass('bg-danger/25');
    expect(screen.getByTestId('hub-load-R&D-Greece-design-seg-P1')).toHaveClass('bg-success');

    // The numbers text is unchanged; the P1 / P2 weeks are in screen-reader text.
    const design = screen.getByTestId('hub-load-PD-India-design');
    expect(design).toHaveTextContent('587 / 253 wks (232 %)');
    expect(design).toHaveTextContent('P1 400 wks, P2 100 wks');
  });

  it('hides the P1 line when the served P1 need is 0 and shows P1 + P2 when positive', () => {
    served([greeceRow({ lab_need_p1_weeks: 0, lab_need_p1_p2_weeks: 0 })]);
    renderWithProviders(<HubLoadStrip hub={ALL} enabled />);
    const need = screen.getByTestId('hub-load-R&D-Greece-need');
    expect(within(need).queryByText(/^To finish P1:/)).not.toBeInTheDocument();
    expect(within(need).getByText('To finish P1 + P2: +26 wks design')).toBeInTheDocument();
    expect(within(need).getAllByRole('listitem')).toHaveLength(1);
    expect(within(need).queryByText('P1 and P2 fit in the remaining capacity')).not.toBeInTheDocument();
  });

  it('shows every served positive need line, design and lab', () => {
    served([hubRow()]);
    renderWithProviders(<HubLoadStrip hub={ALL} enabled />);
    const lines = within(screen.getByTestId('hub-load-PD-India-need'))
      .getAllByRole('listitem')
      .map((li) => li.textContent);
    expect(lines).toEqual([
      'To finish P1: +120 wks design',
      'To finish P1 + P2: +200 wks design',
      'To finish P1: +118 wks lab',
      'To finish P1 + P2: +198 wks lab',
    ]);
  });

  it('says P1 and P2 fit when all four served need figures are 0', () => {
    served([
      hubRow({ design_need_p1_weeks: 0, design_need_p1_p2_weeks: 0, lab_need_p1_weeks: 0, lab_need_p1_p2_weeks: 0 }),
    ]);
    renderWithProviders(<HubLoadStrip hub={ALL} enabled />);
    const need = screen.getByTestId('hub-load-PD-India-need');
    expect(need).toHaveTextContent('P1 and P2 fit in the remaining capacity');
    expect(within(need).queryByText(/To finish/)).not.toBeInTheDocument();
  });

  it('a positive need under half a week reads "<1", never "+0"', () => {
    served([hubRow({ design_need_p1_weeks: 0, design_need_p1_p2_weeks: 0.3, lab_need_p1_weeks: 0, lab_need_p1_p2_weeks: 0 })]);
    renderWithProviders(<HubLoadStrip hub={ALL} enabled />);
    expect(screen.getByTestId('hub-load-PD-India-need')).toHaveTextContent('To finish P1 + P2: +<1 wks design');
  });

  it('P45-R01: the legend explains the status hue (served thresholds) and the priority shade', () => {
    served([hubRow()]);
    renderWithProviders(<HubLoadStrip hub={ALL} enabled />);
    const legend = screen.getByRole('group', { name: 'Bar colour legend' });
    expect(legend).toHaveTextContent('Full \u2265100%');
    expect(legend).toHaveTextContent('Near full 85\u2013<100%');
    expect(legend).toHaveTextContent('Available <85%');
    expect(legend).toHaveTextContent('Bar colour is the booking status:');
    expect(legend).toHaveTextContent('darker is higher');
    expect(screen.getByTestId('hub-load-legend-full').querySelector('[aria-hidden="true"]')).toHaveClass('bg-danger');
    expect(screen.getByTestId('hub-load-legend-near_full').querySelector('[aria-hidden="true"]')).toHaveClass('bg-warning');
    expect(screen.getByTestId('hub-load-legend-available').querySelector('[aria-hidden="true"]')).toHaveClass('bg-success');
    expect(screen.getByTestId('hub-load-legend-p1').querySelector('[aria-hidden="true"]')).toHaveClass('bg-text-muted');
    expect(screen.getByTestId('hub-load-legend-p2').querySelector('[aria-hidden="true"]')).toHaveClass('bg-text-muted/55');
    expect(screen.getByTestId('hub-load-legend-other')).toHaveTextContent('P3+ / other');
    expect(screen.getByTestId('hub-load-legend-other').querySelector('[aria-hidden="true"]')).toHaveClass('bg-text-muted/25');
  });

  it('explains the need figures in a tooltip', async () => {
    served([hubRow()]);
    const user = userEvent.setup();
    renderWithProviders(<HubLoadStrip hub={ALL} enabled />);
    await user.hover(screen.getByRole('button', { name: 'About the bar colours and To finish figures' }));
    const tip = await screen.findByRole('tooltip');
    expect(tip).toHaveTextContent(TO_FINISH_TOOLTIP);
    expect(tip).toHaveTextContent(LEGEND_TOOLTIP);
    expect(TO_FINISH_TOOLTIP).toBe(
      "Remaining P1/P2 demand vs the hub's remaining capacity this year. The schedule can still leave a project out because of sequencing or engineer eligibility.",
    );
  });

  it('a visible heading names the section; without one the aria-label does', () => {
    served([hubRow()]);
    const { unmount } = renderWithProviders(<HubLoadStrip hub={ALL} enabled heading="Hub demand and capacity" layout="grid" />);
    expect(screen.getByRole('region', { name: 'Hub demand and capacity' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: 'Hub demand and capacity' })).toBeInTheDocument();
    unmount();
    renderWithProviders(<HubLoadStrip hub={ALL} enabled />);
    expect(screen.getByRole('region', { name: 'Design and lab demand per hub, full year' })).toBeInTheDocument();
    expect(screen.queryByRole('heading')).not.toBeInTheDocument();
  });

  it('renders nothing when disabled', () => {
    served([hubRow()]);
    const { container } = renderWithProviders(<HubLoadStrip hub={ALL} enabled={false} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('is axe-clean', async () => {
    served([hubRow(), greeceRow({ design_need_p1_weeks: 0, design_need_p1_p2_weeks: 0, lab_need_p1_weeks: 0, lab_need_p1_p2_weeks: 0 })]);
    const { container } = renderWithProviders(<HubLoadStrip hub={ALL} enabled heading="Hub demand and capacity" layout="grid" />);
    expect(await seriousAxeViolations(container)).toEqual([]);
  });
});

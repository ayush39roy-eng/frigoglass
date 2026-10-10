import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import type { HubCapacitySummary } from '../api/types';
import { hubRow, SUMMARY_P11 } from '../test-fixtures';
import { HubLoadPanel } from './hub-load-panel';

vi.mock('./hub-load-chart', () => ({ HubLoadChart: () => <div data-testid="hub-load-chart" /> }));

const withRun: HubCapacitySummary = {
  has_active_schedule_run: true,
  schedule_run_version: 8,
  ...SUMMARY_P11,
  remaining_weeks: 47,
  rows: [
    hubRow(),
    hubRow({
      hub: 'R&D-Greece',
      lab_region: 'Greece',
      design_load_weeks: 50,
      design_capacity_year: 124.9,
      design_gap_year: -74.9,
      design_completion_pct_year: 2.5,
      lab_load_weeks: 0,
      lab_capacity_year: 72.96,
      lab_gap_year: -72.96,
      lab_completion_pct_year: null,
      chambers: [],
      design_booked_pct_year: 40.03,
      design_booking_status_year: 'available',
      design_booked_pct_remaining: 88.5,
      design_booking_status_remaining: 'near_full',
      lab_booked_pct_year: null,
      lab_booking_status_year: 'available',
      area: 'Europe',
    }),
  ],
};

function card(hub: string): HTMLElement {
  return screen.getByRole('article', { name: hub });
}

describe('HubLoadPanel (ADR 0008 client breakdown)', () => {
  it('renders the I6/I7 load, the estimated load, yearly capacity, gap and completion verbatim, per hub and per resource', () => {
    renderWithProviders(<HubLoadPanel data={withRun} activeRun={undefined} />);
    const india = card('PD-India');
    const design = within(india).getByTestId('capacity-design');
    expect(within(design).getByTestId('design-load')).toHaveTextContent('587');
    expect(within(design).getByTestId('design-load-estimated')).toHaveTextContent('451.5');
    expect(within(design).getByTestId('design-capacity')).toHaveTextContent('252.62');
    expect(within(design).getByTestId('design-gap')).toHaveTextContent('+334.38');
    expect(within(design).getByTestId('design-completion')).toHaveTextContent('43%');
    const lab = within(india).getByTestId('capacity-lab');
    expect(within(lab).getByTestId('lab-load')).toHaveTextContent('496.5');
    expect(within(lab).getByTestId('lab-capacity')).toHaveTextContent('186.22');
    expect(within(lab).getByTestId('lab-completion')).toHaveTextContent('38%');
  });

  it('the horizon toggle switches every figure to the remaining-year fields', async () => {
    const user = userEvent.setup();
    renderWithProviders(<HubLoadPanel data={withRun} activeRun={undefined} />);
    await user.click(screen.getByRole('radio', { name: 'Remaining year' }));
    const design = within(card('PD-India')).getByTestId('capacity-design');
    expect(within(design).getByTestId('design-capacity')).toHaveTextContent('179.75');
    expect(within(design).getByTestId('design-gap')).toHaveTextContent('+407.25');
    expect(within(design).getByTestId('design-completion')).toHaveTextContent('31%');
    expect(within(design).getAllByText('Remaining capacity').length).toBeGreaterThan(0);
  });

  it('flags a shortfall / headroom from the served gap sign with icon + text, not colour alone', () => {
    renderWithProviders(<HubLoadPanel data={withRun} activeRun={undefined} />);
    const india = within(card('PD-India'));
    expect(india.getAllByText('Shortfall')).toHaveLength(2);
    const greece = within(card('R&D-Greece'));
    expect(greece.getAllByText('Headroom')).toHaveLength(2);
  });

  it('shows "—" for completion when the server sends null (load is 0) rather than inventing a figure', () => {
    renderWithProviders(<HubLoadPanel data={withRun} activeRun={undefined} />);
    const lab = within(card('R&D-Greece')).getByTestId('capacity-lab');
    expect(within(lab).getByTestId('lab-completion')).toHaveTextContent('—');
  });

  it('"How this is calculated" shows FTE × working weeks and the per-chamber table from served fields', async () => {
    const user = userEvent.setup();
    renderWithProviders(<HubLoadPanel data={withRun} activeRun={undefined} />);
    const india = card('PD-India');
    await user.click(within(india).getByText('How this is calculated'));
    expect(within(india).getByTestId('design-derivation')).toHaveTextContent(
      '5.75 FTE × 43.93 working weeks = 252.62 engineer-weeks',
    );
    const chamberRow = within(india).getByRole('row', { name: /IN-CH-2/ });
    expect(chamberRow).toHaveTextContent('4');
    expect(chamberRow).toHaveTextContent('0.6');
    expect(chamberRow).toHaveTextContent('35.4');
    expect(chamberRow).toHaveTextContent('84.96');
  });

  it('P11: every hub row shows the served booked % with its status chip (over 100 %, near full, available, null)', () => {
    renderWithProviders(<HubLoadPanel data={withRun} activeRun={undefined} />);
    const indiaDesign = within(card('PD-India')).getByTestId('design-booked');
    expect(indiaDesign).toHaveTextContent('232.36 %');
    expect(within(indiaDesign).getByText('Full')).toBeInTheDocument();
    expect(indiaDesign).toHaveTextContent(/Over-booked/);
    const greeceDesign = within(card('R&D-Greece')).getByTestId('design-booked');
    expect(greeceDesign).toHaveTextContent('40.03 %');
    expect(within(greeceDesign).getByText('Available')).toBeInTheDocument();
    expect(greeceDesign).not.toHaveTextContent(/Over-booked/);
    // capacity 0 would serve null: printed as "—", the served status still shown.
    const greeceLab = within(card('R&D-Greece')).getByTestId('lab-booked');
    expect(greeceLab).toHaveTextContent('—');
    expect(within(greeceLab).getByText('Available')).toBeInTheDocument();
  });

  it('P11: the booked % follows the horizon toggle (remaining-year fields)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<HubLoadPanel data={withRun} activeRun={undefined} />);
    await user.click(screen.getByRole('radio', { name: 'Remaining year' }));
    const greeceDesign = within(card('R&D-Greece')).getByTestId('design-booked');
    expect(greeceDesign).toHaveTextContent('88.5 %');
    expect(within(greeceDesign).getByText('Near full')).toBeInTheDocument();
  });

  it('names the active schedule run the load numbers come from', () => {
    renderWithProviders(<HubLoadPanel data={withRun} activeRun={undefined} />);
    expect(screen.getByTestId('schedule-run-provenance')).toHaveTextContent(/active schedule run\s+v8/i);
  });

  it('shows a non-error empty state when no schedule run is active', () => {
    renderWithProviders(
      <HubLoadPanel
        data={{ has_active_schedule_run: false, schedule_run_version: null, remaining_weeks: 47, rows: [], ...SUMMARY_P11 }}
        activeRun={null}
      />,
    );
    expect(screen.getByText('No schedule computed yet')).toBeInTheDocument();
    expect(screen.queryByTestId('schedule-run-provenance')).not.toBeInTheDocument();
  });
});

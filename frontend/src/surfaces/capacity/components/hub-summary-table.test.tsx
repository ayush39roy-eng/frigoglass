import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import { seriousAxeViolations } from '@/test/axe';
import type { HubCapacitySummary } from '../api/types';
import { hubRow, SUMMARY_P11, totalsRow } from '../test-fixtures';
import { HubSummaryTable } from './hub-summary-table';

const data: HubCapacitySummary = {
  has_active_schedule_run: true,
  schedule_run_version: 8,
  ...SUMMARY_P11,
  totals: totalsRow({ design_load_weeks: 637, design_capacity_year: 377.52, design_booked_pct_year: 168.73 }),
  remaining_weeks: 47,
  rows: [
    hubRow(),
    hubRow({
      hub: 'R&D-Greece',
      lab_region: 'Greece',
      design_load_weeks: 50,
      design_capacity_year: 124.9,
      design_gap_year: -74.9,
      lab_load_weeks: 0,
      lab_capacity_year: 72.96,
      lab_gap_year: -72.96,
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

describe('HubSummaryTable (P19-T01)', () => {
  it('is one compact row per hub with served load, capacity, booked % chip and gap for design and lab', () => {
    renderWithProviders(<HubSummaryTable data={data} activeRun={undefined} horizon="year" />);
    const india = screen.getByTestId('hub-summary-row-PD-India');
    expect(within(india).getByTestId('design-load')).toHaveTextContent('587');
    expect(within(india).getByTestId('design-capacity')).toHaveTextContent('252.62');
    expect(within(india).getByTestId('lab-load')).toHaveTextContent('496.5');
    expect(within(india).getByTestId('lab-capacity')).toHaveTextContent('186.22');
    expect(india).toHaveTextContent('232.36 %');
    expect(india).toHaveTextContent('+334.38');
    const greece = screen.getByTestId('hub-summary-row-R&D-Greece');
    expect(greece).toHaveTextContent('40.03 %');
    expect(greece).toHaveTextContent('-74.9');
    expect(greece).toHaveTextContent('—'); // served null lab booked %
    // the footer is the served totals, not a sum of the rows
    expect(screen.getByTestId('hub-summary-total')).toHaveTextContent('637');
    expect(screen.getByTestId('hub-summary-total')).toHaveTextContent('168.73 %');
    // the long per-hub cards are gone
    expect(screen.queryByTestId('capacity-hub-card')).not.toBeInTheDocument();
    expect(screen.queryByText('Load (process-derived)')).not.toBeInTheDocument();
  });

  it('follows the horizon', () => {
    renderWithProviders(<HubSummaryTable data={data} activeRun={undefined} horizon="remaining" />);
    const india = screen.getByTestId('hub-summary-row-PD-India');
    expect(within(india).getByTestId('design-capacity')).toHaveTextContent('179.75');
    expect(india).toHaveTextContent('326.56 %');
    expect(screen.getByTestId('hub-summary-row-R&D-Greece')).toHaveTextContent('88.5 %');
  });

  it('Details opens a dialog with the full served figures, the bars and "How this is calculated"; Escape closes and returns focus', async () => {
    const user = userEvent.setup();
    renderWithProviders(<HubSummaryTable data={data} activeRun={undefined} horizon="year" />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    const button = screen.getByRole('button', { name: 'Details for PD-India' });
    await user.click(button);
    const dialog = screen.getByRole('dialog', { name: /PD-India/ });
    const design = within(dialog).getByTestId('capacity-design');
    expect(within(design).getByTestId('design-load')).toHaveTextContent('587');
    expect(within(design).getByTestId('design-load-estimated')).toHaveTextContent('451.5');
    expect(within(design).getByTestId('design-capacity')).toHaveTextContent('252.62');
    expect(within(design).getByTestId('design-gap')).toHaveTextContent('+334.38');
    expect(within(design).getByTestId('design-completion')).toHaveTextContent('43%');
    const lab = within(dialog).getByTestId('capacity-lab');
    expect(within(lab).getByTestId('lab-completion')).toHaveTextContent('38%');
    expect(within(dialog).getAllByText('Shortfall')).toHaveLength(2);
    expect(within(dialog).getAllByLabelText(/load versus yearly capacity/i).length).toBeGreaterThan(0);
    expect(within(dialog).getByText('How this is calculated')).toBeInTheDocument();
    expect(within(dialog).getByText('IN-CH-2')).toBeInTheDocument();

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(button).toHaveFocus();
  });

  it('shows the no-run empty state', () => {
    renderWithProviders(
      <HubSummaryTable data={{ ...data, has_active_schedule_run: false, rows: [] }} activeRun={undefined} horizon="year" />,
    );
    expect(screen.getByText('No schedule computed yet')).toBeInTheDocument();
  });

  it('has no serious/critical axe violations', async () => {
    const { container } = renderWithProviders(<HubSummaryTable data={data} activeRun={undefined} horizon="year" />);
    expect(await seriousAxeViolations(container)).toEqual([]);
  });
});

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

describe('HubSummaryTable (P19-T01, P19-T02)', () => {
  it('is one compact row per hub with served load, capacity, booked % chip and gap for design and lab', () => {
    renderWithProviders(<HubSummaryTable data={data} activeRun={undefined} horizon="year" />);
    const india = screen.getByTestId('hub-summary-row-PD-India');
    expect(within(india).getByTestId('design-load')).toHaveTextContent('587');
    expect(within(india).getByTestId('design-capacity')).toHaveTextContent('252.62');
    expect(within(india).getByTestId('lab-load')).toHaveTextContent('496.5');
    expect(within(india).getByTestId('lab-capacity')).toHaveTextContent('186.22');
    expect(india).toHaveTextContent('232.36%');
    expect(india).toHaveTextContent('+334.38');
    const greece = screen.getByTestId('hub-summary-row-R&D-Greece');
    expect(greece).toHaveTextContent('40.03%');
    expect(greece).toHaveTextContent('-74.9');
    expect(greece).toHaveTextContent('—'); // served null lab booked %
    // the footer is the served totals, not a sum of the rows
    expect(screen.getByTestId('hub-summary-total')).toHaveTextContent('637');
    expect(screen.getByTestId('hub-summary-total')).toHaveTextContent('168.73%');
    // the long per-hub cards are gone
    expect(screen.queryByTestId('capacity-hub-card')).not.toBeInTheDocument();
    expect(screen.queryByText('Load (process-derived)')).not.toBeInTheDocument();
  });

  it('follows the horizon', () => {
    renderWithProviders(<HubSummaryTable data={data} activeRun={undefined} horizon="remaining" />);
    const india = screen.getByTestId('hub-summary-row-PD-India');
    expect(within(india).getByTestId('design-capacity')).toHaveTextContent('179.75');
    expect(india).toHaveTextContent('326.56%');
    expect(screen.getByTestId('hub-summary-row-R&D-Greece')).toHaveTextContent('88.5%');
  });

  it('groups hubs by lab region and shows each region\'s served lab figures ONCE, spanning its hub rows', () => {
    const greeceLab = {
      lab_region: 'Greece' as const,
      lab_load_weeks: 22,
      lab_capacity_year: 21.89,
      lab_gap_year: 0.11,
      lab_booked_pct_year: 100.5,
      lab_booking_status_year: 'full' as const,
    };
    const grouped: HubCapacitySummary = {
      ...data,
      rows: [
        hubRow({ hub: 'R&D-Greece', ...greeceLab, design_load_weeks: 45 }),
        hubRow({ hub: 'R&D-India' }),
        hubRow({ hub: 'PD-India' }),
        hubRow({ hub: 'PD-Romania', lab_region: 'Romania', lab_load_weeks: 24 }),
        hubRow({ hub: 'OEM-HCK', ...greeceLab, design_load_weeks: 55 }),
        hubRow({ hub: 'OEM-Seltek', ...greeceLab, design_load_weeks: 44 }),
      ],
    };
    renderWithProviders(<HubSummaryTable data={grouped} activeRun={undefined} horizon="year" />);
    const table = screen.getByTestId('hub-summary-table');
    // one lab figure per region, not per hub
    expect(within(table).getAllByTestId('lab-load')).toHaveLength(3);
    expect(within(table).getAllByTestId('design-load')).toHaveLength(6);

    const greece = screen.getByTestId('hub-summary-region-Greece');
    expect(within(greece).getByRole('rowheader', { name: /Greece lab region/ })).toBeInTheDocument();
    // served order inside the region: R&D-Greece, OEM-HCK, OEM-Seltek
    expect(within(greece).getAllByRole('row').slice(1).map((r) => r.getAttribute('data-testid'))).toEqual([
      'hub-summary-row-R&D-Greece',
      'hub-summary-row-OEM-HCK',
      'hub-summary-row-OEM-Seltek',
    ]);
    const labCells = within(greece).getAllByTestId('lab-load');
    expect(labCells).toHaveLength(1);
    expect(labCells[0]).toHaveTextContent('22');
    expect(labCells[0]).toHaveAttribute('rowspan', '3');
    expect(within(greece).getByTestId('lab-booked')).toHaveTextContent('100.5%');
    expect(within(screen.getByTestId('hub-summary-row-OEM-HCK')).queryByTestId('lab-load')).not.toBeInTheDocument();

    // display order Greece, Romania, India
    const bodies = [...table.querySelectorAll('tbody')].map((b) => b.getAttribute('data-testid'));
    expect(bodies).toEqual(['hub-summary-region-Greece', 'hub-summary-region-Romania', 'hub-summary-region-India']);
    expect(within(screen.getByTestId('hub-summary-region-India')).getAllByTestId('lab-load')).toHaveLength(1);
  });

  it('uses Design / Lab header bands with short sub-headers that keep full accessible names', () => {
    renderWithProviders(<HubSummaryTable data={data} activeRun={undefined} horizon="year" />);
    expect(screen.getByRole('columnheader', { name: 'Design' })).toHaveAttribute('colspan', '4');
    expect(screen.getByRole('columnheader', { name: 'Lab (per lab region)' })).toHaveAttribute('colspan', '4');
    expect(screen.getByRole('columnheader', { name: 'Design capacity, full year' })).toHaveTextContent('Cap.');
    expect(screen.getByRole('columnheader', { name: 'Lab gap' })).toBeInTheDocument();
  });

  it('shows the status as an icon with its label as text for assistive tech, plus a legend with the served thresholds', () => {
    renderWithProviders(<HubSummaryTable data={data} activeRun={undefined} horizon="year" />);
    const india = screen.getByTestId('hub-summary-row-PD-India');
    expect(within(india).getAllByText('Full').length).toBeGreaterThan(0);
    expect(within(india).queryByText('Full', { selector: '.rounded-pill' })).toBeNull();
    const legend = screen.getByTestId('hub-summary-legend');
    expect(legend).toHaveTextContent('Full (100% or more)');
    expect(legend).toHaveTextContent('Near full (85% to under 100%)');
  });

  it('explains why booked % sits near 100% under the header and in the info popover', async () => {
    const user = userEvent.setup();
    renderWithProviders(<HubSummaryTable data={data} activeRun={undefined} horizon="year" />);
    expect(screen.getByTestId('hub-summary-booked-note')).toHaveTextContent(/not capped at capacity/);
    await user.click(screen.getByRole('button', { name: 'How load and capacity are defined' }));
    expect(screen.getAllByText(/spills past W52/).length).toBeGreaterThanOrEqual(2);
  });

  it('every Details trigger is an icon button named for its hub', () => {
    renderWithProviders(<HubSummaryTable data={data} activeRun={undefined} horizon="year" />);
    for (const hub of ['PD-India', 'R&D-Greece']) {
      const b = screen.getByRole('button', { name: `Details for ${hub}` });
      expect(b).toHaveAttribute('aria-haspopup', 'dialog');
      expect(b).not.toHaveTextContent('Details');
    }
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

import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import { seriousAxeViolations } from '@/test/axe';
import type { HubCapacitySummary } from '../api/types';
import { hubRow, SUMMARY_P11, totalsRow } from '../test-fixtures';
import { HubSummaryTable } from './hub-summary-table';

const WEEKS_YEAR = { horizon: 'year', unit: 'weeks' } as const;

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

const greeceLab = {
  lab_region: 'Greece' as const,
  lab_load_weeks: 22,
  lab_capacity_year: 21.89,
  lab_gap_year: 0.11,
  lab_booked_pct_year: 100.5,
  lab_booking_status_year: 'full' as const,
};
/** All six hubs in a deliberately mixed served order. */
const six: HubCapacitySummary = {
  ...data,
  totals: totalsRow({
    hubs: ['R&D-Greece', 'R&D-India', 'PD-India', 'PD-Romania', 'OEM-HCK', 'OEM-Seltek'],
    lab_regions: ['Greece', 'India', 'Romania'],
    design_load_weeks: 1717.55,
    lab_load_weeks: 542.5,
    lab_capacity_year: 290.4,
    lab_booked_pct_year: 186.81,
  }),
  rows: [
    hubRow({ hub: 'OEM-HCK', ...greeceLab, design_load_weeks: 55 }),
    hubRow({ hub: 'PD-India' }),
    hubRow({ hub: 'R&D-Greece', ...greeceLab, design_load_weeks: 45 }),
    hubRow({ hub: 'R&D-India' }),
    hubRow({ hub: 'PD-Romania', lab_region: 'Romania', lab_load_weeks: 24 }),
    hubRow({ hub: 'OEM-Seltek', ...greeceLab, design_load_weeks: 44 }),
  ],
};

describe('HubSummaryTable — "Load vs. capacity by hub" (P19-T06 merged table)', () => {
  it('is titled "Load vs. capacity by hub" and shows served capacity, load, booked % and gap per hub', () => {
    renderWithProviders(<HubSummaryTable data={data} activeRun={undefined} view={WEEKS_YEAR} />);
    expect(screen.getByText('Load vs. capacity by hub')).toBeInTheDocument();
    const india = screen.getByTestId('hub-summary-row-PD-India');
    expect(within(india).getByTestId('design-load')).toHaveTextContent('587');
    expect(within(india).getByTestId('design-capacity')).toHaveTextContent('252.62');
    expect(within(india).getByTestId('lab-load')).toHaveTextContent('496.5');
    expect(within(india).getByTestId('lab-capacity')).toHaveTextContent('186.22');
    expect(within(india).getByTestId('design-booked')).toHaveTextContent('232.36%');
    expect(within(india).getByTestId('design-gap')).toHaveTextContent('+334.38');
    const greece = screen.getByTestId('hub-summary-row-R&D-Greece');
    expect(within(greece).getByTestId('design-booked')).toHaveTextContent('40.03%');
    expect(within(greece).getByTestId('lab-booked')).toHaveTextContent('—'); // served null lab booked %
  });

  it('groups rows by hub family (R&D, PD, OEM) with a group header row, rows in served order inside a family', () => {
    renderWithProviders(<HubSummaryTable data={six} activeRun={undefined} view={WEEKS_YEAR} />);
    const table = screen.getByTestId('hub-summary-table');
    const bodies = [...table.querySelectorAll('tbody')].map((b) => b.getAttribute('data-testid'));
    expect(bodies).toEqual(['hub-summary-family-rd', 'hub-summary-family-pd', 'hub-summary-family-oem']);
    const rowsOf = (key: string): (string | null)[] =>
      within(screen.getByTestId(`hub-summary-family-${key}`))
        .getAllByRole('row')
        .slice(1)
        .map((r) => r.getAttribute('data-testid'));
    expect(within(screen.getByTestId('hub-summary-family-pd')).getByRole('rowheader', { name: 'PD (Product Development)' })).toBeInTheDocument();
    expect(within(screen.getByTestId('hub-summary-family-rd')).getByRole('rowheader', { name: 'R&D' })).toBeInTheDocument();
    expect(rowsOf('rd')).toEqual(['hub-summary-row-R&D-Greece', 'hub-summary-row-R&D-India']);
    expect(rowsOf('pd')).toEqual(['hub-summary-row-PD-India', 'hub-summary-row-PD-Romania']);
    expect(rowsOf('oem')).toEqual(['hub-summary-row-OEM-HCK', 'hub-summary-row-OEM-Seltek']);
    // a scoped (one-family) payload has no empty groups
    renderWithProviders(
      <HubSummaryTable data={{ ...six, rows: [hubRow({ hub: 'OEM-HCK', ...greeceLab })] }} activeRun={undefined} view={WEEKS_YEAR} />,
    );
    const scoped = screen.getAllByTestId('hub-summary-table')[1] as HTMLElement;
    expect([...scoped.querySelectorAll('tbody')].map((b) => b.getAttribute('data-testid'))).toEqual(['hub-summary-family-oem']);
  });

  it('shows each lab region\'s figures ONCE, on its first hub; later hubs of the region show the tag and a shared marker', () => {
    renderWithProviders(<HubSummaryTable data={six} activeRun={undefined} view={WEEKS_YEAR} />);
    const table = screen.getByTestId('hub-summary-table');
    expect(within(table).getAllByTestId('lab-capacity')).toHaveLength(3);
    expect(within(table).getAllByTestId('lab-region')).toHaveLength(6);
    expect(within(table).getAllByTestId('design-load')).toHaveLength(6);

    const rdGreece = screen.getByTestId('hub-summary-row-R&D-Greece');
    expect(within(rdGreece).getByTestId('lab-load')).toHaveTextContent('22');
    expect(within(rdGreece).getByTestId('lab-booked')).toHaveTextContent('100.5%');
    for (const hub of ['OEM-HCK', 'OEM-Seltek']) {
      const r = screen.getByTestId(`hub-summary-row-${hub}`);
      expect(within(r).getByTestId('lab-region')).toHaveTextContent('Greece');
      expect(within(r).queryByTestId('lab-load')).not.toBeInTheDocument();
      expect(within(r).getByTestId('lab-shared')).toHaveTextContent('Same as R&D-Greece above (shared Greece lab region)');
      expect(within(r).getByTestId('lab-shared')).toHaveAttribute('colspan', '4');
    }
    const pdIndia = screen.getByTestId('hub-summary-row-PD-India');
    expect(within(pdIndia).getByTestId('lab-shared')).toHaveTextContent('Same as R&D-India above');
    expect(within(screen.getByTestId('hub-summary-row-R&D-India')).getByTestId('lab-load')).toHaveTextContent('496.5');
    expect(within(screen.getByTestId('hub-summary-row-PD-Romania')).getByTestId('lab-load')).toHaveTextContent('24');
  });

  it('the Total row is the served totals (each lab region once), not a sum of the rows', () => {
    renderWithProviders(<HubSummaryTable data={six} activeRun={undefined} view={WEEKS_YEAR} />);
    const total = screen.getByTestId('hub-summary-total');
    expect(within(total).getByTestId('total-design-load')).toHaveTextContent('1,717.55');
    expect(within(total).getByTestId('total-lab-load')).toHaveTextContent('542.5');
    expect(within(total).getByTestId('total-lab-capacity')).toHaveTextContent('290.4');
    expect(within(total).getByTestId('total-lab-booked')).toHaveTextContent('186.81%');
    expect(within(total).getByTestId('total-lab-regions')).toHaveTextContent('Greece, India, Romania');
    expect(within(total).getAllByText('not served')).toHaveLength(2); // no served total gap
  });

  it('carries the served priority split as a mini-bar in the Load cell, and "Show priority split" reveals the P1..Q columns', async () => {
    const user = userEvent.setup();
    renderWithProviders(<HubSummaryTable data={six} activeRun={undefined} view={{ horizon: 'year', unit: 'days' }} />);
    const india = screen.getByTestId('hub-summary-row-R&D-India');
    expect(within(india).getByRole('img', { name: 'Design load by priority (wks): P1 400, P2 100, P3 50, P4 0, Q 37' })).toBeInTheDocument();
    expect(within(india).getByRole('img', { name: /^Lab load by priority \(wks\): P1 300/ })).toBeInTheDocument();
    expect(screen.queryByTestId('split-R&D-India-P2-D')).not.toBeInTheDocument();

    const toggle = screen.getByRole('button', { name: 'Show priority split' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveAttribute('aria-controls', screen.getByTestId('hub-summary-table').id);
    await user.click(toggle);
    expect(screen.getByRole('button', { name: 'Hide priority split' })).toHaveAttribute('aria-expanded', 'true');
    // served weeks even in Days mode, and labelled so
    expect(screen.getByTestId('split-R&D-India-P2-D')).toHaveTextContent('100');
    expect(screen.getByTestId('split-R&D-India-Queue-L')).toHaveTextContent('100');
    expect(screen.getByRole('columnheader', { name: 'Design load, priority P1, in weeks' })).toHaveTextContent('P1-D');
    expect(screen.getByRole('columnheader', { name: 'Lab load, priority Q, in weeks' })).toHaveTextContent('Q-L');
    expect(screen.getByRole('columnheader', { name: 'Design (per hub)' })).toHaveAttribute('colspan', '9');
    expect(screen.getByRole('columnheader', { name: 'Lab (per lab region)' })).toHaveAttribute('colspan', '10');
    // shared lab rows span the lab split columns too; the total split is the served totals
    expect(within(screen.getByTestId('hub-summary-row-OEM-HCK')).getByTestId('lab-shared')).toHaveAttribute('colspan', '9');
    expect(screen.queryByTestId('split-OEM-HCK-P1-L')).not.toBeInTheDocument();
    expect(screen.getByTestId('split-total-P1-D')).toHaveTextContent('400');

    await user.click(screen.getByRole('button', { name: 'Hide priority split' }));
    expect(screen.queryByTestId('split-R&D-India-P2-D')).not.toBeInTheDocument();
  });

  it('tints booked % by the SERVED status, with the icon and visible label, and a bar with an overflow marker above 100', () => {
    const rows = [
      hubRow({ hub: 'PD-India' }),
      hubRow({ hub: 'PD-Romania', lab_region: 'Romania', design_booked_pct_year: 90, design_booking_status_year: 'near_full' }),
      // served status wins: a value under 85 served as near_full is shown as near_full
      hubRow({ hub: 'R&D-India', design_booked_pct_year: 40, design_booking_status_year: 'available' }),
    ];
    renderWithProviders(<HubSummaryTable data={{ ...data, rows }} activeRun={undefined} view={WEEKS_YEAR} />);
    const full = within(screen.getByTestId('hub-summary-row-PD-India')).getByTestId('design-booked');
    expect(full).toHaveClass('bg-danger-subtle', 'text-danger-subtle-fg');
    expect(full).toHaveAttribute('data-booking-status', 'full');
    expect(within(full).getByTestId('design-booked-label')).toHaveTextContent('Full');
    expect(full.querySelector('svg')).not.toBeNull();
    expect(within(full).getByTestId('booked-overflow')).toBeInTheDocument();

    const near = within(screen.getByTestId('hub-summary-row-PD-Romania')).getByTestId('design-booked');
    expect(near).toHaveClass('bg-warning-subtle');
    expect(near).toHaveTextContent('Near full');
    expect(within(near).queryByTestId('booked-overflow')).not.toBeInTheDocument();

    const avail = within(screen.getByTestId('hub-summary-row-R&D-India')).getByTestId('design-booked');
    expect(avail).toHaveClass('bg-success-subtle');
    expect(avail).toHaveTextContent('Available');

    const legend = screen.getByTestId('hub-summary-legend');
    expect(legend).toHaveTextContent('Full (100% or more)');
    expect(legend).toHaveTextContent('Near full (85% to under 100%)');
  });

  it('gap: over capacity is red with "+", spare is green with "−"', () => {
    renderWithProviders(<HubSummaryTable data={data} activeRun={undefined} view={WEEKS_YEAR} />);
    const over = within(screen.getByTestId('hub-summary-row-PD-India')).getByTestId('design-gap');
    expect(over).toHaveTextContent('+334.38 over capacity');
    expect(over).toHaveClass('text-danger-subtle-fg');
    expect(over).toHaveAttribute('data-gap-sign', 'over');
    const under = within(screen.getByTestId('hub-summary-row-R&D-Greece')).getByTestId('design-gap');
    expect(under).toHaveTextContent('−74.9 spare');
    expect(under).toHaveClass('text-success-subtle-fg');
    expect(within(screen.getByTestId('hub-summary-row-R&D-Greece')).getByTestId('lab-gap')).toHaveTextContent('−72.96');
  });

  it('follows the horizon', () => {
    renderWithProviders(<HubSummaryTable data={data} activeRun={undefined} view={{ horizon: 'remaining', unit: 'weeks' }} />);
    const india = screen.getByTestId('hub-summary-row-PD-India');
    expect(within(india).getByTestId('design-capacity')).toHaveTextContent('179.75');
    expect(india).toHaveTextContent('326.56%');
    expect(within(india).getByTestId('design-gap')).toHaveTextContent('+407.25');
    expect(screen.getByTestId('hub-summary-row-R&D-Greece')).toHaveTextContent('88.5%');
  });

  it('uses Design / Lab header bands with Capacity | Load | Booked % | Gap and full accessible names', () => {
    renderWithProviders(<HubSummaryTable data={data} activeRun={undefined} view={WEEKS_YEAR} />);
    expect(screen.getByRole('columnheader', { name: 'Design (per hub)' })).toHaveAttribute('colspan', '4');
    expect(screen.getByRole('columnheader', { name: 'Lab (per lab region)' })).toHaveAttribute('colspan', '5');
    expect(screen.getByRole('columnheader', { name: 'Design capacity, full year, in weeks' })).toHaveTextContent('Capacity');
    expect(screen.getByRole('columnheader', { name: 'Lab region' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Lab gap, load minus capacity, in weeks' })).toHaveTextContent('Gap');
    const sub = screen.getAllByRole('row')[1] as HTMLElement;
    const visible = [...sub.querySelectorAll('th')].map((h) => h.querySelector('[aria-hidden="true"]')?.textContent ?? h.textContent);
    expect(visible).toEqual(['Capacity', 'Load', 'Booked %', 'Gap', 'Lab region', 'Capacity', 'Load', 'Booked %', 'Gap']);
  });

  it('P19-T05: in days, load / capacity / lab-per-region / Total read the served day fields; booked % and gap (wks) unchanged', async () => {
    const user = userEvent.setup();
    renderWithProviders(<HubSummaryTable data={data} activeRun={undefined} view={{ horizon: 'year', unit: 'days' }} />);
    const india = screen.getByTestId('hub-summary-row-PD-India');
    expect(within(india).getByTestId('design-load')).toHaveTextContent('3,522');
    expect(within(india).getByTestId('design-capacity')).toHaveTextContent('1,515.72');
    expect(within(india).getByTestId('lab-load')).toHaveTextContent('2,979');
    expect(within(india).getByTestId('lab-capacity')).toHaveTextContent('1,117.32');
    expect(india).toHaveTextContent('232.36%'); // booked % is unit-free
    expect(within(india).getByTestId('design-gap')).toHaveTextContent('+334.38'); // gap stays the served weeks
    expect(screen.getByRole('columnheader', { name: 'Design load, in days' })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Design gap, load minus capacity, in weeks' })).toHaveTextContent('Gap (wks)');
    expect(screen.getByTestId('total-design-load')).toHaveTextContent('3,522');
    expect(screen.getByTestId('total-design-capacity')).toHaveTextContent('1,515.72');
    expect(screen.getByTestId('total-lab-load')).toHaveTextContent('2,979');
    expect(screen.getByTestId('total-lab-capacity')).toHaveTextContent('1,117.32');
    expect(screen.getByTestId('total-design-booked')).toHaveTextContent('168.73%');
    expect(screen.getByTestId('hub-summary-unit-note')).toHaveTextContent(/working days/);
    expect(screen.getByTestId('hub-summary-unit-note')).toHaveTextContent(/priority split in weeks/);
    // Details dialog follows the unit too
    await user.click(screen.getByRole('button', { name: 'Details for PD-India' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByTestId('design-load')).toHaveTextContent('3,522');
    expect(within(dialog).getByTestId('design-capacity')).toHaveTextContent('1,515.72');
    expect(within(dialog).getByTestId('lab-capacity')).toHaveTextContent('1,117.32');
    expect(within(dialog).getByTestId('design-gap')).toHaveTextContent('Gap, load − cap. (wks)');
    expect(within(dialog).getByTestId('design-load-estimated')).toHaveTextContent(/\(wks\)/);
    expect(within(dialog).getByTestId('detail-weekdays')).toHaveTextContent('6');
    expect(within(dialog).getByLabelText(/load versus yearly capacity, in engineer-days/)).toBeInTheDocument();
  });

  it('P19-T05: day fields absent on an older API show "—", never a computed value', () => {
    const old = structuredClone(data);
    for (const r of old.rows) {
      const loose = r as unknown as Record<string, unknown>;
      delete loose.capacity_days;
      delete loose.load_days;
      delete loose.lab_capacity_days;
      delete loose.lab_load_days;
    }
    const t = old.totals as unknown as Record<string, unknown>;
    delete t.design_capacity_days;
    delete t.design_load_days;
    delete t.lab_capacity_days;
    delete t.lab_load_days;
    renderWithProviders(<HubSummaryTable data={old} activeRun={undefined} view={{ horizon: 'remaining', unit: 'days' }} />);
    const india = screen.getByTestId('hub-summary-row-PD-India');
    expect(within(india).getByTestId('design-load')).toHaveTextContent('—');
    expect(within(india).getByTestId('design-capacity')).toHaveTextContent('—');
    expect(within(india).getByTestId('lab-load')).toHaveTextContent('—');
    expect(screen.getByTestId('total-design-capacity')).toHaveTextContent('—');
    expect(screen.getByTestId('total-lab-load')).toHaveTextContent('—');
  });

  it('keeps the sticky first column and the labelled scroll region', () => {
    renderWithProviders(<HubSummaryTable data={data} activeRun={undefined} view={WEEKS_YEAR} />);
    expect(screen.getByRole('region', { name: 'Load versus capacity by hub' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('rowheader', { name: 'PD-India' })).toHaveClass('sticky', 'left-0');
    expect(screen.getByTestId('hub-summary-table')).toHaveAttribute('data-sticky-header');
  });

  it('gate D1: the booked note says work weeks (ADR 0032), under the header and in the info popover, with no claim about where figures sit', async () => {
    const user = userEvent.setup();
    renderWithProviders(<HubSummaryTable data={data} activeRun={undefined} view={WEEKS_YEAR} />);
    const note = screen.getByTestId('hub-summary-booked-note');
    expect(note).toHaveTextContent(/Load counts work weeks, including work scheduled past W52/);
    expect(note).toHaveTextContent(/not capped at capacity/);
    expect(note).toHaveTextContent(/Part-time leaders stretch the calendar, not the load/);
    expect(note).toHaveTextContent(/tuned \(ADR 0024\)/);
    expect(note).not.toHaveTextContent(/every scheduled week|near 100/);
    await user.click(screen.getByRole('button', { name: 'How load and capacity are defined' }));
    expect(screen.getAllByText(/Part-time leaders stretch the calendar/).length).toBeGreaterThanOrEqual(2);
  });

  it('every Details trigger is an icon button named for its hub', () => {
    renderWithProviders(<HubSummaryTable data={data} activeRun={undefined} view={WEEKS_YEAR} />);
    for (const hub of ['PD-India', 'R&D-Greece']) {
      const b = screen.getByRole('button', { name: `Details for ${hub}` });
      expect(b).toHaveAttribute('aria-haspopup', 'dialog');
      expect(b).not.toHaveTextContent('Details');
    }
  });

  it('Details opens a dialog with the full served figures, the bars and "How this is calculated"; Escape closes and returns focus', async () => {
    const user = userEvent.setup();
    renderWithProviders(<HubSummaryTable data={data} activeRun={undefined} view={WEEKS_YEAR} />);
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

  it('a hub whose region is shared still opens its own Details', async () => {
    const user = userEvent.setup();
    renderWithProviders(<HubSummaryTable data={six} activeRun={undefined} view={WEEKS_YEAR} />);
    await user.click(screen.getByRole('button', { name: 'Details for OEM-Seltek' }));
    expect(screen.getByRole('dialog', { name: /OEM-Seltek/ })).toBeInTheDocument();
  });

  it('shows the no-run empty state', () => {
    renderWithProviders(
      <HubSummaryTable data={{ ...data, has_active_schedule_run: false, rows: [] }} activeRun={undefined} view={WEEKS_YEAR} />,
    );
    expect(screen.getByText('No schedule computed yet')).toBeInTheDocument();
  });

  it('has no serious/critical axe violations, with the priority split closed and open', async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<HubSummaryTable data={six} activeRun={undefined} view={WEEKS_YEAR} />);
    expect(await seriousAxeViolations(container)).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Show priority split' }));
    expect(await seriousAxeViolations(container)).toEqual([]);
  });
});

describe('P19-T06: the separate hub utilization matrix is gone', () => {
  it('has no hub-utilization-matrix module any more', () => {
    expect(Object.keys(import.meta.glob('./hub-utilization-matrix.tsx'))).toEqual([]);
  });
});

import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import { seriousAxeViolations } from '@/test/axe';
import type { HubCapacitySummary } from '../api/types';
import { greeceRow, hubRow, SUMMARY_P11, totalsRow } from '../test-fixtures';
import { HubSummaryTable } from './hub-summary-table';
import { HubBookingStrip } from './hub-booking-strip';
import { MembersBreakdown } from './capacity-members';

/**
 * P29-T03 (ADR 0042, API_CONTRACT_P29 §2): the four capacity-hub rows, the
 * Greece members breakdown and the OEM hub-filter highlight. Every figure is a
 * served field (fixtures as the server serves them, contract §11).
 */
const WEEKS_YEAR = { horizon: 'year', unit: 'weeks' } as const;
const DAYS_YEAR = { horizon: 'year', unit: 'days' } as const;

function fourRows(greece = greeceRow()): HubCapacitySummary {
  return {
    has_active_schedule_run: true,
    schedule_run_version: 9,
    ...SUMMARY_P11,
    totals: totalsRow({
      hubs: ['PD-India', 'PD-Romania', 'R&D-Greece', 'R&D-India'],
      lab_regions: ['Greece', 'India', 'Romania'],
      design_load_weeks: 970,
    }),
    remaining_weeks: 10,
    // Served order: by capacity-hub name (contract §2.1).
    rows: [
      hubRow({ hub: 'PD-India', design_load_weeks: 500 }),
      hubRow({ hub: 'PD-Romania', lab_region: 'Romania', design_load_weeks: 138 }),
      greece,
      hubRow({ hub: 'R&D-India', design_load_weeks: 201 }),
    ],
  };
}

describe('HubSummaryTable — P29 capacity hubs (ADR 0042)', () => {
  it('shows exactly the four served capacity hubs, no OEM row and no OEM family group', () => {
    renderWithProviders(<HubSummaryTable data={fourRows()} activeRun={undefined} view={WEEKS_YEAR} />);
    const rows = screen.getAllByTestId(/^hub-summary-row-/).map((r) => r.getAttribute('data-testid'));
    expect(rows).toEqual([
      'hub-summary-row-R&D-Greece',
      'hub-summary-row-R&D-India',
      'hub-summary-row-PD-India',
      'hub-summary-row-PD-Romania',
    ]);
    expect(screen.queryByTestId('hub-summary-family-oem')).toBeNull();
    expect(screen.queryByTestId('hub-summary-row-OEM-HCK')).toBeNull();
    expect(screen.queryByTestId('hub-summary-row-OEM-Seitek')).toBeNull();
  });

  it('the Greece row shows its own served load / capacity / booked % and a collapsed members disclosure', () => {
    renderWithProviders(<HubSummaryTable data={fourRows()} activeRun={undefined} view={WEEKS_YEAR} />);
    const greece = screen.getByTestId('hub-summary-row-R&D-Greece');
    expect(within(greece).getByTestId('design-load')).toHaveTextContent('131');
    expect(within(greece).getByTestId('design-capacity')).toHaveTextContent('124.88');
    expect(within(greece).getByTestId('design-booked')).toHaveTextContent('104.9%');
    const toggle = within(greece).getByRole('button', { name: 'Includes OEM-HCK and OEM-Seitek' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByTestId('hub-summary-member-OEM-HCK')).toBeNull();
    // Rows without member hubs carry no disclosure.
    expect(within(screen.getByTestId('hub-summary-row-PD-India')).queryByTestId(/^members-toggle-/)).toBeNull();
  });

  it('opening the disclosure lists every served member with its served project count and design load, and no capacity / booked % / gap', async () => {
    const user = userEvent.setup();
    renderWithProviders(<HubSummaryTable data={fourRows()} activeRun={undefined} view={WEEKS_YEAR} />);
    const toggle = screen.getByTestId('members-toggle-R&D-Greece');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    const subRows = screen.getAllByTestId(/^hub-summary-member-/);
    expect(subRows.map((r) => r.getAttribute('data-testid'))).toEqual([
      'hub-summary-member-R&D-Greece',
      'hub-summary-member-OEM-HCK',
      'hub-summary-member-OEM-Seitek',
    ]);
    expect(toggle).toHaveAttribute('aria-controls', subRows[0]!.id);
    const own = screen.getByTestId('hub-summary-member-R&D-Greece');
    expect(within(own).getByText('(own)')).toBeInTheDocument();
    expect(within(own).getByTestId('member-projects')).toHaveTextContent('3 projects');
    expect(within(own).getByTestId('member-design-load')).toHaveTextContent('32');
    const hck = screen.getByTestId('hub-summary-member-OEM-HCK');
    expect(within(hck).getByTestId('member-projects')).toHaveTextContent('11 projects');
    expect(within(hck).getByTestId('member-design-load')).toHaveTextContent('55');
    expect(within(screen.getByTestId('hub-summary-member-OEM-Seitek')).getByTestId('member-design-load')).toHaveTextContent('44');
    for (const r of subRows) {
      // I19: no per-member capacity exists, so no booked % / status / gap is shown.
      expect(within(r).queryByTestId('design-booked')).toBeNull();
      expect(within(r).queryByTestId('design-capacity')).toBeNull();
      expect(within(r).queryByTestId('design-gap')).toBeNull();
      expect(r.querySelector('[data-booking-status]')).toBeNull();
    }
    await user.click(toggle);
    expect(screen.queryByTestId('hub-summary-member-OEM-HCK')).toBeNull();
  });

  it('never sums the members: a scoped caller sees the full served row total with only their member', async () => {
    const user = userEvent.setup();
    // OEM-HCK-only planner (contract §2.5): full aggregate, one member.
    const scoped = greeceRow({
      members: [{ hub: 'OEM-HCK', own: false, project_count: 11, design_load_weeks: 55, design_load_remaining_weeks: 30, design_load_booked_weeks: 50, booked_project_count: 9 }],
    });
    renderWithProviders(<HubSummaryTable data={fourRows(scoped)} activeRun={undefined} view={WEEKS_YEAR} />);
    const greece = screen.getByTestId('hub-summary-row-R&D-Greece');
    expect(within(greece).getByTestId('design-load')).toHaveTextContent('131');
    await user.click(within(greece).getByRole('button', { name: 'Includes OEM-HCK' }));
    expect(screen.getAllByTestId(/^hub-summary-member-/)).toHaveLength(1);
    expect(screen.queryByText('55', { selector: '[data-testid="design-load"]' })).toBeNull();
  });

  it('a served row with only its own member (R&D-Greece-only caller) has no disclosure', () => {
    const ownOnly = greeceRow({ members: [{ hub: 'R&D-Greece', own: true, project_count: 3, design_load_weeks: 32, design_load_remaining_weeks: 20, design_load_booked_weeks: 28, booked_project_count: 2 }] });
    renderWithProviders(<HubSummaryTable data={fourRows(ownOnly)} activeRun={undefined} view={WEEKS_YEAR} />);
    expect(screen.queryByTestId('members-toggle-R&D-Greece')).toBeNull();
  });

  it('OEM hub filter (selected_member = OEM-HCK): the Greece row is served alone, the breakdown starts open and OEM-HCK is highlighted', () => {
    const data: HubCapacitySummary = {
      ...fourRows(),
      rows: [greeceRow({ selected_member: 'OEM-HCK' })],
    };
    renderWithProviders(<HubSummaryTable data={data} activeRun={undefined} view={WEEKS_YEAR} />);
    expect(screen.getAllByTestId(/^hub-summary-row-/)).toHaveLength(1);
    expect(screen.getByTestId('members-toggle-R&D-Greece')).toHaveAttribute('aria-expanded', 'true');
    const hck = screen.getByTestId('hub-summary-member-OEM-HCK');
    expect(hck).toHaveAttribute('data-selected', 'true');
    expect(within(hck).getByText('selected in the hub filter')).toBeInTheDocument();
    expect(screen.getByTestId('hub-summary-member-OEM-Seitek')).not.toHaveAttribute('data-selected');
    // Figures identical to the unfiltered Greece row (contract §2.3): served, unchanged.
    expect(within(screen.getByTestId('hub-summary-row-R&D-Greece')).getByTestId('design-load')).toHaveTextContent('131');
  });

  it('hub filter = R&D-Greece highlights the own member', () => {
    const data: HubCapacitySummary = { ...fourRows(), rows: [greeceRow({ selected_member: 'R&D-Greece' })] };
    renderWithProviders(<HubSummaryTable data={data} activeRun={undefined} view={WEEKS_YEAR} />);
    expect(screen.getByTestId('hub-summary-member-R&D-Greece')).toHaveAttribute('data-selected', 'true');
  });

  it('Days mode keeps the member loads in weeks and says so', async () => {
    const user = userEvent.setup();
    renderWithProviders(<HubSummaryTable data={fourRows()} activeRun={undefined} view={DAYS_YEAR} />);
    await user.click(screen.getByTestId('members-toggle-R&D-Greece'));
    expect(within(screen.getByTestId('hub-summary-member-OEM-HCK')).getByTestId('member-design-load')).toHaveTextContent('55wks');
  });

  it('sub-rows span the priority split columns too (no ragged rows)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<HubSummaryTable data={fourRows()} activeRun={undefined} view={WEEKS_YEAR} />);
    await user.click(screen.getByTestId('members-toggle-R&D-Greece'));
    await user.click(screen.getByTestId('toggle-priority-split'));
    const colsOf = (row: HTMLElement): number =>
      [...row.children].reduce((n, c) => n + Number((c as HTMLTableCellElement).colSpan || 1), 0);
    expect(colsOf(screen.getByTestId('hub-summary-member-OEM-HCK'))).toBe(colsOf(screen.getByTestId('hub-summary-row-R&D-Greece')));
  });

  it('an older API without `members` renders the row with no disclosure', () => {
    const old = greeceRow();
    // Simulate the pre-P29 payload.
    delete (old as Partial<typeof old>).members;
    renderWithProviders(<HubSummaryTable data={fourRows(old)} activeRun={undefined} view={WEEKS_YEAR} />);
    expect(screen.queryByTestId('members-toggle-R&D-Greece')).toBeNull();
  });

  it('is axe-clean with the members breakdown open', async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(
      <HubSummaryTable data={fourRows(greeceRow({ selected_member: 'OEM-Seitek' }))} activeRun={undefined} view={WEEKS_YEAR} />,
    );
    expect(screen.getByTestId('hub-summary-member-OEM-Seitek')).toBeInTheDocument();
    await user.click(screen.getByTestId('toggle-priority-split'));
    expect(await seriousAxeViolations(container)).toEqual([]);
  });

  it('the Details dialog of the Greece row lists the served members', async () => {
    const user = userEvent.setup();
    renderWithProviders(<HubSummaryTable data={fourRows()} activeRun={undefined} view={WEEKS_YEAR} />);
    await user.click(screen.getByRole('button', { name: 'Details for R&D-Greece' }));
    const dialog = await screen.findByRole('dialog');
    const breakdown = within(dialog).getByTestId('members-breakdown');
    expect(within(breakdown).getByTestId('members-breakdown-OEM-HCK')).toHaveTextContent('OEM-HCK1155');
    expect(within(breakdown).getByTestId('members-breakdown-R&D-Greece')).toHaveTextContent('own');
    expect(within(breakdown).getByText(/Booked %, status and gap exist for the row only/)).toBeInTheDocument();
  });
});

describe('MembersBreakdown (Details dialog)', () => {
  it('renders nothing for a capacity hub with no members', () => {
    const { container } = renderWithProviders(<MembersBreakdown row={hubRow()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('highlights the filter-selected member', () => {
    renderWithProviders(<MembersBreakdown row={greeceRow({ selected_member: 'OEM-Seitek' })} />);
    const row = screen.getByTestId('members-breakdown-OEM-Seitek');
    expect(row).toHaveAttribute('data-selected', 'true');
    expect(within(row).getByText('selected in the hub filter')).toBeInTheDocument();
  });
});

describe('HubBookingStrip — P29 Greece tile', () => {
  it('four tiles, R&D and PD families only; the Greece tile names its member hubs', () => {
    renderWithProviders(<HubBookingStrip rows={fourRows().rows} view={WEEKS_YEAR} />);
    expect(screen.getAllByTestId(/^booked-hub-/)).toHaveLength(4);
    expect(screen.queryByTestId('booked-family-oem')).toBeNull();
    expect(screen.getByTestId('booked-members-R&D-Greece')).toHaveTextContent('Includes OEM-HCK and OEM-Seitek');
    expect(within(screen.getByTestId('booked-design-R&D-Greece')).getByText('104.9%')).toBeInTheDocument();
    expect(screen.queryByTestId('booked-members-PD-India')).toBeNull();
    // Two boxes: two columns, no empty third column at xl.
    expect(screen.getByTestId('booked-families')).toHaveClass('md:grid-cols-2');
    expect(screen.getByTestId('booked-families')).not.toHaveClass('xl:grid-cols-3');
  });

  it('names the selected member hub under an OEM filter', () => {
    renderWithProviders(<HubBookingStrip rows={[greeceRow({ selected_member: 'OEM-HCK' })]} view={WEEKS_YEAR} />);
    expect(screen.getByTestId('booked-selected-R&D-Greece')).toHaveTextContent('Filtered on OEM-HCK');
  });
});

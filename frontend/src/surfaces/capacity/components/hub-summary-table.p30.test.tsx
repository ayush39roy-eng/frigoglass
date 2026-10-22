import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import { seriousAxeViolations } from '@/test/axe';
import type { CapacityHubMember, HubCapacitySummary } from '../api/types';
import { greeceRow, hubRow, SUMMARY_P11, totalsRow } from '../test-fixtures';
import { memberBooked, memberDemand } from '../lib/members';
import { HubSummaryTable } from './hub-summary-table';
import { MembersBreakdown } from './capacity-members';
import { LoadCapacityCharts } from './load-capacity-charts';

/**
 * P30-T03 (ADR 0041, API_CONTRACT_P30 §4, I19 rev.): demand vs booked on the
 * Capacity surfaces. Full year = full-year demand vs yearly capacity; YTD =
 * remaining demand vs remaining capacity; "In plan" = the run-booked weeks,
 * with no % of its kind. Fixtures carry distinct served values for each field
 * so a wrong pairing shows; nothing here is computed by the tests.
 */
const WEEKS_YEAR = { horizon: 'year', unit: 'weeks' } as const;
const WEEKS_REM = { horizon: 'remaining', unit: 'weeks' } as const;

function fourRows(greece = greeceRow()): HubCapacitySummary {
  return {
    has_active_schedule_run: true,
    schedule_run_version: 9,
    ...SUMMARY_P11,
    totals: totalsRow({ hubs: ['PD-India', 'PD-Romania', 'R&D-Greece', 'R&D-India'], lab_regions: ['Greece', 'India', 'Romania'] }),
    remaining_weeks: 10,
    rows: [
      hubRow({ hub: 'PD-India' }),
      hubRow({ hub: 'PD-Romania', lab_region: 'Romania' }),
      greece,
      hubRow({ hub: 'R&D-India' }),
    ],
  };
}

describe('Greece members breakdown (P30)', () => {
  it('sub-rows show each member’s served demand for the horizon and its weeks in plan (never summed)', async () => {
    const user = userEvent.setup();
    const { unmount } = renderWithProviders(<HubSummaryTable data={fourRows()} activeRun={undefined} view={WEEKS_YEAR} />);
    await user.click(screen.getByTestId('members-toggle-R&D-Greece'));
    const hck = screen.getByTestId('hub-summary-member-OEM-HCK');
    expect(within(hck).getByTestId('member-design-load')).toHaveTextContent('55');
    expect(within(hck).getByTestId('member-in-plan')).toHaveTextContent('50');
    expect(within(hck).getByTestId('member-projects')).toHaveTextContent('11 projects, 9 in plan');
    // the row keeps its own served totals
    const greece = screen.getByTestId('hub-summary-row-R&D-Greece');
    expect(within(greece).getByTestId('design-load')).toHaveTextContent('131');
    expect(within(greece).getByTestId('design-in-plan')).toHaveTextContent('118');
    unmount();

    renderWithProviders(<HubSummaryTable data={fourRows()} activeRun={undefined} view={WEEKS_REM} />);
    await user.click(screen.getByTestId('members-toggle-R&D-Greece'));
    const seitek = screen.getByTestId('hub-summary-member-OEM-Seitek');
    expect(within(seitek).getByTestId('member-design-load')).toHaveTextContent('25');
    expect(within(seitek).getByTestId('member-in-plan')).toHaveTextContent('40');
    expect(within(screen.getByTestId('hub-summary-row-R&D-Greece')).getByTestId('design-load')).toHaveTextContent('75');
    // no full-year split bars in the remaining view, so no key for them either
    expect(screen.queryByTestId('priority-legend')).toBeNull();
  });

  it('sub-rows line up with the row’s columns: demand under Demand, in-plan under In plan, nothing per member in Booked % / Gap', async () => {
    const user = userEvent.setup();
    renderWithProviders(<HubSummaryTable data={fourRows()} activeRun={undefined} view={WEEKS_YEAR} />);
    await user.click(screen.getByTestId('members-toggle-R&D-Greece'));
    const row = screen.getByTestId('hub-summary-row-R&D-Greece');
    const sub = screen.getByTestId('hub-summary-member-OEM-HCK');
    const colOf = (tr: HTMLElement, testId: string): number => {
      let col = 0;
      for (const cell of [...tr.children] as HTMLElement[]) {
        if (cell.getAttribute('data-testid') === testId || cell.querySelector(`[data-testid="${testId}"]`)) return col;
        col += Number(cell.getAttribute('colspan') ?? '1');
      }
      return -1;
    };
    expect(colOf(sub, 'member-design-load')).toBe(colOf(row, 'design-load'));
    expect(colOf(sub, 'member-in-plan')).toBe(colOf(row, 'design-in-plan'));
    expect(within(sub).queryByTestId('design-booked')).toBeNull();
    // the sub-row spans the same number of columns as the row
    const width = (tr: HTMLElement): number =>
      ([...tr.children] as HTMLElement[]).reduce((n, c) => n + Number(c.getAttribute('colspan') ?? '1'), 0);
    expect(width(sub)).toBe(width(row));
    await user.click(screen.getByRole('button', { name: 'Show priority split' }));
    expect(width(screen.getByTestId('hub-summary-member-OEM-HCK'))).toBe(width(screen.getByTestId('hub-summary-row-R&D-Greece')));
  });

  it('the Details dialog breakdown names the demand for the horizon and shows the served booked weeks and projects in plan', () => {
    renderWithProviders(<MembersBreakdown row={greeceRow()} horizon="remaining" />);
    const table = screen.getByTestId('members-breakdown');
    expect(within(table).getByRole('columnheader', { name: 'Remaining demand (wks)' })).toBeInTheDocument();
    expect(within(table).getByRole('columnheader', { name: 'In plan (wks)' })).toBeInTheDocument();
    const own = screen.getByTestId('members-breakdown-R&D-Greece');
    expect(within(own).getByTestId('member-design-load')).toHaveTextContent('20');
    expect(within(own).getByTestId('member-in-plan')).toHaveTextContent('28');
    expect(within(own).getByTestId('member-projects-in-plan')).toHaveTextContent('2');
  });

  it('an older API member without the P30 fields shows "—", never a derived figure', () => {
    const legacy = { hub: 'OEM-HCK', own: false, project_count: 11, design_load_weeks: 55 } as unknown as CapacityHubMember;
    expect(memberDemand(legacy, 'year')).toBe(55);
    expect(memberDemand(legacy, 'remaining')).toBeNull();
    expect(memberBooked(legacy)).toBeNull();
  });

  it('has no serious/critical axe violations with the breakdown open, in the remaining view', async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<HubSummaryTable data={fourRows()} activeRun={undefined} view={WEEKS_REM} />);
    await user.click(screen.getByTestId('members-toggle-R&D-Greece'));
    expect(await seriousAxeViolations(container)).toEqual([]);
  });
});

describe('Demand vs capacity charts (P30)', () => {
  it('full year: priority-split columns of the full-year demand; YTD: plain columns of the remaining demand', () => {
    const rows = [hubRow({ hub: 'PD-India' })];
    const { unmount } = renderWithProviders(<LoadCapacityCharts rows={rows} view={WEEKS_YEAR} />);
    expect(screen.getAllByTestId('load-bar-value-PD-India')[0]).toHaveTextContent('587');
    expect(screen.queryByTestId('load-plain-PD-India')).toBeNull();
    expect(screen.getByRole('table', { name: /^Design full-year demand by priority versus capacity/ })).toBeInTheDocument();
    unmount();
    renderWithProviders(<LoadCapacityCharts rows={rows} view={WEEKS_REM} />);
    expect(screen.getByTestId('load-bar-value-PD-India')).toHaveTextContent('436');
    expect(screen.getByTestId('load-plain-PD-India')).toBeInTheDocument();
    const table = screen.getByRole('table', { name: /^Design remaining demand versus capacity/ });
    expect(within(table).getByRole('columnheader', { name: 'Remaining demand (wks)' })).toBeInTheDocument();
    expect(within(table).queryByRole('columnheader', { name: /^P1/ })).toBeNull();
  });
});

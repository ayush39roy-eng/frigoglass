import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { DeliveryByYear } from '@/types/delivery-by-year';

import { DeliveryByYearTable } from './delivery-by-year-table';

const DATA: DeliveryByYear = {
  run_week: 47,
  base_year: 2026,
  within_year_week: 52,
  horizon_weeks: 307,
  horizon_years: 5,
  rows: [
    { kind: 'by_end_of_year', year: 2026, label: 'By end of 2026', indicative: false, p1: 40, p2: 30, p3: 10, total: 80, cum_p1: 40, cum_p2: 30, cum_p3: 10, cum_total: 80, left_out_reasons: null },
    { kind: 'year', year: 2027, label: '2027', indicative: false, p1: 5, p2: 6, p3: 7, total: 18, cum_p1: 45, cum_p2: 36, cum_p3: 17, cum_total: 98, left_out_reasons: null },
    { kind: 'year', year: 2028, label: '2028', indicative: true, p1: 0, p2: 1, p3: 2, total: 3, cum_p1: 45, cum_p2: 37, cum_p3: 19, cum_total: 101, left_out_reasons: null },
    {
      kind: 'not_placed', year: null, label: 'Not placed within 5 years', indicative: false, p1: 1, p2: 0, p3: 1, total: 2,
      cum_p1: null, cum_p2: null, cum_p3: null, cum_total: null,
      left_out_reasons: { no_leader: 1, no_chamber: 0, data_error: 0, beyond_horizon: 1 },
    },
    { kind: 'blocked', year: null, label: 'Blocked', indicative: false, p1: 0, p2: 1, p3: 0, total: 1, cum_p1: null, cum_p2: null, cum_p3: null, cum_total: null, left_out_reasons: null },
  ],
};

describe('DeliveryByYearTable (P53, R53-3)', () => {
  it('prints every served figure verbatim, labels later years "indicative", splits the not-placed reasons', () => {
    render(<DeliveryByYearTable data={DATA} />);
    const rows = screen.getAllByTestId('delivery-row');
    expect(rows.map((r) => r.getAttribute('data-kind'))).toEqual(['by_end_of_year', 'year', 'year', 'not_placed', 'blocked']);
    expect(rows[0]).toHaveTextContent('By end of 2026');
    expect(within(rows[0] as HTMLElement).getAllByRole('cell').map((c) => c.textContent)).toEqual(['40', '30', '10', '80', '40', '30', '10', '80']);
    // Cumulative columns are served (98 = served cum_total), not summed here.
    expect(within(rows[1] as HTMLElement).getAllByRole('cell').at(-1)).toHaveTextContent('98');
    expect(within(rows[2] as HTMLElement).getByTestId('delivery-indicative')).toHaveTextContent('indicative');
    expect(within(rows[1] as HTMLElement).queryByTestId('delivery-indicative')).toBeNull();
    expect(within(rows[3] as HTMLElement).getByTestId('delivery-reasons')).toHaveTextContent(
      'No leader: 1 · Cannot be scheduled within 5 years — check resources: 1',
    );
    expect(within(rows[3] as HTMLElement).getAllByRole('cell').slice(4).map((c) => c.textContent)).toEqual(['—', '—', '—', '—']);
  });

  it('with onOpen each non-zero figure lists its projects (kind × year × band)', async () => {
    const onOpen = vi.fn();
    const user = userEvent.setup();
    render(<DeliveryByYearTable data={DATA} onOpen={onOpen} />);
    await user.click(screen.getByRole('button', { name: /^2027, P2: 6 projects/ }));
    expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ band: 'P2', row: expect.objectContaining({ kind: 'year', year: 2027 }) }), expect.anything());
    // A zero is plain text, not a button.
    expect(screen.queryByRole('button', { name: /^2028, P1:/ })).toBeNull();
  });

  it('a pre-P53 run serves no table: the earlier-rules label is shown instead', () => {
    render(
      <DeliveryByYearTable
        data={null}
        unavailable="pre_p53_run"
        rulesLabel="Computed under the earlier rules (78-week search; queued P3 not counted)"
      />,
    );
    expect(screen.getByTestId('delivery-by-year-unavailable')).toHaveTextContent('Computed under the earlier rules');
  });

  it('shows the served Other column only when it is non-zero', () => {
    const first = DATA.rows[0];
    if (!first) throw new Error('fixture');
    const withOther: DeliveryByYear = {
      ...DATA,
      rows: [{ ...first, other: 1, total: 81, cum_other: 1, cum_total: 81 }, ...DATA.rows.slice(1)],
    };
    const { unmount } = render(<DeliveryByYearTable data={DATA} />);
    expect(screen.queryByRole('columnheader', { name: 'Other' })).toBeNull();
    unmount();
    render(<DeliveryByYearTable data={withOther} />);
    expect(screen.getByRole('columnheader', { name: 'Other' })).toBeInTheDocument();
    const row = screen.getAllByTestId('delivery-row')[0] as HTMLElement;
    expect(within(row).getAllByRole('cell').map((c) => c.textContent)).toEqual(['40', '30', '10', '1', '81', '40', '30', '10', '1', '81']);
  });

  it('tail warnings are counts only (no names)', () => {
    render(<DeliveryByYearTable data={DATA} tailWarnings={{ far_finish_count: 3, leader_overloaded_count: 2 }} />);
    expect(screen.getByTestId('delivery-tail-warnings')).toHaveTextContent('3 projects finish after next year · 2 leaders are booked past next year');
  });
});

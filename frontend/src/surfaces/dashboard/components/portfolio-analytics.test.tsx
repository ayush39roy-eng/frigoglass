import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import type { CompletingWithinYearRow, PriorityDeliveryBand } from '../api/types';
import { seriousAxeViolations } from '@/test/axe';
import { PortfolioAnalytics, PRIORITY_NOTE } from './portfolio-analytics';

function row(
  id: string,
  overrides: Partial<CompletingWithinYearRow> = {},
): CompletingWithinYearRow {
  return {
    project_id: id,
    project_name: `Project ${id}`,
    hub: 'R&D-Greece',
    category: 'A+',
    priority: 'P1',
    within_year: true,
    spillover: false,
    left_out: false,
    blocked: false,
    cat_not_allowed: false,
    last_step_end_week: 40,
    type: null,
    status: 'In Development',
    not_started: false,
    ...overrides,
  };
}

function band(
  priority: PriorityDeliveryBand['priority'],
  o: Partial<PriorityDeliveryBand> = {},
): PriorityDeliveryBand {
  return {
    priority,
    total: 0,
    within_year: 0,
    in_flight_total: 0,
    in_flight_within_year: 0,
    not_started_total: 0,
    not_started_within_year: 0,
    delivered_total: 0,
    delivered_within_year: 0,
    other_total: 0,
    within_year_share_pct: 0,
    in_flight_within_year_share_pct: 0,
    not_started_within_year_share_pct: 0,
    in_flight_share_pct: 0,
    not_started_share_pct: 0,
    delivered_share_pct: 0,
    other_share_pct: 0,
    ...o,
  };
}

// Audited shape of the client data: P1 has 13 not started; P3 all in flight;
// P4 has 17 Commercialized and 43 On Hold/Cancelled/Draft.
const BANDS: PriorityDeliveryBand[] = [
  band('P1', { total: 25, within_year: 19, in_flight_total: 12, in_flight_within_year: 12, in_flight_within_year_share_pct: 100, not_started_total: 13, not_started_within_year: 7, not_started_within_year_share_pct: 53.85 }),
  band('P2', { total: 6, within_year: 4, in_flight_total: 1, in_flight_within_year: 1, in_flight_within_year_share_pct: 100, not_started_total: 4, not_started_within_year: 3, not_started_within_year_share_pct: 75, other_total: 1 }),
  band('P3', { total: 94, within_year: 92, in_flight_total: 94, in_flight_within_year: 92, in_flight_within_year_share_pct: 97.87 }),
  band('P4', { total: 128, within_year: 43, not_started_total: 68, not_started_within_year: 26, not_started_within_year_share_pct: 38.24, delivered_total: 17, delivered_within_year: 17, other_total: 43 }),
  band('Q'),
];

function bandSum(b: PriorityDeliveryBand): number {
  return b.in_flight_total + b.not_started_total + b.delivered_total + b.other_total;
}

describe('PortfolioAnalytics', () => {
  it('renders both views of the same (no finish-week chart, P17-R06) completing-within-year rows', () => {
    renderWithProviders(<PortfolioAnalytics rows={[row('a')]} priorityDelivery={BANDS} />);
    expect(screen.getByRole('heading', { name: 'Portfolio analytics' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Finish-week distribution' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Delivery by priority' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Outcomes by hub' })).toBeInTheDocument();
  });

  it('shows in-flight and not-started parts per band from the served fields', () => {
    renderWithProviders(<PortfolioAnalytics rows={[row('a')]} priorityDelivery={BANDS} />);
    expect(screen.getByText('P1 · in flight 12 of 12 · not started 7 of 13')).toBeInTheDocument();
    expect(screen.getByText('P3 · in flight 92 of 94 · not started 0 of 0')).toBeInTheDocument();
    // Headline is the served in-flight share, not a browser division.
    expect(screen.getAllByText('100%').length).toBeGreaterThan(0);
    expect(screen.getByText('98%')).toBeInTheDocument();
  });

  it('band parts add up to the band total shown', () => {
    renderWithProviders(<PortfolioAnalytics rows={[row('a')]} priorityDelivery={BANDS} />);
    for (const b of BANDS.filter((x) => x.total > 0)) {
      expect(bandSum(b)).toBe(b.total);
      const item = screen.getByRole('listitem', { name: new RegExp(`^${b.priority}: `) });
      expect(item).toHaveTextContent(`${String(b.total)} projects`);
    }
  });

  it('keeps delivered and not-in-plan out of the rings and lists them as muted lines', () => {
    renderWithProviders(<PortfolioAnalytics rows={[row('a')]} priorityDelivery={BANDS} />);
    const p4 = screen.getByRole('listitem', { name: /^P4: / });
    expect(within(p4).getByText('Already delivered: 17')).toBeInTheDocument();
    expect(within(p4).getByText('Not in plan: 43')).toBeInTheDocument();
    // P4 has nothing in flight: no headline percentage and no ring for it.
    expect(within(p4).getByText('P4 · in flight 0 of 0 · not started 26 of 68')).toBeInTheDocument();
    expect(within(p4).queryByText(/%$/)).not.toBeInTheDocument();
    expect(screen.queryByText('Already delivered: 0')).not.toBeInTheDocument();
    expect(screen.getAllByText(/Already delivered/)).toHaveLength(1);
  });

  it('prints the not-started note on the card and in the info popover', async () => {
    renderWithProviders(<PortfolioAnalytics rows={[row('a')]} priorityDelivery={BANDS} />);
    expect(screen.getByTestId('priority-delivery-note')).toHaveTextContent(PRIORITY_NOTE);
    await userEvent.click(screen.getByRole('button', { name: 'About Delivery by priority' }));
    expect(await screen.findAllByText(PRIORITY_NOTE)).toHaveLength(2);
  });

  it('has no serious or critical axe violations in the priority card', async () => {
    const { container } = renderWithProviders(
      <PortfolioAnalytics rows={[row('a')]} priorityDelivery={BANDS} />,
    );
    expect(await seriousAxeViolations(container)).toEqual([]);
  });

  it('hides empty bands rather than printing an empty ring', () => {
    renderWithProviders(<PortfolioAnalytics rows={[row('a')]} priorityDelivery={BANDS} />);
    expect(screen.queryByRole('listitem', { name: /^Q: / })).not.toBeInTheDocument();
    expect(screen.getAllByRole('listitem', { name: /^P\d: / })).toHaveLength(4);
  });

  it('renders a hub-filtered payload (fewer bands) without the unfiltered ones', () => {
    const filtered = [band('P1', { total: 3, within_year: 3, in_flight_total: 3, in_flight_within_year: 3, in_flight_within_year_share_pct: 100 }), band('P2'), band('P3'), band('P4'), band('Q')];
    renderWithProviders(<PortfolioAnalytics rows={[row('a')]} priorityDelivery={filtered} />);
    expect(screen.getByText('P1 · in flight 3 of 3 · not started 0 of 0')).toBeInTheDocument();
    expect(screen.queryByRole('listitem', { name: /^P3: / })).not.toBeInTheDocument();
  });

  it('says so when no band has projects', () => {
    renderWithProviders(<PortfolioAnalytics rows={[row('a')]} priorityDelivery={BANDS.map((b) => band(b.priority))} />);
    expect(screen.getByText('No prioritised projects in this run.')).toBeInTheDocument();
  });

  it('stacks each hub by the shared outcome precedence — blocked wins over within_year', () => {
    renderWithProviders(
      <PortfolioAnalytics
        rows={[
          // Both flags set: `outcomeOf` must file this under blocked, exactly as
          // the backend's `blocked_count` does (P9-F02), so the chart cannot
          // disagree with the KPI tiles above it.
          row('a', { hub: 'PD-India', within_year: true, blocked: true }),
          row('b', { hub: 'PD-India', within_year: true }),
        ]}
        priorityDelivery={BANDS}
      />,
    );
    const list = screen.getByRole('list', { name: 'Outcome counts per hub' });
    expect(within(list).getByText('PD-India')).toBeInTheDocument();
    expect(within(list).getByTitle('PD-India: 1 on hold')).toBeInTheDocument();
    expect(within(list).getByTitle('PD-India: 1 within year')).toBeInTheDocument();
  });

  it('orders hubs by how many projects each has in the run', () => {
    renderWithProviders(
      <PortfolioAnalytics
        rows={[
          row('a', { hub: 'R&D-Greece' }),
          row('b', { hub: 'PD-India' }),
          row('c', { hub: 'PD-India' }),
          row('d', { hub: 'PD-India' }),
        ]}
        priorityDelivery={BANDS}
      />,
    );
    const items = within(screen.getByRole('list', { name: 'Outcome counts per hub' })).getAllByRole(
      'listitem',
    );
    expect(items[0]).toHaveTextContent('PD-India');
    expect(items[0]).toHaveTextContent('3');
    expect(items[1]).toHaveTextContent('R&D-Greece');
  });

  it('exposes each chart definition behind a named affordance rather than as body copy', () => {
    renderWithProviders(<PortfolioAnalytics rows={[row('a')]} priorityDelivery={BANDS} />);
    expect(screen.queryByRole('button', { name: 'About Finish-week distribution' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'About Delivery by priority' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'About Outcomes by hub' })).toBeInTheDocument();
  });

  it('shows no engineer, owner or avatar anywhere (OPEN_QUESTIONS #8)', () => {
    renderWithProviders(<PortfolioAnalytics rows={[row('a'), row('b', { hub: 'PD-India' })]} priorityDelivery={BANDS} />);
    expect(document.querySelectorAll('img')).toHaveLength(0);
  });
});

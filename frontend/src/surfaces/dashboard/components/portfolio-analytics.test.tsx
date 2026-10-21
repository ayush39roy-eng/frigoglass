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

// Same bands with the served within-year shares filled in.
const BANDS_SHARED: PriorityDeliveryBand[] = BANDS.map((b) => ({
  ...b,
  within_year_share_pct: { P1: 76, P2: 66.67, P3: 97.87, P4: 33.59, Q: 0 }[b.priority],
}));

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

  it('headline per band is "<within_year> of <total> finishing this year" plus the served share', () => {
    renderWithProviders(<PortfolioAnalytics rows={[row('a')]} priorityDelivery={BANDS_SHARED} />);
    const p1 = screen.getByTestId('priority-band-P1');
    expect(p1).toHaveTextContent('19 of 25 finishing this year');
    expect(p1).toHaveTextContent('76%');
    expect(p1).toHaveTextContent('In flight: 12 of 12 · Not started: 7 of 13');
    expect(p1).toHaveAccessibleName('P1: 19 of 25 finishing this year; in flight 12 of 12; not started 7 of 13');
  });

  it('never prints "0 of 0" or a bare dash; omits parts whose total is 0', () => {
    renderWithProviders(<PortfolioAnalytics rows={[row('a')]} priorityDelivery={BANDS_SHARED} />);
    const card = screen.getByTestId('priority-delivery-card');
    expect(card).not.toHaveTextContent('0 of 0');
    expect(card.textContent).not.toMatch(/(^|\s)[–-](\s|$)/);
    const p3 = screen.getByTestId('priority-band-P3');
    expect(p3).toHaveTextContent('In flight: 92 of 94');
    expect(p3).not.toHaveTextContent('Not started');
    const p4 = screen.getByTestId('priority-band-P4');
    expect(p4).not.toHaveTextContent('In flight');
    expect(p4).toHaveTextContent('Not started: 26 of 68 · Already delivered: 17 · Not in plan: 43');
  });

  it('sizes the stacked segments from the served counts, and they add up to the band total', () => {
    renderWithProviders(<PortfolioAnalytics rows={[row('a')]} priorityDelivery={BANDS_SHARED} />);
    for (const b of BANDS_SHARED.filter((x) => x.total > 0)) {
      expect(bandSum(b)).toBe(b.total);
      const segs = [...screen.getByTestId(`priority-band-${b.priority}`).querySelectorAll<HTMLElement>('[data-segment]')];
      const total = segs.reduce((acc, el) => acc + Number(el.dataset.count), 0);
      expect(total).toBe(b.total);
      for (const el of segs) expect(el.style.flexGrow).toBe(el.dataset.count);
    }
    const p4 = screen.getByTestId('priority-band-P4');
    const p4Segs = Object.fromEntries(
      [...p4.querySelectorAll<HTMLElement>('[data-segment]')].map((el) => [el.dataset.segment, Number(el.dataset.count)]),
    );
    expect(p4Segs).toEqual({ not_started_finishing: 26, not_started_not_finishing: 42, delivered: 17, not_in_plan: 43 });
    const p1 = screen.getByTestId('priority-band-P1');
    expect(p1.querySelector('[data-segment="in_flight_finishing"]')).toHaveAttribute('title', 'P1 · In flight, finishing this year: 12');
    // Zero segments are not drawn.
    expect(p1.querySelector('[data-segment="in_flight_not_finishing"]')).toBeNull();
  });

  it('uses one status colour per segment across bands; the band colour is only the dot', () => {
    renderWithProviders(<PortfolioAnalytics rows={[row('a')]} priorityDelivery={BANDS_SHARED} />);
    const p1 = screen.getByTestId('priority-band-P1').querySelector('[data-segment="not_started_finishing"]')!;
    const p4 = screen.getByTestId('priority-band-P4').querySelector('[data-segment="not_started_finishing"]')!;
    expect(p1.className).toBe(p4.className);
    expect(screen.getByRole('list', { name: 'Bar segments' })).toHaveTextContent('In flight, finishing this year');
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

  it('hides empty bands', () => {
    renderWithProviders(<PortfolioAnalytics rows={[row('a')]} priorityDelivery={BANDS} />);
    expect(screen.queryByRole('listitem', { name: /^Q: / })).not.toBeInTheDocument();
    expect(screen.getAllByRole('listitem', { name: /^P\d: / })).toHaveLength(4);
  });

  it('renders a hub-filtered payload (fewer bands) without the unfiltered ones', () => {
    const filtered = [band('P1', { total: 3, within_year: 3, within_year_share_pct: 100, in_flight_total: 3, in_flight_within_year: 3, in_flight_within_year_share_pct: 100 }), band('P2'), band('P3'), band('P4'), band('Q')];
    renderWithProviders(<PortfolioAnalytics rows={[row('a')]} priorityDelivery={filtered} />);
    expect(screen.getByTestId('priority-band-P1')).toHaveTextContent('3 of 3 finishing this year');
    expect(screen.getByTestId('priority-band-P1')).toHaveTextContent('In flight: 3 of 3');
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
    expect(within(list).getByTitle('PD-India: 1 on hold at a stage')).toBeInTheDocument();
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

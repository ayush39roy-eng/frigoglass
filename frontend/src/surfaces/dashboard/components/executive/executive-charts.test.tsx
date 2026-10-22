import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';

import { renderWithProviders } from '@/test/render';

import type { PipelineTotals, PriorityDeliveryBand, StatusOverview } from '../../api/types';

/** jsdom's ResponsiveContainer measures 0×0 and renders no SVG; a fixed-size
 *  passthrough (the analytics-breakdown.a11y pattern) lets the real Pie —
 *  including the leader-line labels — render for assertion. */
vi.mock('recharts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('recharts')>();
  return {
    ...actual,
    ResponsiveContainer: ({ children }: { children: React.ReactElement<{ width?: number; height?: number }> }) =>
      React.cloneElement(children, { width: 320, height: 208 }),
  };
});

import { PipelineDonut, PriorityDeliveryChart, StatusDonut, TypeBars } from './executive-charts';

const TOTALS: PipelineTotals = {
  spillover_count: 17,
  new_count: 236,
  unregistered_count: 0,
  total_count: 253,
  spillover_share_pct: 6.72,
  new_share_pct: 93.28,
  unregistered_share_pct: 0,
};

const STATUS: StatusOverview = {
  in_buyoff: 0,
  under_industrialization: 24,
  in_development: 83,
  in_queue: 85,
  other_counts: {},
  commercialized_count: 17,
  on_hold_count: 15,
  total_count: 253,
  in_development_share_pct: 32.81,
  under_industrialization_share_pct: 9.49,
  in_queue_share_pct: 33.6,
  commercialized_share_pct: 6.72,
  on_hold_share_pct: 5.93,
  other_statuses_count: 29,
  other_statuses_counts: { Cancelled: 29 },
  other_statuses_share_pct: 11.46,
};

function band(overrides: Partial<PriorityDeliveryBand> = {}): PriorityDeliveryBand {
  return {
    priority: 'P1',
    total: 34,
    within_year: 12,
    in_flight_total: 20,
    in_flight_within_year: 9,
    not_started_total: 8,
    not_started_within_year: 3,
    delivered_total: 2,
    delivered_within_year: 0,
    other_total: 4,
    within_year_share_pct: 35.29,
    in_flight_within_year_share_pct: 45,
    not_started_within_year_share_pct: 37.5,
    in_flight_share_pct: 58.82,
    not_started_share_pct: 23.53,
    delivered_share_pct: 5.88,
    other_share_pct: 11.76,
    ...overrides,
  };
}

describe('executive donuts (P28, ADR 0039 §3)', () => {
  it('Pipeline donut: FULL slice names, served counts and shares; zero slices listed under the chart', () => {
    renderWithProviders(<PipelineDonut totals={TOTALS} />);
    const donut = screen.getByTestId('exec-pipeline-donut');
    // Full names — never initials, never a mid-word break.
    expect(within(donut).getAllByText('Spillover').length).toBeGreaterThan(0);
    expect(within(donut).getAllByText('New').length).toBeGreaterThan(0);
    expect(within(donut).getByTestId('exec-pipeline-donut-slice-spillover')).toHaveTextContent('17 · 6.72%');
    expect(within(donut).getByTestId('exec-pipeline-donut-slice-new')).toHaveTextContent('236 · 93.28%');
    expect(within(donut).getByTestId('exec-pipeline-donut-slice-unregistered')).toHaveTextContent('0 · 0%');
    // A zero slice has no arc; it is named in one muted line instead.
    expect(within(donut).getByTestId('exec-pipeline-donut-zero')).toHaveTextContent('No projects: Unregistered');
    // Centre total = the served total_count.
    expect(within(donut).getAllByText('253').length).toBeGreaterThan(0);
  });

  it('Status donut: leader-line labels IN the chart carry the full names + served figures; no mid-word break class remains', () => {
    const { container } = renderWithProviders(<StatusDonut data={STATUS} />);
    const donut = screen.getByTestId('exec-status-donut');
    for (const label of ['In Development', 'In Queue', 'Commercialized', 'On Hold', 'Other']) {
      expect(within(donut).getAllByText(label).length).toBeGreaterThan(0);
    }
    // The wide variant's SVG labels (leader lines + callout text): word-level
    // wrapping only — "Industrialization" stays whole on its own line.
    const svgText = donut.querySelector('figure svg');
    expect(svgText).not.toBeNull();
    expect(svgText?.textContent).toContain('Industrialization');
    expect(svgText?.textContent).toContain('85 · 33.6%');
    // Leader lines drawn (one polyline per slice).
    expect(donut.querySelectorAll('figure svg polyline').length).toBeGreaterThanOrEqual(6);
    // The owner-banned `overflow-wrap:anywhere` guard is gone.
    expect(container.querySelector('[class*="anywhere"]')).toBeNull();
    expect(within(donut).getByTestId('exec-status-donut-slice-in-queue')).toHaveTextContent('85 · 33.6%');
    expect(within(donut).getByTestId('exec-status-donut-slice-other')).toHaveTextContent('29 · 11.46%');
  });

  it('Projects by type: served by_type buckets as a bar list — full labels, counts + shares verbatim', () => {
    renderWithProviders(
      <TypeBars
        buckets={[
          { key: 'CO', count: 89, share_pct: 37.71 },
          { key: 'Unmapped', count: 3, share_pct: 1.27 },
        ]}
      />,
    );
    const card = screen.getByTestId('exec-type-chart');
    expect(within(card).getAllByText('Cost Optimization').length).toBeGreaterThan(0);
    expect(within(card).getAllByText('Unmapped').length).toBeGreaterThan(0);
    const row = within(card).getByTestId('exec-type-row-CO');
    expect(row).toHaveTextContent('89 · 37.71%');
    // The bar's width IS the served share (presentation of a served figure).
    expect(row.querySelector('[data-served-share]')).toHaveAttribute('data-served-share', '37.71');
  });
});

describe('PriorityDeliveryChart', () => {
  it('prints the served counts and shares per band (bars carry numbers, not a % alone)', () => {
    renderWithProviders(
      <PriorityDeliveryChart bands={[band(), band({ priority: 'Q', total: 10, within_year: 1, within_year_share_pct: 10 })]} />,
    );
    const card = screen.getByTestId('exec-priority-delivery');
    const list = within(card).getByRole('list', { name: 'Delivery by priority band' });
    expect(list).toHaveTextContent('P1: 12 of 34 within the year (35.29%)');
    expect(list).toHaveTextContent('in flight 58.82%');
    expect(list).toHaveTextContent('not started 23.53%');
    expect(list).toHaveTextContent('delivered 5.88%');
    expect(list).toHaveTextContent('not in plan 11.76%');
    expect(list).toHaveTextContent('Q: 1 of 10 within the year (10%)');
  });

  it('hides empty bands and says so when none remain', () => {
    renderWithProviders(<PriorityDeliveryChart bands={[band({ total: 0 })]} />);
    expect(screen.getByText('No prioritised projects in this run.')).toBeInTheDocument();
  });
});

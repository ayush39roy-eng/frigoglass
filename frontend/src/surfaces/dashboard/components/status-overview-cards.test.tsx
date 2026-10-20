import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';

import type { RegionSummary, StatusOverview } from '../api/types';
import { StatusOverviewCards } from './status-overview-cards';

const DATA: StatusOverview = {
  in_buyoff: 5,
  under_industrialization: 12,
  in_development: 40,
  in_queue: 100,
  other_counts: { Draft: 3, Commercialized: 8, 'On Hold': 2 },
  commercialized_count: 8,
  on_hold_count: 2,
  total_count: 170,
  in_development_share_pct: 23.53,
  under_industrialization_share_pct: 7.06,
  in_queue_share_pct: 58.82,
  commercialized_share_pct: 4.71,
  on_hold_share_pct: 1.18,
  other_statuses_count: 8,
  other_statuses_counts: { 'In Buyoff': 5, Draft: 3 },
  other_statuses_share_pct: 4.7,
};

const row = (region: 'Greece' | 'India' | 'Romania', n: number, pct: number) => ({
  region,
  total_count: 0,
  share_pct: 0,
  spillover_count: 0,
  newly_registered_count: 0,
  unregistered_count: 0,
  spillover_share_pct: 0,
  newly_registered_share_pct: 0,
  unregistered_share_pct: 0,
  status_counts: { 'In Development': n, 'On Hold': 1 },
  status_share_pct: { 'In Development': pct, 'On Hold': 50 },
});
const SUMMARY: RegionSummary = {
  total_count: 170,
  regions: [row('Greece', 10, 25), row('India', 20, 50), row('Romania', 10, 25)],
};

describe('StatusOverviewCards', () => {
  it('renders the five cards with served counts and "% of total"', () => {
    render(<StatusOverviewCards data={DATA} />);
    const expected: [string, string, string][] = [
      ['in-development', '40', '23.53% of total'],
      ['under-industrialization', '12', '7.06% of total'],
      ['in-queue', '100', '58.82% of total'],
      ['commercialized', '8', '4.71% of total'],
      ['on-hold', '2', '1.18% of total'],
    ];
    for (const [id, count, caption] of expected) {
      expect(screen.getByTestId(`status-count-${id}`)).toHaveTextContent(count);
      expect(screen.getByTestId(`status-caption-${id}`)).toHaveTextContent(caption);
    }
    expect(screen.queryByRole('region', { name: 'In Buyoff' })).not.toBeInTheDocument();
  });

  it('bar width is the served share, not a browser calculation', () => {
    render(<StatusOverviewCards data={DATA} />);
    expect(screen.getByTestId('status-bar-in-queue')).toHaveStyle({ width: '58.82%' });
    expect(screen.getByTestId('status-bar-on-hold')).toHaveStyle({ width: '1.18%' });
    const bar = screen.getByRole('progressbar', { name: 'In Queue share of total' });
    expect(bar).toHaveAttribute('aria-valuenow', '58.82');
  });

  it('shows per-country chips with served counts and shares', () => {
    render(<StatusOverviewCards data={DATA} regionSummary={SUMMARY} />);
    const chips = within(screen.getByTestId('status-card-in-development')).getByTestId('region-chips');
    expect(within(chips).getAllByRole('listitem')).toHaveLength(3);
    expect(chips).toHaveTextContent('20');
    expect(chips).toHaveTextContent('(50%)');
  });

  it('omits chips while the region summary is absent', () => {
    render(<StatusOverviewCards data={DATA} />);
    expect(screen.queryByTestId('region-chips')).not.toBeInTheDocument();
  });

  it('shows the "Other statuses" remainder from the served count', () => {
    render(<StatusOverviewCards data={DATA} />);
    expect(screen.getByTestId('status-other')).toHaveTextContent('Other statuses: 8 (4.7% of total)');
    // ADR 0017: the status On Hold is explained apart from the stage-level outcome.
    expect(screen.getByRole('button', { name: 'Status overview source' })).toBeInTheDocument();
  });

  it('zero state renders zeros, empty bars and no percentage on the other line', () => {
    render(
      <StatusOverviewCards
        data={{
          ...DATA,
          in_development: 0,
          under_industrialization: 0,
          in_queue: 0,
          commercialized_count: 0,
          on_hold_count: 0,
          total_count: 0,
          in_development_share_pct: 0,
          under_industrialization_share_pct: 0,
          in_queue_share_pct: 0,
          commercialized_share_pct: 0,
          on_hold_share_pct: 0,
          other_statuses_count: 0,
          other_statuses_counts: {},
          other_statuses_share_pct: 0,
        }}
      />,
    );
    expect(screen.getByTestId('status-count-on-hold')).toHaveTextContent('0');
    expect(screen.getByTestId('status-bar-on-hold')).toHaveStyle({ width: '0%' });
    expect(screen.getByTestId('status-other')).toHaveTextContent(/^Other statuses: 0$/);
  });
});

import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';

import { renderWithProviders } from '@/test/render';

import type { RegionSummary } from '../api/types';
import { statusRegionItems } from '../lib/region-summary';
import { RegionChips } from './region-chips';

/** P13 (ADR 0025 §4): served count + served share, verbatim; no browser maths. */

const SUMMARY: RegionSummary = {
  total_count: 10,
  regions: [
    {
      region: 'Greece',
      total_count: 3,
      share_pct: 30,
      spillover_count: 1,
      newly_registered_count: 2,
      status_counts: { 'In Queue': 2 },
      status_share_pct: { 'In Queue': 33.33 },
    },
    {
      region: 'India',
      total_count: 7,
      share_pct: 70,
      spillover_count: 2,
      newly_registered_count: 5,
      status_counts: { 'In Queue': 4 },
      status_share_pct: {},
    },
    {
      region: 'Romania',
      total_count: 0,
      share_pct: 0,
      spillover_count: 0,
      newly_registered_count: 0,
      status_counts: {},
      status_share_pct: {},
    },
  ],
};

describe('RegionChips', () => {
  it('shows flag, count and the served share; omits a share the server did not serve', () => {
    renderWithProviders(<RegionChips label="In Queue" items={statusRegionItems(SUMMARY, 'In Queue')} />);
    const list = screen.getByRole('list', { name: 'In Queue by country' });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(3);
    expect(items[0]).toHaveTextContent('Greece:2(33.33%)');
    expect(items[1]).toHaveTextContent('India:4');
    expect(items[1]).not.toHaveTextContent('%');
    // A missing status count is zero (the contract serves every status).
    expect(items[2]).toHaveTextContent('Romania:0');
    expect(screen.getByTestId('flag-India')).toHaveAttribute('aria-hidden', 'true');
  });
});

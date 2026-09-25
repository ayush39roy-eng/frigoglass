import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';

import { StatusOverviewCards } from './status-overview-cards';

describe('StatusOverviewCards', () => {
  it('renders the four named status counts as cards', () => {
    render(
      <StatusOverviewCards
        data={{
          in_buyoff: 5,
          under_industrialization: 12,
          in_development: 40,
          in_queue: 100,
          other_counts: { Draft: 3, 'On Hold': 1 },
        }}
      />,
    );
    expect(within(screen.getByRole('group', { name: 'In Buyoff' })).getByText('5')).toBeInTheDocument();
    expect(
      within(screen.getByRole('group', { name: 'In Queue' })).getByText('100'),
    ).toBeInTheDocument();
    expect(screen.getByText(/Draft: 3/)).toBeInTheDocument();
    expect(screen.getByText(/On Hold: 1/)).toBeInTheDocument();
  });

  it('omits the "not shown as cards" line when there is nothing extra', () => {
    render(
      <StatusOverviewCards
        data={{
          in_buyoff: 1,
          under_industrialization: 1,
          in_development: 1,
          in_queue: 1,
          other_counts: {},
        }}
      />,
    );
    expect(screen.queryByText(/Not shown as cards/i)).not.toBeInTheDocument();
  });
});

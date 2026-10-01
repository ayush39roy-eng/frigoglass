import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';

import { renderWithProviders } from '@/test/render';
import type { HubTypePipelineRow } from '../api/types';
import { HubRankList } from './hub-rank-list';

const rows: HubTypePipelineRow[] = [
  { hub: 'R&D-Greece', type: 'NM', count: 3 },
  { hub: 'R&D-Greece', type: 'CO', count: 2 },
  { hub: 'PD-India', type: 'NM', count: 10 },
];

describe('HubRankList', () => {
  it('renders the real per-hub totals, ranked largest first', () => {
    renderWithProviders(<HubRankList rows={rows} />);
    expect(screen.getByText('Top hubs by project count')).toBeInTheDocument();

    const list = screen.getByRole('list', { name: /Real project count per hub/i });
    const items = within(list).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    // PD-India (10) ranks above R&D-Greece (3 + 2 = 5).
    expect(within(items[0] as HTMLElement).getByText('PD-India')).toBeInTheDocument();
    expect(within(items[0] as HTMLElement).getByText('10')).toBeInTheDocument();
    expect(within(items[1] as HTMLElement).getByText('R&D-Greece')).toBeInTheDocument();
    expect(within(items[1] as HTMLElement).getByText('5')).toBeInTheDocument();
    // A real country label, never a fabricated business number.
    expect(within(items[0] as HTMLElement).getByText('India')).toBeInTheDocument();
  });

  it('renders a non-error empty state when there are no hubs in scope', () => {
    renderWithProviders(<HubRankList rows={[]} />);
    expect(screen.getByText('No hubs in scope')).toBeInTheDocument();
  });
});

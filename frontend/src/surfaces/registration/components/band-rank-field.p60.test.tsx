import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import type { PriorityMoveApi } from '@/components/shared/priority-move/priority-move-context';
import { rankTooltip } from '@/lib/hub-rank';

import { BandRankField } from './band-rank-field';

function host(): PriorityMoveApi {
  return { requestMove: vi.fn(), requestRankMove: vi.fn(), followPatch: vi.fn(), busy: false };
}

const facts = { priority: 'P1', hub: 'PD-India', hub_rank: 3, hub_band_size: 12, band_rank: 16, band_size: 40 };

describe('P60 (ADR 0068) hub rank display + edit', () => {
  it('tooltip: hub rank, plus the global rank only without a hub filter', () => {
    expect(rankTooltip(facts, false)).toBe('#3 of 12 in PD-India · P1\nGlobal: #16 of 40 in P1, all hubs');
    expect(rankTooltip(facts, true)).toBe('#3 of 12 in PD-India · P1');
  });

  function field(hubFiltered: boolean, api: PriorityMoveApi = host()) {
    return renderWithProviders(
      <BandRankField
        mode="edit"
        savedPriority="P1"
        chosenPriority="P1"
        projectId="p9"
        projectName="Old cooler"
        status="In Development"
        rank={3}
        size={12}
        hub="PD-India"
        globalRank={16}
        globalSize={40}
        hubFiltered={hubFiltered}
        host={api}
        canMove
      />,
    );
  }

  it('shows the hub rank with the global rank on hover and a G marker (no hub filter)', () => {
    field(false);
    expect(screen.getByTestId('board-rank-input')).toHaveValue('3');
    expect(screen.getByTestId('reg-band-rank')).toHaveAttribute('title', expect.stringContaining('Global: #16 of 40 in P1, all hubs'));
    expect(screen.getByTestId('global-rank-marker')).toHaveTextContent('16');
  });

  it('with a hub filter: hub rank only, no global anywhere', () => {
    field(true);
    expect(screen.getByTestId('reg-band-rank').getAttribute('title')).toBe('#3 of 12 in PD-India · P1');
    expect(screen.queryByTestId('global-rank-marker')).toBeNull();
    expect(screen.getByTestId('reg-band-rank')).not.toHaveTextContent('16');
  });

  it('typing a position sends { hub_rank } with the hub scope', async () => {
    const api = host();
    field(false, api);
    const input = screen.getByTestId('board-rank-input');
    await userEvent.clear(input);
    await userEvent.type(input, '1{Enter}');
    expect(api.requestRankMove).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: 'p9', priority: 'P1' }),
      { hub_rank: 1 },
      expect.objectContaining({ position: 1, fromPosition: 3, scope: 'PD-India · P1' }),
    );
  });
});

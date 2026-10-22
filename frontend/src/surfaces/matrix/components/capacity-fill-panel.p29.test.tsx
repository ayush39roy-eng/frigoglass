import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';

import { renderWithProviders } from '@/test/render';

import { CapacityFillPanel } from './capacity-fill-panel';

/** P29-T03 (ADR 0042, API_CONTRACT_P29 §4): one P1 capacity fill per capacity
 *  hub; R&D-Greece's walk covers its served member hubs, named under it. */
describe('CapacityFillPanel — capacity hubs (P29)', () => {
  it('names the served members under R&D-Greece and nothing under other hubs', () => {
    renderWithProviders(
      <CapacityFillPanel
        isPending={false}
        isError={false}
        data={{
          has_active_schedule_run: true,
          schedule_run_version: 9,
          hubs: [
            { hub: 'PD-India', capacity_weeks: 20, base_load_weeks: 25.5, filled_load_weeks: 25.5, promoted_count: 0, members: [], selected_member: null },
            { hub: 'R&D-Greece', capacity_weeks: 23.61, base_load_weeks: 10, filled_load_weeks: 22, promoted_count: 3, members: ['OEM-HCK', 'OEM-Seitek'], selected_member: null },
          ],
        }}
      />,
    );
    const greece = screen.getByTestId('capacity-fill-R&D-Greece');
    const members = within(greece).getByTestId('capacity-fill-members');
    expect(members).toHaveTextContent('+ OEM-HCK, OEM-Seitek');
    expect(within(members).getByText('includes OEM-HCK and OEM-Seitek')).toHaveClass('sr-only');
    expect(within(screen.getByTestId('capacity-fill-PD-India')).queryByTestId('capacity-fill-members')).toBeNull();
    expect(screen.queryByTestId('capacity-fill-OEM-HCK')).toBeNull();
  });
});

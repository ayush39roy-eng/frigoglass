import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import type { Hub } from '@/lib/api/reference';

const HUBS: Hub[] = [
  { id: 'h-gr', name: 'R&D-Greece', lab_region: 'Greece', is_oem: false, capacity_hub_id: null, capacity_hub_name: null },
  { id: 'h-pdin', name: 'PD-India', lab_region: 'India', is_oem: false, capacity_hub_id: null, capacity_hub_name: null },
  { id: 'h-hck', name: 'OEM-HCK', lab_region: 'Greece', is_oem: true, capacity_hub_id: 'h-gr', capacity_hub_name: 'R&D-Greece' },
];
vi.mock('@/lib/api/reference', () => ({ useHubs: () => ({ data: HUBS }) }));

import { useWhatIfScenario } from '../scenario-store';
import { buildScenarioRequest } from '../scenario-schema';
import { ScenarioBuilder } from './scenario-builder';

/** P29-T03 (API_CONTRACT_P29 §8): what-if hub pickers. Projects may sit on an
 *  OEM hub (labelled "(Greece)"); designer additions / removals are on capacity
 *  hubs only (an OEM hub is a 422 INVALID_SCENARIO). */
beforeEach(() => {
  useWhatIfScenario.getState().reset();
});

const optionTexts = (select: HTMLElement): (string | null)[] =>
  within(select).getAllByRole('option').map((o) => o.textContent);

describe('ScenarioBuilder hub pickers (P29)', () => {
  it('project lines offer every hub with the "(Greece)" label; designer and removal lines only capacity hubs', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ScenarioBuilder validation={buildScenarioRequest(useWhatIfScenario.getState())} chambers={[]} />);
    await user.click(screen.getByRole('button', { name: 'Add project line' }));
    await user.click(screen.getByRole('button', { name: 'Add designer line' }));
    await user.click(screen.getByRole('button', { name: 'Add removal line' }));
    const hubSelects = screen.getAllByRole('combobox', { name: 'Hub' });
    expect(hubSelects).toHaveLength(3);
    expect(optionTexts(hubSelects[0]!)).toEqual(['R&D-Greece', 'PD-India', 'OEM-HCK (Greece)']);
    expect(optionTexts(hubSelects[1]!)).toEqual(['R&D-Greece', 'PD-India']);
    expect(optionTexts(hubSelects[2]!)).toEqual(['R&D-Greece', 'PD-India']);
  });
});

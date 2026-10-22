import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';

import { renderWithProviders } from '@/test/render';
import type { Hub } from '@/lib/api/reference';

const reference = { hubs: [] as Hub[] };
vi.mock('@/lib/api/reference', () => ({
  useHubs: () => ({ data: reference.hubs }),
}));

import { CalendarsTab } from './calendars-tab';

/** P29-T03 (API_CONTRACT_P29 §5.3): member hubs have no calendar of their own. */
describe('CalendarsTab — member hubs (P29)', () => {
  it('says OEM-HCK and OEM-Seitek use R&D-Greece’s calendar', () => {
    reference.hubs = [
      { id: 'h-gr', name: 'R&D-Greece', lab_region: 'Greece', is_oem: false, capacity_hub_id: null, capacity_hub_name: null },
      { id: 'h-hck', name: 'OEM-HCK', lab_region: 'Greece', is_oem: true, capacity_hub_id: 'h-gr', capacity_hub_name: 'R&D-Greece' },
      { id: 'h-sel', name: 'OEM-Seitek', lab_region: 'Greece', is_oem: true, capacity_hub_id: 'h-gr', capacity_hub_name: 'R&D-Greece' },
    ];
    renderWithProviders(<CalendarsTab calendars={[]} canWrite={false} onSave={vi.fn()} saving={false} />);
    expect(screen.getByTestId('calendar-member-note')).toHaveTextContent('OEM-HCK and OEM-Seitek use R&D-Greece’s calendar.');
  });

  it('no note before P29 (no member hub served)', () => {
    reference.hubs = [
      { id: 'h-gr', name: 'R&D-Greece', lab_region: 'Greece', is_oem: false, capacity_hub_id: null, capacity_hub_name: null },
    ];
    renderWithProviders(<CalendarsTab calendars={[]} canWrite={false} onSave={vi.fn()} saving={false} />);
    expect(screen.queryByTestId('calendar-member-note')).toBeNull();
  });
});

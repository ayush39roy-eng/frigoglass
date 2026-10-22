import { describe, expect, it } from 'vitest';

import type { Hub } from '@/lib/api/reference';
import { PROJECT_TYPE_LABELS, PROJECT_TYPES } from '@/types/enums';

import {
  capacityCountryOf,
  capacityHubsOnly,
  hubPickerLabel,
  isMemberHub,
  joinNames,
  memberHubsByCapacityHub,
} from './hub-labels';

/** `GET /hubs` as served after P29 (API_CONTRACT_P29 §1.1). */
const HUBS: Hub[] = [
  { id: 'h-gr', name: 'R&D-Greece', lab_region: 'Greece', is_oem: false, capacity_hub_id: null, capacity_hub_name: null },
  { id: 'h-in', name: 'R&D-India', lab_region: 'India', is_oem: false, capacity_hub_id: null, capacity_hub_name: null },
  { id: 'h-pdin', name: 'PD-India', lab_region: 'India', is_oem: false, capacity_hub_id: null, capacity_hub_name: null },
  { id: 'h-ro', name: 'PD-Romania', lab_region: 'Romania', is_oem: false, capacity_hub_id: null, capacity_hub_name: null },
  { id: 'h-hck', name: 'OEM-HCK', lab_region: 'Greece', is_oem: true, capacity_hub_id: 'h-gr', capacity_hub_name: 'R&D-Greece' },
  { id: 'h-sel', name: 'OEM-Seitek', lab_region: 'Greece', is_oem: true, capacity_hub_id: 'h-gr', capacity_hub_name: 'R&D-Greece' },
];

describe('hub picker labels (P29, ADR 0042)', () => {
  it('labels a member hub with its capacity hub country and leaves capacity hubs alone', () => {
    expect(HUBS.map((h) => hubPickerLabel(h, HUBS))).toEqual([
      'R&D-Greece',
      'R&D-India',
      'PD-India',
      'PD-Romania',
      'OEM-HCK (Greece)',
      'OEM-Seitek (Greece)',
    ]);
  });

  it('reads the country from the served capacity hub, not from a hard-coded map', () => {
    // A hypothetical member of R&D-India: the label follows the served data.
    const member: Hub = { ...HUBS[4]!, id: 'h-x', lab_region: 'Greece', capacity_hub_id: 'h-in', capacity_hub_name: 'R&D-India' };
    expect(hubPickerLabel(member, HUBS)).toBe('OEM-HCK (India)');
    expect(capacityCountryOf(HUBS[0]!, HUBS)).toBeNull();
  });

  it('falls back to the hub own lab region when the capacity hub is not in the list (scoped caller)', () => {
    expect(hubPickerLabel(HUBS[4]!, [HUBS[4]!])).toBe('OEM-HCK (Greece)');
    expect(hubPickerLabel(HUBS[4]!)).toBe('OEM-HCK (Greece)');
  });

  it('an older API without the P29 fields gives the plain name', () => {
    const old: Pick<Hub, 'id' | 'name' | 'lab_region'> = { id: 'h-hck', name: 'OEM-HCK', lab_region: 'Greece' };
    expect(isMemberHub(old as Partial<Hub>)).toBe(false);
    expect(hubPickerLabel(old)).toBe('OEM-HCK');
  });

  it('engineer pickers offer the four capacity hubs only (contract §5.2)', () => {
    expect(capacityHubsOnly(HUBS).map((h) => h.name)).toEqual(['R&D-Greece', 'R&D-India', 'PD-India', 'PD-Romania']);
  });

  it('groups member hubs by their served capacity hub', () => {
    expect(memberHubsByCapacityHub(HUBS)).toEqual([{ capacityHub: 'R&D-Greece', members: ['OEM-HCK', 'OEM-Seitek'] }]);
    expect(memberHubsByCapacityHub(HUBS.slice(0, 4))).toEqual([]);
  });

  it('joins names in plain English', () => {
    expect(joinNames([])).toBe('');
    expect(joinNames(['A'])).toBe('A');
    expect(joinNames(['A', 'B'])).toBe('A and B');
    expect(joinNames(['A', 'B', 'C'])).toBe('A, B and C');
  });
});

describe('project type labels (P29-T04, ADR 0038 amendment)', () => {
  it('RC reads "Regulatory / Business Compliance"; the list mirrors GET /reference/project-types', () => {
    // API_CONTRACT_P29 §1.2, in the served order.
    expect(PROJECT_TYPES.map((t) => [t, PROJECT_TYPE_LABELS[t]])).toEqual([
      ['NM', 'New Model'],
      ['CO', 'Cost Optimization'],
      ['RC', 'Regulatory / Business Compliance'],
      ['NO', 'New Option'],
      ['IMP', 'Improvement'],
      // P30 (ADR 0041 §4, API_CONTRACT_P30 §1): no scoring tag.
      ['AC', 'Alternative Component'],
      ['SER', 'Service'],
    ]);
    expect(PROJECT_TYPES).not.toContain('BC');
  });
});

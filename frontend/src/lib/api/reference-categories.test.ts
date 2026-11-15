import { describe, expect, it } from 'vitest';

import { CategoryCatalog } from '@/lib/category-catalog';
import { SEEDED_TEST_CATEGORIES, WITH_B2_TEST_CATEGORIES } from '@/test/category-fixtures';

import { categoryOptionsForHub } from './reference';

const CATALOG = new CategoryCatalog(SEEDED_TEST_CATEGORIES);

describe('categoryOptionsForHub (P33 B1 objects, ADR 0007 / 0047)', () => {
  it('prefers the hub’s served list, as codes in rank order', () => {
    const served = [
      { code: 'C-OEM', label: 'C-OEM', workflow_id: 'OEM' as const, rank: 7 },
      { code: 'B-OEM', label: 'B-OEM', workflow_id: 'OEM' as const, rank: 6 },
    ];
    expect(categoryOptionsForHub({ is_oem: true }, served, CATALOG)).toEqual(['B-OEM', 'C-OEM']);
  });
  it('falls back to the served global list narrowed to the hub’s workflow', () => {
    expect(categoryOptionsForHub({ is_oem: true }, undefined, CATALOG)).toEqual(['A-OEM', 'B-OEM', 'C-OEM']);
    expect(categoryOptionsForHub({ is_oem: false }, [], CATALOG)).toEqual(['A+', 'A', 'B', 'C']);
  });
  it('offers everything when no hub is chosen yet', () => {
    expect(categoryOptionsForHub(undefined, undefined, CATALOG)).toHaveLength(7);
  });
  it('an Admin-added category appears in its workflow at its rank', () => {
    const withB2 = new CategoryCatalog(WITH_B2_TEST_CATEGORIES);
    expect(categoryOptionsForHub({ is_oem: false }, undefined, withB2)).toEqual(['A+', 'A', 'B', 'B2', 'C']);
    expect(categoryOptionsForHub({ is_oem: true }, undefined, withB2)).toEqual(['A-OEM', 'B-OEM', 'C-OEM']);
  });
  it('an empty catalog (not loaded) offers nothing rather than a stale list', () => {
    expect(categoryOptionsForHub({ is_oem: false }, undefined, new CategoryCatalog([]))).toEqual([]);
  });
});

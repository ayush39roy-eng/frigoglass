import { describe, expect, it } from 'vitest';

import { categoryOptionsForHub } from './reference';

describe('categoryOptionsForHub (P9 contract §6, ADR 0007)', () => {
  it('prefers the server list when present', () => {
    expect(categoryOptionsForHub({ is_oem: true }, ['B-OEM'])).toEqual(['B-OEM']);
  });
  it('falls back to the OEM / non-OEM split by hub.is_oem', () => {
    expect(categoryOptionsForHub({ is_oem: true }, undefined)).toEqual(['A-OEM', 'B-OEM', 'C-OEM']);
    expect(categoryOptionsForHub({ is_oem: false }, [])).toEqual(['A+', 'A', 'B', 'C']);
  });
  it('offers everything when no hub is chosen yet', () => {
    expect(categoryOptionsForHub(undefined, undefined)).toHaveLength(7);
  });
});

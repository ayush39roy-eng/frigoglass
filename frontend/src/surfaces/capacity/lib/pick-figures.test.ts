import { describe, expect, it } from 'vitest';

import { hubRow } from '../test-fixtures';
import { pickFigures } from './pick-figures';

describe('pickFigures — selects served fields, never combines them', () => {
  const row = hubRow();
  it('design / full year', () => {
    expect(pickFigures(row, 'design', 'year')).toEqual({
      load: 587,
      loadEstimated: 451.5,
      capacity: 252.62,
      gap: 334.38,
      completionPct: 0.43,
    });
  });
  it('design / remaining year', () => {
    expect(pickFigures(row, 'design', 'remaining')).toEqual({
      load: 587,
      loadEstimated: 451.5,
      capacity: 179.75,
      gap: 407.25,
      completionPct: 0.31,
    });
  });
  it('lab / both horizons', () => {
    expect(pickFigures(row, 'lab', 'year').capacity).toBe(186.22);
    expect(pickFigures(row, 'lab', 'remaining').capacity).toBe(132.5);
    expect(pickFigures(row, 'lab', 'remaining').completionPct).toBe(0.27);
  });
});

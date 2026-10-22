import { describe, expect, it } from 'vitest';

import { areaRow, hubRow } from '../test-fixtures';
import { pickAreaFigures, pickFigures } from './pick-figures';

describe('pickFigures — selects served fields, never combines them', () => {
  const row = hubRow();
  it('design / full year: full-year demand + run-booked (P30, I19 rev.)', () => {
    expect(pickFigures(row, 'design', 'year')).toEqual({
      load: 587,
      booked: 420,
      capacity: 252.62,
      gap: 334.38,
      completionPct: 0.43,
      bookedPct: 232.36,
      bookingStatus: 'full',
    });
  });
  it('design / remaining year: REMAINING demand pairs with the remaining capacity (P30)', () => {
    expect(pickFigures(row, 'design', 'remaining')).toEqual({
      load: 436,
      booked: 420,
      capacity: 179.75,
      gap: 407.25,
      completionPct: 0.31,
      bookedPct: 326.56,
      bookingStatus: 'full',
    });
  });
  it('lab / both horizons', () => {
    expect(pickFigures(row, 'lab', 'year').capacity).toBe(186.22);
    expect(pickFigures(row, 'lab', 'remaining').capacity).toBe(132.5);
    expect(pickFigures(row, 'lab', 'remaining').completionPct).toBe(0.27);
    expect(pickFigures(row, 'lab', 'year').bookedPct).toBe(266.62);
    expect(pickFigures(row, 'lab', 'remaining').bookedPct).toBe(374.72);
    // P30: full-year vs remaining lab demand; booked is the run's, on both horizons.
    expect(pickFigures(row, 'lab', 'year').load).toBe(496.5);
    expect(pickFigures(row, 'lab', 'remaining').load).toBe(408.25);
    expect(pickFigures(row, 'lab', 'year').booked).toBe(409.5);
    expect(pickFigures(row, 'lab', 'remaining').booked).toBe(409.5);
  });
  it('passes a null booked % (capacity 0) and its served status through untouched', () => {
    const zero = hubRow({ design_booked_pct_year: null, design_booking_status_year: 'full' });
    expect(pickFigures(zero, 'design', 'year')).toMatchObject({ bookedPct: null, bookingStatus: 'full' });
  });
});

describe('pickAreaFigures — selects the served area roll-up (ADR 0016)', () => {
  const area = areaRow();
  it('design / both horizons', () => {
    expect(pickAreaFigures(area, 'design', 'year')).toEqual({ load: 210, booked: 180, capacity: 289.9, bookedPct: 72.44, bookingStatus: 'available' });
    expect(pickAreaFigures(area, 'design', 'remaining')).toEqual({ load: 150, booked: 180, capacity: 193.2, bookedPct: 108.7, bookingStatus: 'full' });
  });
  it('lab / both horizons', () => {
    expect(pickAreaFigures(area, 'lab', 'year')).toEqual({ load: 140, booked: 110, capacity: 289.26, bookedPct: 48.4, bookingStatus: 'available' });
    expect(pickAreaFigures(area, 'lab', 'remaining')).toEqual({ load: 90, booked: 110, capacity: 205.82, bookedPct: 68.02, bookingStatus: 'available' });
  });
});

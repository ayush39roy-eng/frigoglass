import { describe, expect, it } from 'vitest';

import { areaRow, hubRow } from '../test-fixtures';
import { pickAreaFigures, pickFigures } from './pick-figures';

describe('pickFigures — selects served fields, never combines them', () => {
  const row = hubRow();
  it('design / full year', () => {
    expect(pickFigures(row, 'design', 'year')).toEqual({
      load: 587,
      loadEstimated: 451.5,
      capacity: 252.62,
      gap: 334.38,
      completionPct: 0.43,
      bookedPct: 232.36,
      bookingStatus: 'full',
    });
  });
  it('design / remaining year', () => {
    expect(pickFigures(row, 'design', 'remaining')).toEqual({
      load: 587,
      loadEstimated: 451.5,
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
  });
  it('passes a null booked % (capacity 0) and its served status through untouched', () => {
    const zero = hubRow({ design_booked_pct_year: null, design_booking_status_year: 'full' });
    expect(pickFigures(zero, 'design', 'year')).toMatchObject({ bookedPct: null, bookingStatus: 'full' });
  });
});

describe('pickAreaFigures — selects the served area roll-up (ADR 0016)', () => {
  const area = areaRow();
  it('design / both horizons', () => {
    expect(pickAreaFigures(area, 'design', 'year')).toEqual({ load: 210, capacity: 289.9, bookedPct: 72.44, bookingStatus: 'available' });
    expect(pickAreaFigures(area, 'design', 'remaining')).toEqual({ load: 210, capacity: 193.2, bookedPct: 108.7, bookingStatus: 'full' });
  });
  it('lab / both horizons', () => {
    expect(pickAreaFigures(area, 'lab', 'year')).toEqual({ load: 140, capacity: 289.26, bookedPct: 48.4, bookingStatus: 'available' });
    expect(pickAreaFigures(area, 'lab', 'remaining')).toEqual({ load: 140, capacity: 205.82, bookedPct: 68.02, bookingStatus: 'available' });
  });
});

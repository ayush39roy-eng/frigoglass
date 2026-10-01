import { describe, expect, it } from 'vitest';

import {
  impliedHolidayWeeks,
  previewEfficientLabWeeks,
  previewWorkingWeeksPerChamber,
  previewWorkingWeeksPerEngineer,
} from './preview';

describe('ADR 0008 preview formulas (labelled preview; the saved value is the server’s)', () => {
  it('PD-India: 52 − (13+7+7+20)/6 = 44.17 (workbook 43.93 mixes /5 and /6 — ADR 0008 normalises)', () => {
    const v = previewWorkingWeeksPerEngineer({
      weekdays_per_week: 6,
      national_holiday_days: 13,
      medical_leave_days: 7,
      casual_leave_days: 7,
      annual_leave_days: 20,
    });
    expect(v).toBeCloseTo(44.17, 2);
  });

  it('R&D-Greece: 52 − (12+0+0+25)/5 = 44.6 (matches the workbook)', () => {
    expect(
      previewWorkingWeeksPerEngineer({
        weekdays_per_week: 5,
        national_holiday_days: 12,
        medical_leave_days: 0,
        casual_leave_days: 0,
        annual_leave_days: 25,
      }),
    ).toBeCloseTo(44.6, 5);
  });

  it('India CH-2: holidays implied from the saved row, then 35.4 working weeks and 84.96 efficient weeks', () => {
    const saved = {
      platforms: 4,
      efficiency: 0.6,
      maintenance_weeks: 2,
      breakdown_weeks: 11,
      calibration_weeks: 1,
      working_weeks_per_chamber: 35.4,
    };
    const holidays = impliedHolidayWeeks(saved);
    expect(holidays).toBeCloseTo(2.6, 5);
    expect(previewWorkingWeeksPerChamber(saved, holidays)).toBeCloseTo(35.4, 5);
    expect(previewEfficientLabWeeks(saved, holidays)).toBeCloseTo(84.96, 5);
    // editing breakdown 11 → 5 previews 41.4 working weeks
    expect(previewWorkingWeeksPerChamber({ ...saved, breakdown_weeks: 5 }, holidays)).toBeCloseTo(41.4, 5);
  });

  it('a zero weekdays-per-week yields NaN rather than Infinity', () => {
    expect(
      previewWorkingWeeksPerEngineer({
        weekdays_per_week: 0,
        national_holiday_days: 1,
        medical_leave_days: 0,
        casual_leave_days: 0,
        annual_leave_days: 0,
      }),
    ).toBeNaN();
  });
});

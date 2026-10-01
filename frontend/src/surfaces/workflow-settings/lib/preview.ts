/**
 * PREVIEW-ONLY re-evaluation of the two ADR 0008 supply formulas while a
 * calendar / chamber form is being edited, so the editor sees what a change
 * would do before saving. Every figure produced here is labelled "preview" in
 * the UI and is discarded on save: the SAVED value is whatever the server
 * returns (`working_weeks_per_engineer`, `working_weeks_per_chamber`,
 * `efficient_lab_weeks` on the `GET` payload — Invariant I17).
 */

export interface CalendarInputs {
  weekdays_per_week: number;
  national_holiday_days: number;
  medical_leave_days: number;
  casual_leave_days: number;
  annual_leave_days: number;
  weeks_in_year?: number;
}

export function previewDeductionWeeks(c: CalendarInputs): number {
  if (!(c.weekdays_per_week > 0)) return Number.NaN;
  return (
    (c.national_holiday_days + c.medical_leave_days + c.casual_leave_days + c.annual_leave_days) /
    c.weekdays_per_week
  );
}

/** `working_weeks_per_engineer = 52 − Σ(days / weekdays_per_week)`. */
export function previewWorkingWeeksPerEngineer(c: CalendarInputs): number {
  return (c.weeks_in_year ?? 52) - previewDeductionWeeks(c);
}

export interface ChamberInputs {
  platforms: number;
  efficiency: number;
  maintenance_weeks: number;
  breakdown_weeks: number;
  calibration_weeks: number;
}

/** The region's holiday weeks are not on the chamber row; back them out of the
 *  SAVED figures so the preview only re-applies the edited downtime. */
export function impliedHolidayWeeks(saved: ChamberInputs & { working_weeks_per_chamber: number }): number {
  return (
    52 -
    saved.working_weeks_per_chamber -
    saved.maintenance_weeks -
    saved.breakdown_weeks -
    saved.calibration_weeks
  );
}

/** `working_weeks_per_chamber = 52 − holidays − maintenance − breakdown − calibration`. */
export function previewWorkingWeeksPerChamber(edited: ChamberInputs, holidayWeeks: number): number {
  return 52 - holidayWeeks - edited.maintenance_weeks - edited.breakdown_weeks - edited.calibration_weeks;
}

/** `efficient_lab_weeks = working_weeks × efficiency × platforms`. */
export function previewEfficientLabWeeks(edited: ChamberInputs, holidayWeeks: number): number {
  return previewWorkingWeeksPerChamber(edited, holidayWeeks) * edited.efficiency * edited.platforms;
}

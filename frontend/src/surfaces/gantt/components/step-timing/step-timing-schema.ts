import { z } from 'zod';

import { SCHEDULER_HORIZON_WEEKS } from '@/lib/domain-constants';
import { DURATION_OVERRIDE_MAX_WEEKS } from '../../lib/gantt-coordinates';

/** P32 (API_CONTRACT_P32 A3): `overlap_weeks` is 0..104. */
export const OVERLAP_MAX_WEEKS = 104;

/**
 * Client-side mirror of `StepTimingRequest` (`backend/schemas/step_timing.py`,
 * ADR 0019): duration 1..104 weeks, earliest start 1..78 or blank (no floor) — the
 * server's range (P32-R02), so a step already floored at W53+ still saves.
 * Client validation is for responsiveness only; the server re-validates.
 */
export const stepTimingFormSchema = z.object({
  durationWeeks: z.coerce
    .number({ invalid_type_error: `Enter a duration of 1–${String(DURATION_OVERRIDE_MAX_WEEKS)} weeks.` })
    .int('Whole weeks only.')
    .min(1, `Enter a duration of 1–${String(DURATION_OVERRIDE_MAX_WEEKS)} weeks.`)
    .max(DURATION_OVERRIDE_MAX_WEEKS, `Enter a duration of 1–${String(DURATION_OVERRIDE_MAX_WEEKS)} weeks.`),
  // The input holds a string ('' = no floor); the output is a week or null.
  startNotBeforeWeek: z
    .string()
    .transform((v) => (v.trim() === '' ? null : Number(v)))
    .pipe(
      z
        .number({ invalid_type_error: `Enter a week of 1–${String(SCHEDULER_HORIZON_WEEKS)}, or leave it blank.` })
        .int('Whole weeks only.')
        .min(1, `Enter a week of 1–${String(SCHEDULER_HORIZON_WEEKS)}, or leave it blank.`)
        .max(SCHEDULER_HORIZON_WEEKS, `Enter a week of 1–${String(SCHEDULER_HORIZON_WEEKS)}, or leave it blank.`)
        .nullable(),
    ),
  // P32 (ADR 0043): weeks this step may start before the work it waits for
  // ends; 0 = none (sent as null).
  overlapWeeks: z.coerce
    .number({ invalid_type_error: `Enter an overlap of 0–${String(OVERLAP_MAX_WEEKS)} weeks.` })
    .int('Whole weeks only.')
    .min(0, `Enter an overlap of 0–${String(OVERLAP_MAX_WEEKS)} weeks.`)
    .max(OVERLAP_MAX_WEEKS, `Enter an overlap of 0–${String(OVERLAP_MAX_WEEKS)} weeks.`),
});

export type StepTimingFormInput = z.input<typeof stepTimingFormSchema>;
export type StepTimingFormValues = z.output<typeof stepTimingFormSchema>;

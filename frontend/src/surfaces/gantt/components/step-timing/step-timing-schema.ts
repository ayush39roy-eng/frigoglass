import { z } from 'zod';

import { HORIZON_WEEKS } from '@/lib/domain-constants';
import { DURATION_OVERRIDE_MAX_WEEKS } from '../../lib/gantt-coordinates';

/**
 * Client-side mirror of `StepTimingRequest` (`backend/schemas/step_timing.py`,
 * ADR 0019): duration 1..104 weeks, earliest start 1..78 or blank (no floor).
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
        .number({ invalid_type_error: `Enter a week of 1–${String(HORIZON_WEEKS)}, or leave it blank.` })
        .int('Whole weeks only.')
        .min(1, `Enter a week of 1–${String(HORIZON_WEEKS)}, or leave it blank.`)
        .max(HORIZON_WEEKS, `Enter a week of 1–${String(HORIZON_WEEKS)}, or leave it blank.`)
        .nullable(),
    ),
});

export type StepTimingFormInput = z.input<typeof stepTimingFormSchema>;
export type StepTimingFormValues = z.output<typeof stepTimingFormSchema>;

import { z } from 'zod';

import { DISPLAY_HORIZON_WEEKS } from '@/lib/domain-constants';

/**
 * Client-side shape mirror of `FreezeToggleRequest` (`backend/schemas/gantt.py`).
 * `actual_start_week` is required whenever `frozen` is `true` — the backend 422s
 * otherwise (`_validate_schedulable_project`). Client validation is for
 * responsiveness only; the backend re-validates and is the authority
 * (`frontend-builder` SKILL). Same `z.coerce.number()` pattern as the Matrix
 * score-edit form.
 */
export const freezeFormSchema = z.object({
  actualStartWeek: z.coerce
    .number({ invalid_type_error: `Enter the actual start week (1–${String(DISPLAY_HORIZON_WEEKS)}).` })
    .int('Whole weeks only.')
    .min(1, `Enter the actual start week (1–${String(DISPLAY_HORIZON_WEEKS)}).`)
    .max(DISPLAY_HORIZON_WEEKS, `Week must be between 1 and ${String(DISPLAY_HORIZON_WEEKS)}.`),
});

/** Input type (pre-coercion) — what the RHF field holds. */
export type FreezeFormInput = z.input<typeof freezeFormSchema>;
/** Output type (post-coercion) — a validated week number. */
export type FreezeFormValues = z.output<typeof freezeFormSchema>;

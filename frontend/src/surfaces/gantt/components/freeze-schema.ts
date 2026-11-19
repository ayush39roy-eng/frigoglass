import { z } from 'zod';

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
    .number({ invalid_type_error: 'Enter the actual start week.' })
    .int('Whole weeks only.')
    // P53 (R53-1): weeks are absolute (2027 W1 = 53); the upper bound is the
    // server's, never a client constant (I40).
    .min(1, 'Enter the actual start week (from week 1).'),
});

/** Input type (pre-coercion) — what the RHF field holds. */
export type FreezeFormInput = z.input<typeof freezeFormSchema>;
/** Output type (post-coercion) — a validated week number. */
export type FreezeFormValues = z.output<typeof freezeFormSchema>;

import { z } from 'zod';

/**
 * Client-side mirror of `backend/schemas/chamber.py`'s field constraints
 * (`extra="forbid"`; `code` 1–50 chars; `max_concurrent` `gt=0` integer;
 * `platforms` `gt=0` integer; `efficiency` `gt=0`; `weeks_per_chamber` `ge=0`).
 * Numeric fields kept as strings through `react-hook-form` — see
 * `surfaces/registration/components/project-form-schema.ts`'s module
 * docstring for why (same reasoning, not re-derived per form). `lab_region`
 * and `allowed_stages` are local component state merged in at submit.
 */

const INTEGER_PATTERN = /^\d+$/;
const NUMBER_PATTERN = /^\d+(\.\d+)?$/;

export const chamberFormSchema = z.object({
  code: z.string().min(1, 'Code is required').max(50, 'Max 50 characters'),
  max_concurrent: z
    .string()
    .min(1, 'Max concurrent is required')
    .refine((v) => INTEGER_PATTERN.test(v.trim()), 'Enter a whole number')
    .refine((v) => Number(v) > 0, 'Must be greater than 0'),
  platforms: z
    .string()
    .optional()
    .refine((v) => v === undefined || v.trim() === '' || INTEGER_PATTERN.test(v.trim()), 'Enter a whole number')
    .refine((v) => v === undefined || v.trim() === '' || Number(v) > 0, 'Must be greater than 0'),
  efficiency: z
    .string()
    .optional()
    .refine((v) => v === undefined || v.trim() === '' || NUMBER_PATTERN.test(v.trim()), 'Enter a number')
    .refine((v) => v === undefined || v.trim() === '' || Number(v) > 0, 'Must be greater than 0'),
  weeks_per_chamber: z
    .string()
    .optional()
    .refine((v) => v === undefined || v.trim() === '' || NUMBER_PATTERN.test(v.trim()), 'Enter a number')
    .refine((v) => v === undefined || v.trim() === '' || Number(v) >= 0, 'Must be 0 or more'),
});

export type ChamberFormInput = z.input<typeof chamberFormSchema>;
export type ChamberFormValues = z.output<typeof chamberFormSchema>;

/** `undefined`/empty string → `undefined`; otherwise the parsed number. Called
 *  only after `chamberFormSchema` has already validated the string. */
export function parseOptionalNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  return Number(value);
}

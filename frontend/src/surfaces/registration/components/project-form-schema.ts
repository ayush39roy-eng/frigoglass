import { z } from 'zod';

/**
 * Client-side mirror of `backend/schemas/project.py`'s field constraints
 * (`extra="forbid"`; `name` 1–300 chars; non-negative money fields; etc).
 *
 * Client validation is for responsiveness only — the backend is the authority
 * (`frontend-builder` SKILL). Numeric fields are kept as plain strings through
 * `react-hook-form` (matching a native `<input type="number">`'s string
 * value) and validated with a regex + range check here; the string→number
 * conversion to build the actual `POST`/`PATCH` body happens explicitly in
 * `project-form.tsx`'s submit handler, not inside this schema — this avoids
 * relying on `zod`'s `coerce`/`preprocess` input/output type inference, which
 * does not play well with `@hookform/resolvers`' generic `Resolver` type in
 * this project's installed versions. Only the enum selects (hub, leader,
 * category, type, priority) and the `carry_over` checkbox are held in local
 * component state and merged in at submit — same pattern as the Matrix's
 * `score-edit-dialog.tsx` (hard-gate checkboxes held outside RHF).
 */

const NUMBER_PATTERN = /^-?\d+(\.\d+)?$/;
const INTEGER_PATTERN = /^-?\d+$/;

function optionalNumericString(opts: {
  integer?: boolean;
  min?: number;
  message?: string;
}): z.ZodType<string | undefined, z.ZodTypeDef, string | undefined> {
  const pattern = opts.integer ? INTEGER_PATTERN : NUMBER_PATTERN;
  const typeMessage = opts.message ?? (opts.integer ? 'Enter a whole number' : 'Enter a number');
  return z
    .string()
    .optional()
    .refine((v) => v === undefined || v.trim() === '' || pattern.test(v.trim()), typeMessage)
    .refine((v) => {
      if (opts.min === undefined) return true;
      if (v === undefined || v.trim() === '') return true;
      return Number(v) >= opts.min;
    }, `Must be ${String(opts.min ?? 0)} or more`);
}

export const projectFormSchema = z.object({
  name: z.string().min(1, 'Name is required').max(300, 'Max 300 characters'),
  external_code: z.string().max(100, 'Max 100 characters').optional(),
  actual_start_week: optionalNumericString({ integer: true, min: 1 }),
  delay_weeks: optionalNumericString({ integer: true, min: 0 }),
  reg_year: optionalNumericString({ integer: true }),
  comments: z.string().max(10_000, 'Max 10,000 characters').optional(),
  // Commercially sensitive (CLAUDE.md) — validated the same as any other
  // field; never logged (see the form component's submit handler).
  customer_name: z.string().max(300, 'Max 300 characters').optional(),
  tcogs_eur: optionalNumericString({ min: 0 }),
  selling_price_eur: optionalNumericString({ min: 0 }),
  gross_margin_pct: optionalNumericString({}),
  capex_keur: optionalNumericString({ min: 0 }),
  rm_savings_keur: optionalNumericString({ min: 0 }),
});

export type ProjectFormInput = z.input<typeof projectFormSchema>;
export type ProjectFormValues = z.output<typeof projectFormSchema>;

/** `undefined`/empty string → `undefined`; otherwise the parsed number.
 *  Called only after `projectFormSchema` has already validated the string. */
export function parseOptionalNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  return Number(value);
}

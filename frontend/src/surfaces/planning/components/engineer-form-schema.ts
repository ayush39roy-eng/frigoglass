import { z } from 'zod';

/**
 * Client-side mirror of `backend/schemas/engineer.py`'s field constraints
 * (`extra="forbid"`; `name` 1–200 chars; `fte` `gt=0`).
 *
 * `fte` is kept as a plain string through `react-hook-form` (matching a
 * native `<input type="number">`'s string value) and validated with a regex +
 * range check here, converted to a number only at submit — same pattern (and
 * same reason, documented once in `surfaces/registration/components/
 * project-form-schema.ts`'s module docstring) used by every other P4 form:
 * `zod`'s `coerce`/`preprocess` output-type inference does not compose with
 * `@hookform/resolvers`' generic `Resolver` type in this project's installed
 * versions. Hub / allowed-categories are held in local component state and
 * merged in at submit, same pattern as Registration's hub/leader selects.
 */

const NUMBER_PATTERN = /^\d+(\.\d+)?$/;

export const engineerFormSchema = z.object({
  name: z.string().min(1, 'Name is required').max(200, 'Max 200 characters'),
  fte: z
    .string()
    .min(1, 'FTE is required')
    .refine((v) => NUMBER_PATTERN.test(v.trim()), 'Enter a positive number')
    .refine((v) => Number(v) > 0, 'FTE must be greater than 0'),
});

export type EngineerFormInput = z.input<typeof engineerFormSchema>;
export type EngineerFormValues = z.output<typeof engineerFormSchema>;

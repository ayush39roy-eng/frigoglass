import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import { importParseResponseSchema, importSimulateResponseSchema } from './import-schema';

// Regression (2026-11-23): zod strips keys a schema does not list, so the served
// "Plan year" presets never reached the picker (only the default year showed)
// and the What-if import delivery-by-year table was dropped.
const shape = (s: unknown) => (s as z.ZodObject<z.ZodRawShape>).shape;

describe('What-if import response schemas keep the P53 fields', () => {
  it('parse response keeps plan_until_presets', () => {
    expect(shape(importParseResponseSchema)).toHaveProperty('plan_until_presets');
  });
  it('simulate response keeps plan_until_presets, delivery_by_year and last_finish_week', () => {
    const s = shape(importSimulateResponseSchema);
    expect(s).toHaveProperty('plan_until_presets');
    expect(s).toHaveProperty('delivery_by_year');
    expect(s).toHaveProperty('last_finish_week');
  });
});

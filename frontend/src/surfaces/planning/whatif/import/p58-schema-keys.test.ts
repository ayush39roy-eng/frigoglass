import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import { importParseResponseSchema, importSimulateResponseSchema, savedScenarioSchema } from './import-schema';
import { p41Saved } from './p41-fixtures';
import { SIMULATE_RESPONSE } from './test-fixtures';

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

// Sweep (2026-11-23): every served key of the import responses is listed (diffed
// against the OpenAPI models), and the served-nullable ones accept null. A
// non-null schema fails the WHOLE response (ImportShapeError), not just a field.
describe('What-if import simulate schema matches the served model', () => {
  const project = SIMULATE_RESPONSE.projects[0];
  if (project === undefined) throw new Error('fixture has no project');

  it('lists delivery_by_year_unavailable', () => {
    expect(shape(importSimulateResponseSchema)).toHaveProperty('delivery_by_year_unavailable');
  });

  it('keeps priority_applicable and accepts a null priority / category (ADR 0067)', () => {
    const served = {
      ...SIMULATE_RESPONSE,
      delivery_by_year: null,
      delivery_by_year_unavailable: 'pre_p53_run',
      projects: [{ ...project, priority: null, category: null, priority_applicable: false, status: 'Cancelled' }],
      plan_projects: [{ id: 'p-x', name: 'X', hub: 'R&D-Greece', category: null, priority: null, status: 'Commercialized' }],
    };
    const r = importSimulateResponseSchema.safeParse(served);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.delivery_by_year_unavailable).toBe('pre_p53_run');
    expect(r.data.projects[0]?.priority_applicable).toBe(false);
    expect(r.data.projects[0]?.priority).toBeNull();
    expect(r.data.projects[0]?.category).toBeNull();
    expect(r.data.plan_projects?.[0]?.priority).toBeNull();
  });

  it('a saved scenario result keeps the same fields', () => {
    const saved = p41Saved();
    const served = {
      ...saved,
      result: {
        ...saved.result,
        delivery_by_year_unavailable: 'pre_p53_run',
        projects: [{ ...project, priority: null, priority_applicable: false }],
      },
    };
    const r = savedScenarioSchema.safeParse(served);
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data.result.delivery_by_year_unavailable).toBe('pre_p53_run');
    expect(r.data.result.projects[0]?.priority_applicable).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';

import { validateFormatDraft, withAlias, normaliseAlias, draftBody, draftOf } from './import-format';
import { buildSimulateRequest, editsForRequest } from './import-rows';
import { importSimulateResponseSchema, savedScenarioSchema } from './import-schema';
import type { ImportFormat, SavedScenarioSummary } from './import-types';
import { filterPicks, initialTicks, NO_PICK_FILTERS, pickItems, picksToRequest, pickValues } from './project-picks';
import { exportableIds, mixedClock, mixedSources } from './scenario-compare';
import { groupBySource, savedBannerTitle } from './saved-scenarios';
import { ROWS, SIMULATE_RESPONSE } from './test-fixtures';
import { p41Format, p41Saved, p41Summary, PLAN_PROJECTS } from './p41-fixtures';

/** P41 (ADR 0055): the pure parts of the format editor, picker, library and compare. */

const OPTS = { mode: 'merge' as const, planYearEndWeek: 104 as const, expandMulti: true };

describe('import format draft checks', () => {
  const format: ImportFormat = p41Format();

  it('accepts the served format and builds a PUT body in served order', () => {
    const draft = draftOf(format);
    expect(validateFormatDraft(format, draft)).toEqual({ fields: {}, form: null });
    expect(Object.keys(draftBody(format, draft))).toEqual(format.fields.map((f) => f.key));
  });

  it('normalises like the parser and refuses an alias shared by two fields', () => {
    expect(normaliseAlias('  Project   DESCRIPTION ')).toBe('project description');
    expect(withAlias(['project description'], 'Project  Description')).toEqual(['project description']);
    const draft = { ...draftOf(format), hub: ['rpd hub', 'Project Description'] };
    expect(validateFormatDraft(format, draft).fields.hub).toMatch(/already a header name of Project name/);
  });

  it('needs every field but one of Status / Hub, and caps at 10 names of ≤ 60 characters', () => {
    expect(validateFormatDraft(format, { ...draftOf(format), status: [] })).toEqual({ fields: {}, form: null });
    const neither = validateFormatDraft(format, { ...draftOf(format), status: [], hub: [] });
    expect(neither.form).toBe('Status or Hub needs at least one header name.');
    expect(validateFormatDraft(format, { ...draftOf(format), name: [] }).fields.name).toMatch(/at least one/);
    expect(validateFormatDraft(format, { ...draftOf(format), plant: [] }).fields.plant).toMatch(/Plant needs/);
    const many = Array.from({ length: 11 }, (_, i) => `plant ${String(i)}`);
    expect(validateFormatDraft(format, { ...draftOf(format), plant: many }).fields.plant).toMatch(/At most 10/);
    expect(validateFormatDraft(format, { ...draftOf(format), plant: ['x'.repeat(61)] }).fields.plant).toMatch(/1–60/);
  });
});

describe('hand-picked scenario request', () => {
  it('sends exclude_plan_project_ids in merge mode only, sorted and unique, and drops their edits', () => {
    const edits = {
      'plan-1|PDD-E': { project_ref: 'plan-1', step_id: 'PDD-E', duration_weeks: 3, start_not_before_week: null, overlap_weeks: null },
      'plan-2|PDD-E': { project_ref: 'plan-2', step_id: 'PDD-E', duration_weeks: 3, start_not_before_week: null, overlap_weeks: null },
    };
    const body = buildSimulateRequest(ROWS, OPTS, edits, ['plan-2', 'plan-1', 'plan-2']);
    expect(body.exclude_plan_project_ids).toEqual(['plan-1', 'plan-2']);
    expect(body.edits).toEqual([]);
    expect(buildSimulateRequest(ROWS, OPTS, {}, [])).not.toHaveProperty('exclude_plan_project_ids');
    expect(buildSimulateRequest(ROWS, { ...OPTS, mode: 'file_only' }, {}, ['plan-1'])).not.toHaveProperty(
      'exclude_plan_project_ids',
    );
    expect(editsForRequest(edits, ROWS, OPTS, ['plan-1']).map((e) => e.project_ref)).toEqual(['plan-2']);
  });

  it('lists file rows and served plan projects; ticks map to include + exclusions', () => {
    const rows = ROWS.map((r, i) => (i === 2 ? { ...r, status: 'On Hold', include: false } : r));
    const items = pickItems(rows, PLAN_PROJECTS, 'merge');
    expect(items.map((it) => it.id)).toEqual(['file:row-5', 'file:row-6', 'file:row-7', 'plan:plan-1', 'plan:plan-2']);
    expect(items[2]?.locked).toBe('On Hold: not scheduled');
    expect(pickItems(rows, PLAN_PROJECTS, 'file_only')).toHaveLength(3);
    const ticks = initialTicks(rows, PLAN_PROJECTS, ['plan-2']);
    expect([...ticks].sort()).toEqual(['file:row-5', 'file:row-6', 'plan:plan-1']);
    ticks.delete('file:row-6');
    const out = picksToRequest(items, ticks);
    expect([...out.includedKeys]).toEqual(['row-5']);
    expect(out.excludedPlanIds).toEqual(['plan-2']);
    expect(filterPicks(items, { ...NO_PICK_FILTERS, source: 'plan' }).map((it) => it.ref)).toEqual(['plan-1', 'plan-2']);
    expect(filterPicks(items, { ...NO_PICK_FILTERS, query: 'freezer' }).map((it) => it.ref)).toEqual(['row-6']);
  });
});

describe('P57 (ADR 0067): the picker priority filter uses the effective priority', () => {
  it('a Commercialized / Cancelled project reads "Not applicable" and never matches a P4 pick', () => {
    const rows = ROWS.map((r, i) => (i === 0 ? { ...r, status: 'Commercialized', priority: 'P4' as const, include: false } : r));
    const plan = [
      ...PLAN_PROJECTS,
      { id: 'plan-3', name: 'Retired Cooler', hub: 'PD-India', category: 'B', priority: 'P4', status: 'Cancelled' },
      { id: 'plan-4', name: 'Live P4 Cooler', hub: 'PD-India', category: 'B', priority: 'P4', status: 'In Queue' },
    ];
    const items = pickItems(rows, plan, 'merge');
    const byRef = new Map(items.map((it) => [it.ref, it]));
    expect(byRef.get(rows[0]!.key)?.priority).toBe('Not applicable');
    expect(byRef.get('plan-3')?.priority).toBe('Not applicable');
    expect(byRef.get('plan-4')?.priority).toBe('P4');
    const p4 = filterPicks(items, { ...NO_PICK_FILTERS, priority: 'P4' }).map((it) => it.ref);
    expect(p4).toContain('plan-4');
    expect(p4).not.toContain('plan-3');
    expect(p4).not.toContain(rows[0]!.key);
    expect(filterPicks(items, { ...NO_PICK_FILTERS, priority: 'Not applicable' }).map((it) => it.ref).sort()).toEqual(
      [rows[0]!.key, 'plan-3'].sort(),
    );
    expect(pickValues(items, 'priority')).toContain('Not applicable');
  });
});

describe('saved scenarios', () => {
  it('validates a stored scenario and a pre-P41 response (plan_excluded / plan_projects optional)', () => {
    expect(savedScenarioSchema.safeParse(p41Saved()).success).toBe(true);
    expect(importSimulateResponseSchema.safeParse(SIMULATE_RESPONSE).success).toBe(true);
  });

  it('groups the library by source file and import date, in served order', () => {
    const items: SavedScenarioSummary[] = [
      p41Summary({ id: 'a', source_file_sha256: 'f1', imported_at: '2026-11-17T09:00:00Z', source_file_name: 'plan-nov.xlsx' }),
      p41Summary({ id: 'b', source_file_sha256: 'f2', imported_at: '2026-11-10T09:00:00Z', source_file_name: 'plan-oct.xlsx' }),
      p41Summary({ id: 'c', source_file_sha256: 'f1', imported_at: '2026-11-17T15:00:00Z', source_file_name: 'plan-nov.xlsx' }),
      p41Summary({ id: 'd', source_file_sha256: 'f1', imported_at: '2026-11-03T15:00:00Z', source_file_name: 'plan-nov.xlsx' }),
    ];
    const groups = groupBySource(items);
    expect(groups.map((g) => [g.fileName, g.items.map((i) => i.id)])).toEqual([
      ['plan-nov.xlsx', ['a', 'c']],
      ['plan-oct.xlsx', ['b']],
      ['plan-nov.xlsx', ['d']],
    ]);
    expect(savedBannerTitle(47, 14)).toBe('Saved scenario — simulated W47 against plan v14');
    expect(savedBannerTitle(47, null)).toBe('Saved scenario — simulated W47');
  });

  it('flags mixed sources / clocks and exports only all-saved comparisons of 2–4', () => {
    const session = { fileName: 'a.xlsx', response: SIMULATE_RESPONSE };
    const stored = (id: string, week: number, v: number | null, file = 'a.xlsx') => ({
      fileName: file,
      response: SIMULATE_RESPONSE,
      stored: { id, simulatedWeek: week, planVersion: v },
    });
    expect(mixedSources([session, stored('s1', 42, 14)])).toBe(false);
    expect(mixedSources([session, stored('s1', 42, 14, 'b.xlsx')])).toBe(true);
    expect(mixedClock([session, stored('s1', 42, 14)])).toBe(false);
    expect(mixedClock([session, stored('s1', 40, 14)])).toBe(true);
    expect(mixedClock([stored('s1', 42, 13), stored('s2', 42, 14)])).toBe(true);
    expect(exportableIds([session, stored('s1', 42, 14)])).toBeNull();
    expect(exportableIds([stored('s1', 42, 14)])).toBeNull();
    expect(exportableIds([stored('s1', 42, 14), stored('s2', 40, 13)])).toEqual(['s1', 's2']);
  });
});

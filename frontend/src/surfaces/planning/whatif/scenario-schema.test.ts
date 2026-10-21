import { describe, expect, it } from 'vitest';

import { askFixture } from './test-fixtures';
import {
  LINE_FACTORIES,
  MAX_LINES,
  buildScenarioRequest,
  categoriesForHub,
  linesFromChatScenario,
  parseDesignerFte,
  WHATIF_STATUSES,
  type ScenarioLines,
} from './scenario-schema';
import { SCHEDULABLE_STATUSES } from '@/types/enums';

const empty = (): ScenarioLines => ({ projects: [], engineers: [], removals: [], chambers: [], downtime: [] });

describe('buildScenarioRequest (mirrors the server limits)', () => {
  it('treats no lines as the empty scenario and sends nothing invalid', () => {
    const v = buildScenarioRequest(empty());
    expect(v.empty).toBe(true);
    expect(v.request).toEqual({
      add_projects: [],
      add_engineers: [],
      remove_engineer_counts: [],
      add_chambers: [],
      chamber_downtime: [],
    });
  });

  it('builds the exact request body for a valid project line', () => {
    const l = empty();
    l.projects.push({ ...LINE_FACTORIES.projects(), hub: 'PD-India', category: 'A', count: '5', priority: 'P2', score: '' });
    const v = buildScenarioRequest(l);
    expect(v.request?.add_projects).toEqual([
      {
        hub: 'PD-India',
        category: 'A',
        count: 5,
        project_type: null,
        status: 'In Queue',
        priority: 'P2',
        score: null,
        workflow_id: null,
        certification_testing_required: true,
      },
    ]);
  });

  it.each([
    ['0', 'Must be at least 1'],
    ['201', 'Must be at most 200'],
    ['2.5', 'Enter a whole number'],
    ['', 'Count is required'],
    ['abc', 'Enter a whole number'],
  ])('rejects project count %j', (count, message) => {
    const l = empty();
    const line = { ...LINE_FACTORIES.projects(), count };
    l.projects.push(line);
    const v = buildScenarioRequest(l);
    expect(v.request).toBeNull();
    expect(v.errors[line.key]?.count).toBe(message);
  });

  it('rejects a category that does not belong to the hub workflow, both ways', () => {
    const l = empty();
    const a = { ...LINE_FACTORIES.projects(), hub: 'OEM-HCK' as const, category: 'A' as const };
    const b = { ...LINE_FACTORIES.projects(), hub: 'PD-India' as const, category: 'A-OEM' as const };
    l.projects.push(a, b);
    const v = buildScenarioRequest(l);
    expect(v.errors[a.key]?.category).toMatch(/OEM hubs use/);
    expect(v.errors[b.key]?.category).toMatch(/A\+, A, B and C/);
    expect(categoriesForHub('OEM-Seltek')).toEqual(['A-OEM', 'B-OEM', 'C-OEM']);
  });

  it('bounds designer FTE to (0, 1] and count to 1..50', () => {
    const l = empty();
    const bad = { ...LINE_FACTORIES.engineers(), fte: '0', count: '51' };
    const high = { ...LINE_FACTORIES.engineers(), fte: '1.2' };
    const ok = { ...LINE_FACTORIES.engineers(), fte: '0.5', count: '2' };
    l.engineers.push(bad, high, ok);
    const v = buildScenarioRequest(l);
    expect(v.errors[bad.key]).toEqual({ fte: 'Must be more than 0', count: 'Must be at most 50' });
    expect(v.errors[high.key]?.fte).toBe('Must be at most 1');
    expect(v.errors[ok.key]).toBeUndefined();
  });

  it('bounds chamber fields (platforms 1..20, efficiency 0..1.5, weeks 0..52, count 1..20) and leaves blanks null', () => {
    const l = empty();
    const bad = {
      ...LINE_FACTORIES.chambers(),
      count: '21',
      platforms: '21',
      efficiency: '1.6',
      maintenance: '53',
      breakdown: '-1',
    };
    l.chambers.push(bad);
    const v = buildScenarioRequest(l);
    expect(Object.keys(v.errors[bad.key] ?? {}).sort()).toEqual(
      ['breakdown', 'count', 'efficiency', 'maintenance', 'platforms'].sort(),
    );

    const good = empty();
    good.chambers.push({ ...LINE_FACTORIES.chambers(), labRegion: 'Romania', count: '2' });
    expect(buildScenarioRequest(good).request?.add_chambers).toEqual([
      {
        lab_region: 'Romania',
        count: 2,
        platforms: null,
        efficiency: null,
        maintenance_weeks: null,
        breakdown_weeks: null,
        calibration_weeks: null,
        allowed_stages: null,
      },
    ]);
  });

  it('requires a chamber and at least one downtime value', () => {
    const l = empty();
    const line = LINE_FACTORIES.downtime();
    l.downtime.push(line);
    expect(buildScenarioRequest(l).errors[line.key]).toEqual({
      chamberId: 'Choose a chamber',
      maintenance: 'Enter at least one downtime value',
    });
    const ok = empty();
    ok.downtime.push({ ...line, chamberId: 'ch-1', breakdown: '6' });
    expect(buildScenarioRequest(ok).request?.chamber_downtime).toEqual([
      { chamber_id: 'ch-1', maintenance_weeks: null, breakdown_weeks: 6, calibration_weeks: null },
    ]);
  });

  it('caps every list at 30 lines', () => {
    const l = empty();
    for (let i = 0; i < MAX_LINES + 1; i += 1) l.removals.push(LINE_FACTORIES.removals());
    const v = buildScenarioRequest(l);
    expect(v.request).toBeNull();
    expect(v.listErrors[0]).toMatch(/at most 30 lines/);
  });

  it('validates the designer FTE used by estimate and solve', () => {
    expect(parseDesignerFte('1')).toEqual({ value: 1 });
    expect(parseDesignerFte('0.5')).toEqual({ value: 0.5 });
    expect(parseDesignerFte('0').error).toBeDefined();
    expect(parseDesignerFte('2').error).toBeDefined();
    expect(parseDesignerFte('').error).toBeDefined();
  });
});

describe('linesFromChatScenario', () => {
  it('round-trips the chat scenario through the form into an identical request', () => {
    const scenario = {
      ...askFixture().scenario,
      add_engineers: [{ hub: 'PD-India' as const, fte: 0.5, count: 2, allowed_categories: ['A' as const, 'B' as const] }],
      add_chambers: [
        {
          lab_region: 'Romania' as const,
          count: 1,
          platforms: 2,
          efficiency: 0.9,
          maintenance_weeks: 2,
          breakdown_weeks: null,
          calibration_weeks: 1,
          allowed_stages: ['PDD-F'],
        },
      ],
      remove_engineer_counts: [{ hub: 'R&D-Greece' as const, count: 1 }],
      chamber_downtime: [{ chamber_id: 'ch-9', maintenance_weeks: 6, breakdown_weeks: null, calibration_weeks: null }],
    };
    const v = buildScenarioRequest(linesFromChatScenario(scenario));
    expect(v.errors).toEqual({});
    expect(v.request).toEqual(scenario);
  });
});

describe('totals across lines (S18-M1 caps 200 / 50 / 50 / 20)', () => {
  it('counts a running total per kind and leaves the allowance', () => {
    const l = empty();
    l.projects.push({ ...LINE_FACTORIES.projects(), count: '120' }, { ...LINE_FACTORIES.projects(), count: '30' });
    l.chambers.push({ ...LINE_FACTORIES.chambers(), count: '5' });
    const v = buildScenarioRequest(l);
    const by = Object.fromEntries(v.totals.map((t) => [t.key, t]));
    expect(by.projects).toMatchObject({ total: 150, cap: 200, remaining: 50, over: false });
    expect(by.chambers).toMatchObject({ total: 5, cap: 20, remaining: 15 });
    expect(by.designersAdded).toMatchObject({ total: 0, cap: 50 });
    expect(by.designersRemoved).toMatchObject({ total: 0, cap: 50 });
    expect(v.request).not.toBeNull();
  });

  it.each([
    ['projects', '120', '120', 200, 'projects added'],
    ['engineers', '30', '30', 50, 'designers added'],
    ['removals', '30', '30', 50, 'designers removed'],
    ['chambers', '12', '12', 20, 'chambers added'],
  ] as const)('blocks %s whose lines are each within the cap but whose total is not', (list, c1, c2, cap, noun) => {
    const l = empty();
    (l[list] as { count: string }[]).push({ ...LINE_FACTORIES[list](), count: c1 }, { ...LINE_FACTORIES[list](), count: c2 });
    const v = buildScenarioRequest(l);
    expect(v.request).toBeNull();
    expect(Object.keys(v.errors)).toEqual([]);
    expect(v.listErrors.join(' ')).toContain(`At most ${String(cap)} ${noun} in one scenario`);
    expect(v.totals.some((t) => t.over)).toBe(true);
  });

  it('allows exactly the cap', () => {
    const l = empty();
    l.projects.push({ ...LINE_FACTORIES.projects(), count: '100' }, { ...LINE_FACTORIES.projects(), count: '100' });
    expect(buildScenarioRequest(l).request).not.toBeNull();
  });
});

describe('what-if statuses (P23-T01)', () => {
  it('offers no In Buyoff; the default is In Queue, which the backend accepts', () => {
    expect(WHATIF_STATUSES).toEqual(['Under Industrialization', 'In Development', 'In Queue']);
    expect(LINE_FACTORIES.projects().status).toBe('In Queue');
    // backend/schemas/whatif.py SchedulableStatusLiteral: every offered value is in it.
    for (const s of WHATIF_STATUSES) expect(SCHEDULABLE_STATUSES).toContain(s);
    const l = empty();
    l.projects.push({ ...LINE_FACTORIES.projects(), hub: 'PD-India', category: 'A', count: '1' });
    expect(buildScenarioRequest(l).request?.add_projects?.[0]?.status).toBe('In Queue');
  });

  it('a chat scenario with In Buyoff still loads and builds unchanged (backend accepts it)', () => {
    const lines = linesFromChatScenario({ add_projects: [{ hub: 'PD-India', category: 'A', status: 'In Buyoff' }] });
    expect(lines.projects[0]?.status).toBe('In Buyoff');
    expect(buildScenarioRequest(lines).request?.add_projects?.[0]?.status).toBe('In Buyoff');
  });
});

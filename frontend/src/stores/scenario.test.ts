import { afterEach, describe, expect, it } from 'vitest';

import type { PriorityScoreUpdateRequest } from '@/surfaces/matrix/api/types';

import {
  computeScenarioDiff,
  effectivePendingEdits,
  isNoOpEdit,
  useScenarioStore,
  type ScenarioPendingEdit,
} from './scenario';

function scores(overrides: Partial<PriorityScoreUpdateRequest> = {}): PriorityScoreUpdateRequest {
  return {
    strategic_project: 3, new_customer: 3, new_options: 3, regulatory_compliance: 3,
    quality_improvements: 3, rm_savings: 3, total_rm_savings: 3, gross_margins: 3,
    profitability: 3, annual_volume: 3, three_year_volume: 3, new_models: 3,
    capex_investment: 3, hard_gates: [],
    ...overrides,
  };
}

function edit(overrides: Partial<ScenarioPendingEdit> = {}): ScenarioPendingEdit {
  return {
    projectId: 'p1',
    projectName: 'A',
    hub: 'R&D-Greece',
    baseline: scores(),
    hasScore: true,
    next: scores(),
    ...overrides,
  };
}

function initialState() {
  return { active: false, notes: '', pending: {}, past: [], future: [] };
}

afterEach(() => {
  useScenarioStore.setState(initialState());
});

describe('useScenarioStore', () => {
  it('defaults to inactive with no pending edits or history', () => {
    const state = useScenarioStore.getState();
    expect(state.active).toBe(false);
    expect(state.pending).toEqual({});
    expect(state.past).toEqual([]);
    expect(state.future).toEqual([]);
  });

  it('setActive toggles scenario mode without touching pending edits', () => {
    useScenarioStore.getState().setActive(true);
    expect(useScenarioStore.getState().active).toBe(true);
    useScenarioStore.getState().stageEdit({
      projectId: 'p1', projectName: 'Cooler A', hub: 'R&D-Greece',
      liveValues: scores(), liveHasScore: true, next: scores({ strategic_project: 5 }),
    });
    useScenarioStore.getState().setActive(false);
    expect(useScenarioStore.getState().active).toBe(false);
    expect(Object.keys(useScenarioStore.getState().pending)).toEqual(['p1']);
  });

  it('setNotes sets free text, not tracked by undo/redo', () => {
    useScenarioStore.getState().setNotes('Q3 replan');
    expect(useScenarioStore.getState().notes).toBe('Q3 replan');
    useScenarioStore.getState().undo();
    expect(useScenarioStore.getState().notes).toBe('Q3 replan');
  });

  describe('stageEdit', () => {
    it('stages a new project edit, capturing the live values + has_score as baseline', () => {
      const live = scores({ strategic_project: 2 });
      const next = scores({ strategic_project: 5 });
      useScenarioStore.getState().stageEdit({
        projectId: 'p1', projectName: 'Cooler A', hub: 'R&D-Greece',
        liveValues: live, liveHasScore: true, next,
      });
      const staged = useScenarioStore.getState().pending.p1;
      expect(staged).toBeDefined();
      expect(staged?.baseline).toEqual(live);
      expect(staged?.hasScore).toBe(true);
      expect(staged?.next).toEqual(next);
      expect(staged?.projectName).toBe('Cooler A');
    });

    it('re-staging the same project keeps the ORIGINAL baseline + hasScore, only updates next', () => {
      const originalLive = scores({ strategic_project: 2 });
      useScenarioStore.getState().stageEdit({
        projectId: 'p1', projectName: 'Cooler A', hub: 'R&D-Greece',
        liveValues: originalLive, liveHasScore: false, next: scores({ strategic_project: 4 }),
      });
      // Second edit passes DIFFERENT "liveValues"/"liveHasScore" (simulating a
      // stale re-read) — the store must not rebase baseline/hasScore onto it.
      useScenarioStore.getState().stageEdit({
        projectId: 'p1', projectName: 'Cooler A', hub: 'R&D-Greece',
        liveValues: scores({ strategic_project: 4 }), liveHasScore: true, next: scores({ strategic_project: 5 }),
      });
      const staged = useScenarioStore.getState().pending.p1;
      expect(staged?.baseline).toEqual(originalLive);
      expect(staged?.hasScore).toBe(false);
      expect(staged?.next).toEqual(scores({ strategic_project: 5 }));
    });
  });

  it('removeEdit drops one project only', () => {
    useScenarioStore.getState().stageEdit({
      projectId: 'p1', projectName: 'A', hub: 'R&D-Greece',
      liveValues: scores(), liveHasScore: true, next: scores({ strategic_project: 5 }),
    });
    useScenarioStore.getState().stageEdit({
      projectId: 'p2', projectName: 'B', hub: 'PD-Romania',
      liveValues: scores(), liveHasScore: true, next: scores({ new_customer: 5 }),
    });
    useScenarioStore.getState().removeEdit('p1');
    expect(Object.keys(useScenarioStore.getState().pending)).toEqual(['p2']);
  });

  it('removeEdit on an unstaged project is a no-op', () => {
    const before = useScenarioStore.getState();
    useScenarioStore.getState().removeEdit('nope');
    expect(useScenarioStore.getState().pending).toEqual(before.pending);
    expect(useScenarioStore.getState().past).toEqual([]);
  });

  describe('undo/redo', () => {
    it('undo reverts the most recent staged edit; redo re-applies it', () => {
      useScenarioStore.getState().stageEdit({
        projectId: 'p1', projectName: 'A', hub: 'R&D-Greece',
        liveValues: scores(), liveHasScore: true, next: scores({ strategic_project: 5 }),
      });
      useScenarioStore.getState().stageEdit({
        projectId: 'p2', projectName: 'B', hub: 'PD-Romania',
        liveValues: scores(), liveHasScore: true, next: scores({ new_customer: 5 }),
      });
      expect(Object.keys(useScenarioStore.getState().pending).sort()).toEqual(['p1', 'p2']);

      useScenarioStore.getState().undo();
      expect(Object.keys(useScenarioStore.getState().pending)).toEqual(['p1']);

      useScenarioStore.getState().undo();
      expect(useScenarioStore.getState().pending).toEqual({});

      useScenarioStore.getState().redo();
      expect(Object.keys(useScenarioStore.getState().pending)).toEqual(['p1']);

      useScenarioStore.getState().redo();
      expect(Object.keys(useScenarioStore.getState().pending).sort()).toEqual(['p1', 'p2']);
    });

    it('undo on an empty past stack is a no-op', () => {
      useScenarioStore.getState().undo();
      expect(useScenarioStore.getState().pending).toEqual({});
      expect(useScenarioStore.getState().past).toEqual([]);
    });

    it('redo on an empty future stack is a no-op', () => {
      useScenarioStore.getState().stageEdit({
        projectId: 'p1', projectName: 'A', hub: 'R&D-Greece',
        liveValues: scores(), liveHasScore: true, next: scores({ strategic_project: 5 }),
      });
      useScenarioStore.getState().redo();
      expect(Object.keys(useScenarioStore.getState().pending)).toEqual(['p1']);
    });

    it('staging a new edit after an undo clears the redo (future) branch', () => {
      useScenarioStore.getState().stageEdit({
        projectId: 'p1', projectName: 'A', hub: 'R&D-Greece',
        liveValues: scores(), liveHasScore: true, next: scores({ strategic_project: 5 }),
      });
      useScenarioStore.getState().stageEdit({
        projectId: 'p2', projectName: 'B', hub: 'PD-Romania',
        liveValues: scores(), liveHasScore: true, next: scores({ new_customer: 5 }),
      });
      useScenarioStore.getState().undo(); // back to just p1; p2 sits in `future`
      expect(useScenarioStore.getState().future.length).toBe(1);

      useScenarioStore.getState().stageEdit({
        projectId: 'p3', projectName: 'C', hub: 'PD-India',
        liveValues: scores(), liveHasScore: true, next: scores({ new_options: 5 }),
      });
      expect(useScenarioStore.getState().future).toEqual([]);
      expect(Object.keys(useScenarioStore.getState().pending).sort()).toEqual(['p1', 'p3']);

      // redo must be inert now — p2's branch was discarded, matching standard
      // undo/redo semantics (a new action prunes the redo stack).
      useScenarioStore.getState().redo();
      expect(Object.keys(useScenarioStore.getState().pending).sort()).toEqual(['p1', 'p3']);
    });

    it('removeEdit is itself undoable', () => {
      useScenarioStore.getState().stageEdit({
        projectId: 'p1', projectName: 'A', hub: 'R&D-Greece',
        liveValues: scores(), liveHasScore: true, next: scores({ strategic_project: 5 }),
      });
      useScenarioStore.getState().removeEdit('p1');
      expect(useScenarioStore.getState().pending).toEqual({});
      useScenarioStore.getState().undo();
      expect(Object.keys(useScenarioStore.getState().pending)).toEqual(['p1']);
    });
  });

  it('reset clears pending edits, history, and notes', () => {
    useScenarioStore.getState().setNotes('scratch note');
    useScenarioStore.getState().stageEdit({
      projectId: 'p1', projectName: 'A', hub: 'R&D-Greece',
      liveValues: scores(), liveHasScore: true, next: scores({ strategic_project: 5 }),
    });
    useScenarioStore.getState().reset();
    const state = useScenarioStore.getState();
    expect(state.pending).toEqual({});
    expect(state.past).toEqual([]);
    expect(state.future).toEqual([]);
    expect(state.notes).toBe('');
  });

  it('reset does not touch `active`', () => {
    useScenarioStore.getState().setActive(true);
    useScenarioStore.getState().reset();
    expect(useScenarioStore.getState().active).toBe(true);
  });
});

describe('isNoOpEdit / effectivePendingEdits / computeScenarioDiff', () => {
  it('isNoOpEdit is true when next is field-for-field identical to baseline (scored project)', () => {
    const baseline = scores({ strategic_project: 4 });
    expect(isNoOpEdit(edit({ baseline, next: { ...baseline } }))).toBe(true);
  });

  it('isNoOpEdit is false when any dimension differs', () => {
    const baseline = scores({ strategic_project: 4 });
    const next = scores({ strategic_project: 5 });
    expect(isNoOpEdit(edit({ baseline, next }))).toBe(false);
  });

  it('isNoOpEdit treats hard_gates as an order-independent set', () => {
    const baseline = scores({ hard_gates: ['Regulatory deadline within 6 months', 'Active safety non-compliance'] });
    const next = scores({ hard_gates: ['Active safety non-compliance', 'Regulatory deadline within 6 months'] });
    expect(isNoOpEdit(edit({ baseline, next }))).toBe(true);
  });

  it('isNoOpEdit is false when hard_gates differ in content', () => {
    const baseline = scores({ hard_gates: ['Active safety non-compliance'] });
    const next = scores({ hard_gates: [] });
    expect(isNoOpEdit(edit({ baseline, next }))).toBe(false);
  });

  it('isNoOpEdit is ALWAYS false for a previously-unscored project (hasScore=false), even if next equals the default baseline', () => {
    const defaultBaseline = scores(); // the neutral 3/5 pre-fill for an unscored project
    expect(
      isNoOpEdit(edit({ hasScore: false, baseline: defaultBaseline, next: { ...defaultBaseline } })),
    ).toBe(false);
  });

  it('effectivePendingEdits filters out no-op edits but keeps genuine changes', () => {
    const pending = {
      p1: edit({ projectId: 'p1' }), // no-op (baseline === next, both default)
      p2: edit({ projectId: 'p2', projectName: 'B', hub: 'PD-Romania', next: scores({ new_customer: 5 }) }),
    };
    const effective = effectivePendingEdits(pending);
    expect(effective.map((e) => e.projectId)).toEqual(['p2']);
  });

  it('effectivePendingEdits always includes an unscored project even with no explicit dimension change', () => {
    const pending = { p1: edit({ hasScore: false }) };
    expect(effectivePendingEdits(pending).map((e) => e.projectId)).toEqual(['p1']);
  });

  it('computeScenarioDiff produces one full-row ScenarioPriorityScoreChange per genuinely-changed project, excluding no-ops', () => {
    const pending = {
      p1: edit({ projectId: 'p1' }), // no-op — excluded
      p2: edit({
        projectId: 'p2', projectName: 'B', hub: 'PD-Romania',
        next: scores({ new_customer: 5, hard_gates: ['Customer certification at risk (Coke/Pepsi)'] }),
      }),
    };
    const diff = computeScenarioDiff(pending);
    expect(diff).toHaveLength(1);
    expect(diff[0]).toEqual({
      project_id: 'p2',
      ...scores({ new_customer: 5, hard_gates: ['Customer certification at risk (Coke/Pepsi)'] }),
    });
  });

  it('computeScenarioDiff returns an empty array when every staged edit is a no-op', () => {
    const pending = { p1: edit() };
    expect(computeScenarioDiff(pending)).toEqual([]);
  });
});

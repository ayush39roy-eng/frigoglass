import { describe, expect, it } from 'vitest';

import { INITIAL_TEST_DIMENSIONS, testRubric } from '../test-fixtures';
import {
  addDimension,
  diffSnapshots,
  draftActiveTotal,
  draftFromRubric,
  draftPillars,
  isDraftDirty,
  mapRubricError,
  moveBefore,
  movePillar,
  moveWithinPillar,
  moveDimension,
  moveToPillarEnd,
  draftPillarWeights,
  orderedDraft,
  parseWeight,
  rebaseDraft,
  toDimensionInputs,
  updateDimension,
  validateDraft,
} from './rubric-draft';

const rubric = testRubric();
const base = () => draftFromRubric(rubric).dimensions;
const keys = (dims: { key: string | null; uid: string }[]) => dims.map((d) => d.key ?? d.uid);

describe('rubric draft (P26, ADR 0037)', () => {
  it('starts from the served rubric in display order, grouped by pillar (first appearance)', () => {
    const d = base();
    expect(d).toHaveLength(13);
    expect(draftPillars(d)).toEqual([
      'Strategic Alignment',
      'Regulatory & Quality',
      'Financial Return',
      'Investment & Feasibility',
      'Market & Volume',
    ]);
    // Saved in grouped order: ROI and CAPEX sit together under Investment & Feasibility.
    expect(keys(orderedDraft(d)).slice(8, 10)).toEqual(['profitability', 'capex_investment']);
    expect(isDraftDirty(d, rubric)).toBe(true); // grouping moved CAPEX next to ROI
    expect(draftActiveTotal(d)).toBe(295);
  });

  it('moves a dimension up / down within its pillar only, and a pillar as a block', () => {
    let d = base();
    d = moveWithinPillar(d, 'new_customer', -1);
    expect(keys(orderedDraft(d)).slice(0, 3)).toEqual(['new_customer', 'strategic_project', 'new_options']);
    // At the top of its pillar: no-op.
    expect(keys(moveWithinPillar(d, 'new_customer', -1))).toEqual(keys(orderedDraft(d)));
    d = movePillar(d, 'Regulatory & Quality', -1);
    expect(draftPillars(d)[0]).toBe('Regulatory & Quality');
    expect(keys(orderedDraft(d)).slice(0, 2)).toEqual(['regulatory_compliance', 'quality_improvements']);
  });

  it('moveDimension crosses into the neighbouring pillar at an end (P26-T03); no-op at the very ends', () => {
    const d = base();
    // Strategic Alignment = strategic_project, new_customer, new_options; next is Regulatory & Quality.
    let m = moveDimension(d, 'new_options', 1);
    expect(m.find((x) => x.uid === 'new_options')?.pillar).toBe('Regulatory & Quality');
    expect(keys(orderedDraft(m)).slice(2, 4)).toEqual(['new_options', 'regulatory_compliance']);
    m = moveDimension(m, 'new_options', -1);
    expect(m.find((x) => x.uid === 'new_options')?.pillar).toBe('Strategic Alignment');
    expect(keys(orderedDraft(m)).slice(0, 3)).toEqual(['strategic_project', 'new_customer', 'new_options']);
    expect(keys(moveDimension(d, 'strategic_project', -1))).toEqual(keys(orderedDraft(d)));
  });

  it('a drop on the end of another pillar moves the dimension there', () => {
    const m = moveToPillarEnd(base(), 'new_options', 'Market & Volume');
    expect(keys(orderedDraft(m)).at(-1)).toBe('new_options');
    expect(m.find((x) => x.uid === 'new_options')?.pillar).toBe('Market & Volume');
  });

  it('draftPillarWeights sums active, valid weights per pillar', () => {
    const d = updateDimension(base(), 'new_options', { active: false });
    const w = draftPillarWeights(d);
    expect(w.get('Strategic Alignment')).toBe(50);
  });

  it('drag and drop: before a target of the same pillar; across pillars moves it into the target pillar (P26-T03)', () => {
    const d = base();
    expect(keys(moveBefore(d, 'new_options', 'strategic_project')).slice(0, 3)).toEqual([
      'new_options',
      'strategic_project',
      'new_customer',
    ]);
    const across = moveBefore(d, 'new_options', 'rm_savings');
    expect(across.find((x) => x.uid === 'new_options')?.pillar).toBe(d.find((x) => x.uid === 'rm_savings')?.pillar);
    const ks = keys(orderedDraft(across));
    expect(ks[ks.indexOf('rm_savings') - 1]).toBe('new_options');
  });

  it('a pillar change moves the dimension to the end of the new pillar; a new pillar goes last', () => {
    let d = updateDimension(base(), 'strategic_project', { pillar: 'Market & Volume' });
    expect(keys(orderedDraft(d)).at(-1)).toBe('strategic_project');
    d = updateDimension(d, 'new_customer', { pillar: 'Customer' });
    expect(draftPillars(d).at(-1)).toBe('Customer');
  });

  it('adds a new dimension (no key) at the end of its pillar and sends it without a key', () => {
    const d = addDimension(base(), { uid: 'new-1', label: 'Sustainability & ESG', pillar: 'Sustainability', weight: '30' });
    const inputs = toDimensionInputs(d);
    expect(inputs).toHaveLength(14);
    expect(inputs.at(-1)).toEqual({ label: 'Sustainability & ESG', pillar: 'Sustainability', weight: 30, inverted: false, active: true });
    expect(inputs[0]).toEqual({ key: 'strategic_project', label: 'Strategic Project', pillar: 'Strategic Alignment', weight: 25, inverted: false, active: true });
    expect(draftActiveTotal(d)).toBe(325);
    // Deactivating takes the weight out of the proposed total.
    expect(draftActiveTotal(updateDimension(d, 'new_customer', { active: false }))).toBe(300);
  });

  it('validates like the server: label / pillar required, weight 1..100 integer, unique labels, one active', () => {
    let d = updateDimension(base(), 'strategic_project', { label: '   ' });
    d = updateDimension(d, 'new_customer', { weight: '0' });
    d = updateDimension(d, 'new_options', { label: 'rm savings' }); // collides with "RM Savings"
    d = updateDimension(d, 'rm_savings', { weight: '12.5' });
    const v = validateDraft(d);
    expect(v.valid).toBe(false);
    expect(v.fields.strategic_project?.label).toBe('A label is required');
    expect(v.fields.new_customer?.weight).toBe('Enter a whole number from 1 to 100');
    expect(v.fields.rm_savings?.weight).toBe('Enter a whole number from 1 to 100');
    expect(v.fields.new_options?.label).toMatch(/labels must be unique/);
    expect(v.fields.rm_savings?.label).toMatch(/labels must be unique/);
    const none = base().map((x) => ({ ...x, active: false }));
    expect(validateDraft(none).form).toEqual(['At least one dimension must be active.']);
    expect(parseWeight('100')).toBe(100);
    expect(parseWeight('101')).toBeNull();
    expect(parseWeight('1e2')).toBeNull();
  });

  it('maps the server 422s onto the draft (coded and field-level)', () => {
    const d = orderedDraft(base());
    expect(mapRubricError('RUBRIC_NO_ACTIVE_DIMENSION', 'x', d).form).toEqual(['At least one dimension must be active.']);
    const dup = orderedDraft(updateDimension(d, 'new_options', { label: 'New Customer' }));
    expect(Object.keys(mapRubricError('RUBRIC_DUPLICATE_LABEL', 'x', dup).fields).sort()).toEqual(['new_customer', 'new_options']);
    const detail = JSON.stringify([
      { loc: ['body', 'dimensions', 1, 'weight'], msg: 'Input should be less than or equal to 100', type: 'x' },
      { loc: ['body', 'reason'], msg: 'String should have at least 1 character', type: 'x' },
    ]);
    const mapped = mapRubricError(undefined, detail, d);
    expect(mapped.fields.new_customer?.weight).toBe('Enter a whole number from 1 to 100');
    expect(mapped.reason).toBe('String should have at least 1 character');
    expect(mapRubricError('RUBRIC_DIMENSION_MISSING', 'A dimension is never deleted', d).form).toEqual(['A dimension is never deleted']);
  });

  it('re-applies a draft on the latest version after a 409, keeping dimensions others added', () => {
    const mine = updateDimension(base(), 'strategic_project', { weight: '40' });
    const latest = testRubric({ version: 2 }, [
      ...INITIAL_TEST_DIMENSIONS,
      { key: 'safety', label: 'Safety', pillar: 'Regulatory & Quality', weight: 20 },
    ]);
    const rebased = rebaseDraft(mine, rubric, latest);
    expect(rebased.draft.baseVersion).toBe(2);
    expect(rebased.draft.base).toBe(latest);
    expect(rebased.conflicts).toEqual([]);
    const inputs = toDimensionInputs(rebased.draft.dimensions);
    expect(inputs.find((x) => x.key === 'strategic_project')?.weight).toBe(40);
    expect(inputs.find((x) => x.key === 'safety')).toMatchObject({ label: 'Safety', pillar: 'Regulatory & Quality' });
  });

  describe('409 rebase applies only the Admin\'s own changes (QA-F26-1)', () => {
    const weightOf = (dims: Parameters<typeof toDimensionInputs>[0], key: string) =>
      toDimensionInputs(dims).find((x) => x.key === key);
    const withDims = (version: number, patch: Record<string, Partial<(typeof INITIAL_TEST_DIMENSIONS)[number]>>, extra: (typeof INITIAL_TEST_DIMENSIONS)[number][] = [], inactive: string[] = []) =>
      testRubric(
        { version },
        [...INITIAL_TEST_DIMENSIONS.map((d) => ({ ...d, ...(patch[d.key] ?? {}) })), ...extra],
        inactive,
      );

    it('disjoint edits: tab A saved New Customer 30, tab B edited New Options 30 → both 30 (the live defect)', () => {
      const mine = updateDimension(base(), 'new_options', { weight: '30' });
      const latest = withDims(2, { new_customer: { weight: 30 } });
      const r = rebaseDraft(mine, rubric, latest);
      expect(r.conflicts).toEqual([]);
      expect(weightOf(r.draft.dimensions, 'new_customer')?.weight).toBe(30); // not reverted to 25
      expect(weightOf(r.draft.dimensions, 'new_options')?.weight).toBe(30);
      expect(r.applied).toEqual([{ id: 'new_options:weight', name: 'New Options', field: 'weight', from: '25', to: '30' }]);
      // Nothing else differs from the latest version.
      const untouched = toDimensionInputs(r.draft.dimensions).filter((x) => x.key !== 'new_options');
      const latestInputs = toDimensionInputs(draftFromRubric(latest).dimensions).filter((x) => x.key !== 'new_options');
      expect(untouched).toEqual(latestInputs);
    });

    it('an untouched draft re-applies to exactly the latest version', () => {
      const latest = withDims(2, { new_customer: { weight: 30, label: 'New Client' } }, [], ['new_models']);
      const r = rebaseDraft(base(), rubric, latest);
      expect(r.applied).toEqual([]);
      expect(r.conflicts).toEqual([]);
      expect(toDimensionInputs(r.draft.dimensions)).toEqual(toDimensionInputs(draftFromRubric(latest).dimensions));
    });

    it('the same change on both sides is not a conflict', () => {
      const mine = updateDimension(base(), 'new_customer', { weight: '30' });
      const r = rebaseDraft(mine, rubric, withDims(2, { new_customer: { weight: 30 } }));
      expect(r.conflicts).toEqual([]);
      expect(weightOf(r.draft.dimensions, 'new_customer')?.weight).toBe(30);
    });

    it('same-field conflict: "Your value 40 · Current 30", the server value by default, mine when chosen', () => {
      const mine = updateDimension(base(), 'new_customer', { weight: '40' });
      const latest = withDims(2, { new_customer: { weight: 30 } });
      const r = rebaseDraft(mine, rubric, latest);
      expect(r.conflicts).toEqual([
        {
          id: 'new_customer:weight',
          kind: 'both-changed',
          name: 'New Customer',
          field: 'weight',
          mine: '40',
          current: '30',
          note: 'Changed by someone else from 25',
        },
      ]);
      expect(r.applied).toEqual([]);
      expect(weightOf(r.draft.dimensions, 'new_customer')?.weight).toBe(30);
      const chosen = rebaseDraft(mine, rubric, latest, { 'new_customer:weight': 'mine' });
      expect(weightOf(chosen.draft.dimensions, 'new_customer')?.weight).toBe(40);
      expect(chosen.conflicts).toHaveLength(1); // still listed, so the choice can be changed back
    });

    it('a change to a dimension deactivated remotely is a conflict (default: server); other edits still apply', () => {
      let mine = updateDimension(base(), 'new_models', { weight: '20' });
      mine = updateDimension(mine, 'rm_savings', { weight: '35' });
      const latest = withDims(2, {}, [], ['new_models']);
      const r = rebaseDraft(mine, rubric, latest);
      expect(r.conflicts).toEqual([
        expect.objectContaining({ id: 'new_models:weight', kind: 'remote-deactivated', mine: '20', current: '15', note: 'Deactivated by someone else' }),
      ]);
      expect(weightOf(r.draft.dimensions, 'new_models')).toMatchObject({ weight: 15, active: false });
      expect(weightOf(r.draft.dimensions, 'rm_savings')?.weight).toBe(35);
      const chosen = rebaseDraft(mine, rubric, latest, { 'new_models:weight': 'mine' });
      // Taking my weight does not reactivate it: activity was not my change.
      expect(weightOf(chosen.draft.dimensions, 'new_models')).toMatchObject({ weight: 20, active: false });
    });

    it('my deactivation applies; a change to a dimension renamed remotely is a conflict', () => {
      let mine = updateDimension(base(), 'annual_volume', { active: false });
      mine = updateDimension(mine, 'new_customer', { weight: '35' });
      const latest = withDims(2, { new_customer: { label: 'New Client' } });
      const r = rebaseDraft(mine, rubric, latest);
      expect(weightOf(r.draft.dimensions, 'annual_volume')?.active).toBe(false);
      expect(r.applied).toContainEqual({ id: 'annual_volume:active', name: 'Annual Volume', field: 'active', from: 'active', to: 'inactive' });
      expect(r.conflicts).toEqual([
        expect.objectContaining({ id: 'new_customer:weight', kind: 'remote-renamed', name: 'New Client', note: 'Renamed by someone else (was “New Customer”)' }),
      ]);
      expect(weightOf(r.draft.dimensions, 'new_customer')).toMatchObject({ label: 'New Client', weight: 25 });
    });

    it('a label renamed on both sides is a conflict on the label', () => {
      const mine = updateDimension(base(), 'new_customer', { label: 'Customer Win' });
      const r = rebaseDraft(mine, rubric, withDims(2, { new_customer: { label: 'New Client' } }));
      expect(r.conflicts).toEqual([
        expect.objectContaining({ id: 'new_customer:label', kind: 'both-changed', mine: '“Customer Win”', current: '“New Client”' }),
      ]);
    });

    it('add vs remote add: both re-added when the labels differ; one dimension with field conflicts when they match', () => {
      const mine = addDimension(base(), { uid: 'new-1', label: 'Sustainability', pillar: 'ESG', weight: '20' });
      const theirs = { key: 'safety', label: 'Safety', pillar: 'Regulatory & Quality', weight: 20 };
      const r = rebaseDraft(mine, rubric, withDims(2, {}, [theirs]));
      expect(r.conflicts).toEqual([]);
      const inputs = toDimensionInputs(r.draft.dimensions);
      expect(inputs).toHaveLength(15);
      expect(inputs.find((x) => x.label === 'Sustainability')).toEqual({ label: 'Sustainability', pillar: 'ESG', weight: 20, inverted: false, active: true });
      expect(inputs.find((x) => x.key === 'safety')).toMatchObject({ pillar: 'Regulatory & Quality', weight: 20 });
      expect(r.applied).toContainEqual({ id: 'added:new-1', name: 'Sustainability', field: 'added', from: '', to: 'ESG, weight 20' });

      const twin = { key: 'sustainability', label: 'sustainability', pillar: 'ESG', weight: 10 };
      const r2 = rebaseDraft(mine, rubric, withDims(2, {}, [twin]));
      expect(r2.conflicts).toEqual([
        expect.objectContaining({ id: 'added:new-1:weight', kind: 'both-added', mine: '20', current: '10', note: 'Someone else also added “sustainability”' }),
      ]);
      const inputs2 = toDimensionInputs(r2.draft.dimensions);
      expect(inputs2).toHaveLength(14); // one dimension, not two (labels are unique)
      expect(inputs2.filter((x) => x.label.toLowerCase() === 'sustainability')).toEqual([
        { key: 'sustainability', label: 'sustainability', pillar: 'ESG', weight: 10, inverted: false, active: true },
      ]);
      const chosen = rebaseDraft(mine, rubric, withDims(2, {}, [twin]), { 'added:new-1:weight': 'mine' });
      expect(toDimensionInputs(chosen.draft.dimensions).find((x) => x.key === 'sustainability')?.weight).toBe(20);
      expect(validateDraft(chosen.draft.dimensions).valid).toBe(true);
    });

    it('order: mine applies when only I reordered; both reordered is a conflict (default: the latest order)', () => {
      const mineOrder = moveWithinPillar(base(), 'new_options', -1); // Strategic: SP, NO, NC
      const r = rebaseDraft(mineOrder, rubric, withDims(2, { rm_savings: { weight: 30 } }));
      expect(keys(r.draft.dimensions).slice(0, 3)).toEqual(['strategic_project', 'new_options', 'new_customer']);
      expect(r.applied).toContainEqual({ id: 'order', name: 'Dimension order', field: 'order', from: '', to: 'your order' });
      expect(weightOf(r.draft.dimensions, 'rm_savings')?.weight).toBe(30);

      // Someone else moved New Customer first.
      const theirOrder = [INITIAL_TEST_DIMENSIONS[1]!, INITIAL_TEST_DIMENSIONS[0]!, ...INITIAL_TEST_DIMENSIONS.slice(2)];
      const latest = testRubric({ version: 2 }, theirOrder);
      const both = rebaseDraft(mineOrder, rubric, latest);
      expect(both.conflicts.map((c) => c.id)).toEqual(['order']);
      expect(keys(both.draft.dimensions).slice(0, 3)).toEqual(['new_customer', 'strategic_project', 'new_options']);
      const chosen = rebaseDraft(mineOrder, rubric, latest, { order: 'mine' });
      expect(keys(chosen.draft.dimensions).slice(0, 3)).toEqual(['strategic_project', 'new_options', 'new_customer']);
    });

    it('a pillar change alone is not a reorder; it applies and moves the dimension to its new pillar', () => {
      const mine = updateDimension(base(), 'new_options', { pillar: 'Market & Volume' });
      const r = rebaseDraft(mine, rubric, withDims(2, { new_customer: { weight: 30 } }));
      expect(r.conflicts).toEqual([]);
      expect(r.applied.map((c) => c.id)).toEqual(['new_options:pillar']);
      expect(weightOf(r.draft.dimensions, 'new_options')?.pillar).toBe('Market & Volume');
      expect(weightOf(r.draft.dimensions, 'new_customer')?.weight).toBe(30);
      expect(draftPillars(r.draft.dimensions)).toEqual(draftPillars(mine));
    });
  });

  it('diffs two version snapshots: added, field changes and moves (not shifted neighbours)', () => {
    const v1 = testRubric();
    const v2 = testRubric({ version: 2 }, [
      { ...INITIAL_TEST_DIMENSIONS[1]!, weight: 30 },
      INITIAL_TEST_DIMENSIONS[0]!,
      ...INITIAL_TEST_DIMENSIONS.slice(2),
      { key: 'esg', label: 'ESG', pillar: 'Sustainability', weight: 10 },
    ]);
    const changes = diffSnapshots(v1, v2);
    const byKey = Object.fromEntries(changes.map((c) => [c.key, c]));
    expect(byKey.new_customer?.changes).toEqual([
      { field: 'weight', from: '25', to: '30' },
      { field: 'position', from: '2', to: '1' },
    ]);
    expect(byKey.esg?.kind).toBe('added');
    expect(byKey.new_options).toBeUndefined();
  });
});

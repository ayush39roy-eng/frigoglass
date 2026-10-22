/**
 * P26 (ADR 0037): the rubric editor's draft — pure functions, no React.
 *
 * A draft is the served rubric (every dimension, active and inactive) as the
 * Admin is editing it. It is shown grouped by pillar (first appearance, served
 * order within a pillar) and saved as a FULL replacement in that grouped order:
 * the list position becomes `display_order` (contract §3). Every existing
 * dimension is always sent (a dimension is never deleted; it is deactivated).
 *
 * Validation here mirrors the server's coded 422s so an Admin sees the problem
 * on the field before sending; the server stays the authority. The only
 * arithmetic is the draft's total of active weights, shown as the live
 * "proposed total" next to the served current total; after Preview the served
 * `proposed_total_weight` is shown instead.
 */

import type {
  RubricPreviewProject,
  ScoringRubric,
  ScoringRubricDimension,
  ScoringRubricDimensionInput,
  ScoringRubricPreview,
} from '../api/types';
import { groupByPillar, type PillarGroup } from './pillars';

/** contract §3 field limits (mirrors `models/scoring_rubric.py`). */
export const RUBRIC_LIMITS = {
  labelMax: 80,
  pillarMax: 60,
  reasonMax: 500,
  weightMin: 1,
  weightMax: 100,
  dimensionsMax: 100,
} as const;

export interface DraftDimension {
  /** Stable client id: the served key, or `new-<n>` for a dimension being added. */
  uid: string;
  /** The served key; null for a new dimension (the server slugifies it from the label). */
  key: string | null;
  label: string;
  pillar: string;
  /** Held as typed text so a half-typed value is not coerced; validated to an integer 1..100. */
  weight: string;
  inverted: boolean;
  active: boolean;
}

export interface RubricDraft {
  /** The served version this draft was edited from (sent as `version`). */
  baseVersion: number;
  /**
   * The served rubric this draft was edited from (QA-F26-1). After a 409 the
   * Admin's own changes are the difference between the draft and THIS snapshot,
   * not between the draft and the latest version.
   */
  base: ScoringRubric;
  dimensions: DraftDimension[];
}

export function draftFromRubric(rubric: ScoringRubric): RubricDraft {
  return {
    baseVersion: rubric.version,
    base: rubric,
    dimensions: [...rubric.dimensions]
      .sort((a, b) => a.display_order - b.display_order)
      .map(draftFromServed),
  };
}

function draftFromServed(d: ScoringRubricDimension): DraftDimension {
  return {
    uid: d.key,
    key: d.key,
    label: d.label,
    pillar: d.pillar,
    weight: String(d.weight),
    inverted: d.inverted,
    active: d.active,
  };
}

export function groupDraft(dims: readonly DraftDimension[]): PillarGroup<DraftDimension>[] {
  return groupByPillar(dims);
}

/** The draft flattened in grouped order: what is shown, and the order that is saved. */
export function orderedDraft(dims: readonly DraftDimension[]): DraftDimension[] {
  return groupDraft(dims).flatMap((g) => g.items);
}

/** Distinct pillar names in grouped order (the pillar picker's options). */
export function draftPillars(dims: readonly DraftDimension[]): string[] {
  return groupDraft(dims).map((g) => g.pillar);
}

/** Move a dimension one place up (-1) or down (+1) inside its pillar. No-op at either end. */
export function moveWithinPillar(dims: readonly DraftDimension[], uid: string, dir: -1 | 1): DraftDimension[] {
  const groups = groupDraft(dims).map((g) => ({ ...g, items: [...g.items] }));
  for (const g of groups) {
    const i = g.items.findIndex((d) => d.uid === uid);
    if (i === -1) continue;
    const j = i + dir;
    if (j < 0 || j >= g.items.length) return orderedDraft(dims);
    const a = g.items[i] as DraftDimension;
    g.items[i] = g.items[j] as DraftDimension;
    g.items[j] = a;
    break;
  }
  return groups.flatMap((g) => g.items);
}

/** Move a whole pillar group one place up (-1) or down (+1). */
export function movePillar(dims: readonly DraftDimension[], pillar: string, dir: -1 | 1): DraftDimension[] {
  const groups = groupDraft(dims);
  const i = groups.findIndex((g) => g.pillar === pillar);
  const j = i + dir;
  if (i === -1 || j < 0 || j >= groups.length) return orderedDraft(dims);
  const out = [...groups];
  const a = out[i] as PillarGroup<DraftDimension>;
  out[i] = out[j] as PillarGroup<DraftDimension>;
  out[j] = a;
  return out.flatMap((g) => g.items);
}

/**
 * P26-T03: move a dimension one place up (-1) or down (+1) in the grouped list.
 * Inside its pillar it swaps with its neighbour; at the top (bottom) of its
 * pillar it crosses into the previous (next) pillar, taking that pillar's name
 * and becoming its last (first) dimension. No-op only at the very ends.
 */
export function moveDimension(dims: readonly DraftDimension[], uid: string, dir: -1 | 1): DraftDimension[] {
  const groups = groupDraft(dims).map((g) => ({ ...g, items: [...g.items] }));
  const gi = groups.findIndex((g) => g.items.some((d) => d.uid === uid));
  if (gi === -1) return orderedDraft(dims);
  const group = groups[gi] as PillarGroup<DraftDimension>;
  const i = group.items.findIndex((d) => d.uid === uid);
  const j = i + dir;
  if (j >= 0 && j < group.items.length) return moveWithinPillar(dims, uid, dir);
  const other = groups[gi + dir];
  if (!other) return orderedDraft(dims);
  const [moving] = group.items.splice(i, 1);
  const moved = { ...(moving as DraftDimension), pillar: other.pillar };
  if (dir === -1) other.items.push(moved);
  else other.items.unshift(moved);
  return groups.flatMap((g) => g.items);
}

/**
 * Drag and drop: put `uid` just before `targetUid`. P26-T03: a drop on another
 * pillar's dimension moves it into that pillar (it takes the target's pillar).
 */
export function moveBefore(dims: readonly DraftDimension[], uid: string, targetUid: string): DraftDimension[] {
  const ordered = orderedDraft(dims);
  const moving = ordered.find((d) => d.uid === uid);
  const target = ordered.find((d) => d.uid === targetUid);
  if (!moving || !target || uid === targetUid) return ordered;
  const rest = ordered.filter((d) => d.uid !== uid);
  const at = rest.findIndex((d) => d.uid === targetUid);
  rest.splice(at, 0, moving.pillar === target.pillar ? moving : { ...moving, pillar: target.pillar });
  return orderedDraft(rest);
}

/**
 * Drag and drop onto a pillar's list (not on a row): `uid` becomes the last of
 * `pillar` (its own pillar by default; P26-T03: another pillar moves it there).
 */
export function moveToPillarEnd(dims: readonly DraftDimension[], uid: string, pillar?: string): DraftDimension[] {
  const ordered = orderedDraft(dims);
  const found = ordered.find((d) => d.uid === uid);
  if (!found) return ordered;
  const moving = pillar === undefined || pillar === found.pillar ? found : { ...found, pillar };
  const rest = ordered.filter((d) => d.uid !== uid);
  let last = -1;
  rest.forEach((d, i) => {
    if (d.pillar === moving.pillar) last = i;
  });
  rest.splice(last + 1, 0, moving);
  return rest;
}

/** The sum of the draft's ACTIVE weights per pillar (display only; invalid weights count 0). */
export function draftPillarWeights(dims: readonly DraftDimension[]): Map<string, number> {
  const out = new Map<string, number>();
  for (const d of dims) {
    if (!d.active) continue;
    out.set(d.pillar, (out.get(d.pillar) ?? 0) + (parseWeight(d.weight) ?? 0));
  }
  return out;
}

/**
 * Update one dimension. A pillar change moves it to the END of its new pillar
 * (or, for a brand-new pillar, to the end of the list), so the grouped view
 * never reorders other pillars as a side effect.
 */
export function updateDimension(
  dims: readonly DraftDimension[],
  uid: string,
  patch: Partial<Omit<DraftDimension, 'uid' | 'key'>>,
): DraftDimension[] {
  const ordered = orderedDraft(dims);
  const current = ordered.find((d) => d.uid === uid);
  if (!current) return ordered;
  const next = { ...current, ...patch };
  if (patch.pillar === undefined || patch.pillar === current.pillar) {
    return ordered.map((d) => (d.uid === uid ? next : d));
  }
  const rest = ordered.filter((d) => d.uid !== uid);
  return insertIntoPillar(rest, next);
}

function insertIntoPillar(dims: DraftDimension[], item: DraftDimension): DraftDimension[] {
  let last = -1;
  dims.forEach((d, i) => {
    if (d.pillar === item.pillar) last = i;
  });
  const out = [...dims];
  if (last === -1) out.push(item);
  else out.splice(last + 1, 0, item);
  return out;
}

/** Add a new dimension (active, not inverted) at the end of its pillar. */
export function addDimension(
  dims: readonly DraftDimension[],
  input: { uid: string; label: string; pillar: string; weight: string },
): DraftDimension[] {
  const item: DraftDimension = {
    uid: input.uid,
    key: null,
    label: input.label,
    pillar: input.pillar,
    weight: input.weight,
    inverted: false,
    active: true,
  };
  return insertIntoPillar(orderedDraft(dims), item);
}

/** Remove a dimension that has not been saved yet (an existing one is only ever deactivated). */
export function removeNewDimension(dims: readonly DraftDimension[], uid: string): DraftDimension[] {
  return orderedDraft(dims).filter((d) => !(d.uid === uid && d.key === null));
}

// --- validation -------------------------------------------------------------------

export type RubricFieldError = Partial<Record<'label' | 'pillar' | 'weight', string>>;

export interface RubricValidation {
  /** Per dimension (by uid). */
  fields: Record<string, RubricFieldError>;
  /** Draft-level problems (e.g. no active dimension). */
  form: string[];
  valid: boolean;
}

/** A weight text as an integer 1..100, else null. Strict: "25" is fine, "25.5", "", "1e2" are not. */
export function parseWeight(text: string): number | null {
  const t = text.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return n >= RUBRIC_LIMITS.weightMin && n <= RUBRIC_LIMITS.weightMax ? n : null;
}

export const WEIGHT_ERROR = `Enter a whole number from ${String(RUBRIC_LIMITS.weightMin)} to ${String(RUBRIC_LIMITS.weightMax)}`;
export const NO_ACTIVE_ERROR = 'At least one dimension must be active.';

/** Mirrors the server: label 1..80 and pillar 1..60 after trimming, weight 1..100,
 *  labels unique ignoring case (`RUBRIC_DUPLICATE_LABEL`), one active dimension
 *  at least (`RUBRIC_NO_ACTIVE_DIMENSION`). */
export function validateDraft(dims: readonly DraftDimension[]): RubricValidation {
  const fields: Record<string, RubricFieldError> = {};
  const form: string[] = [];
  const set = (uid: string, field: keyof RubricFieldError, msg: string) => {
    fields[uid] = { ...(fields[uid] ?? {}), [field]: msg };
  };
  const byLabel = new Map<string, string[]>();
  for (const d of dims) {
    const label = d.label.trim();
    if (label === '') set(d.uid, 'label', 'A label is required');
    else if (label.length > RUBRIC_LIMITS.labelMax) set(d.uid, 'label', `At most ${String(RUBRIC_LIMITS.labelMax)} characters`);
    else {
      const k = label.toLowerCase();
      byLabel.set(k, [...(byLabel.get(k) ?? []), d.uid]);
    }
    const pillar = d.pillar.trim();
    if (pillar === '') set(d.uid, 'pillar', 'A pillar is required');
    else if (pillar.length > RUBRIC_LIMITS.pillarMax) set(d.uid, 'pillar', `At most ${String(RUBRIC_LIMITS.pillarMax)} characters`);
    if (parseWeight(d.weight) === null) set(d.uid, 'weight', WEIGHT_ERROR);
  }
  for (const uids of byLabel.values()) {
    if (uids.length > 1) for (const uid of uids) set(uid, 'label', 'Another dimension has this label (labels must be unique)');
  }
  if (!dims.some((d) => d.active)) form.push(NO_ACTIVE_ERROR);
  if (dims.length > RUBRIC_LIMITS.dimensionsMax) form.push(`At most ${String(RUBRIC_LIMITS.dimensionsMax)} dimensions`);
  return { fields, form, valid: form.length === 0 && Object.keys(fields).length === 0 };
}

/** The uids whose labels collide (case-insensitive), for mapping a server `RUBRIC_DUPLICATE_LABEL`. */
export function duplicateLabelUids(dims: readonly DraftDimension[]): string[] {
  const seen = new Map<string, string[]>();
  for (const d of dims) {
    const k = d.label.trim().toLowerCase();
    if (k !== '') seen.set(k, [...(seen.get(k) ?? []), d.uid]);
  }
  return [...seen.values()].filter((u) => u.length > 1).flat();
}

/** The request `dimensions`: every dimension, grouped order, trimmed; `key` omitted for a new one. */
export function toDimensionInputs(dims: readonly DraftDimension[]): ScoringRubricDimensionInput[] {
  return orderedDraft(dims).map((d) => {
    const base = {
      label: d.label.trim(),
      pillar: d.pillar.trim(),
      weight: parseWeight(d.weight) ?? Number(d.weight),
      inverted: d.inverted,
      active: d.active,
    };
    return d.key === null ? base : { key: d.key, ...base };
  });
}

/** The live proposed total: Σ weights of the draft's ACTIVE dimensions with a valid weight. */
export function draftActiveTotal(dims: readonly DraftDimension[]): number {
  return dims.reduce((sum, d) => (d.active ? sum + (parseWeight(d.weight) ?? 0) : sum), 0);
}

/**
 * The draft differs from the served rubric as stored (any field, an added
 * dimension, or the order — including when the served order is not grouped by
 * pillar, because a save stores the grouped order shown).
 */
export function isDraftDirty(dims: readonly DraftDimension[], rubric: ScoringRubric | undefined): boolean {
  if (!rubric) return false;
  const served = [...rubric.dimensions].sort((a, b) => a.display_order - b.display_order).map(draftFromServed);
  const a = toDimensionInputs(dims);
  const b = served.map((d) => ({ key: d.key, label: d.label, pillar: d.pillar, weight: Number(d.weight), inverted: d.inverted, active: d.active }));
  return JSON.stringify(a) !== JSON.stringify(b);
}

/** True when the served display order already keeps each pillar together. */
export function servedOrderIsGrouped(rubric: ScoringRubric): boolean {
  const ordered = [...rubric.dimensions].sort((a, b) => a.display_order - b.display_order);
  return ordered.every((d, i) => i === 0 || d.pillar === ordered[i - 1]?.pillar || !ordered.slice(0, i).some((x) => x.pillar === d.pillar));
}

/** Per-dimension "changed" flags against the served rubric (for row markers). */
export function changedFields(d: DraftDimension, rubric: ScoringRubric | undefined): string[] {
  if (d.key === null) return ['new'];
  const served = rubric?.dimensions.find((s) => s.key === d.key);
  if (!served) return [];
  const out: string[] = [];
  if (d.label.trim() !== served.label) out.push('label');
  if (d.pillar.trim() !== served.pillar) out.push('pillar');
  if (parseWeight(d.weight) !== served.weight) out.push('weight');
  if (d.inverted !== served.inverted) out.push('inverted');
  if (d.active !== served.active) out.push('active');
  return out;
}

// --- 409 rebase (QA-F26-1) ---------------------------------------------------------

export const REBASE_FIELDS = ['label', 'pillar', 'weight', 'inverted', 'active'] as const;
export type RebaseField = (typeof REBASE_FIELDS)[number];

/**
 * Why a change of the Admin's cannot be re-applied silently:
 * - `both-changed`: the same field was changed on both sides, to different values;
 * - `remote-deactivated` / `remote-renamed`: they changed a dimension that someone
 *   else deactivated or renamed meanwhile;
 * - `both-added`: they added a dimension whose label someone else added too
 *   (labels are unique, so it is one dimension; the differing fields conflict);
 * - `order`: both sides reordered the dimensions.
 */
export type RebaseConflictKind = 'both-changed' | 'remote-deactivated' | 'remote-renamed' | 'both-added' | 'order';

export interface RebaseConflict {
  /** Stable id: `<key>:<field>`, `added:<uid>:<field>` or `order`. */
  id: string;
  kind: RebaseConflictKind;
  /** The dimension's label in the latest version (or the added label). */
  name: string;
  field: RebaseField | 'order';
  /** Display values. */
  mine: string;
  current: string;
  note: string | null;
}

/** Per conflict: keep the latest server value (the default) or take the Admin's. */
export type RebaseChoice = 'mine' | 'current';

export interface RebaseChange {
  id: string;
  name: string;
  field: RebaseField | 'order' | 'added';
  from: string;
  to: string;
}

export interface RebaseResult {
  /** The latest version with the Admin's changes applied (conflicts resolved by `choices`). */
  draft: RubricDraft;
  /** The Admin's changes that apply without conflict. */
  applied: RebaseChange[];
  conflicts: RebaseConflict[];
}

function draftValue(d: DraftDimension, f: RebaseField): string {
  if (f === 'label') return d.label.trim();
  if (f === 'pillar') return d.pillar.trim();
  if (f === 'weight') {
    const n = parseWeight(d.weight);
    return n === null ? d.weight.trim() : String(n);
  }
  return String(f === 'inverted' ? d.inverted : d.active);
}

function servedValue(d: ScoringRubricDimension, f: RebaseField): string {
  if (f === 'label') return d.label;
  if (f === 'pillar') return d.pillar;
  if (f === 'weight') return String(d.weight);
  return String(f === 'inverted' ? d.inverted : d.active);
}

function withField(d: DraftDimension, f: RebaseField, v: string): DraftDimension {
  if (f === 'inverted') return { ...d, inverted: v === 'true' };
  if (f === 'active') return { ...d, active: v === 'true' };
  return { ...d, [f]: v };
}

/** How a field value reads in the rebase panel ("40", "inactive", "“Safety”"). */
export function rebaseDisplay(f: RebaseField, v: string): string {
  if (f === 'active') return v === 'true' ? 'active' : 'inactive';
  if (f === 'inverted') return v === 'true' ? 'inverted' : 'not inverted';
  if (f === 'label') return `“${v}”`;
  return v;
}

const sameText = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** The keys of `dims` (restricted to `keep`) in grouped order. */
function keyOrder(dims: readonly DraftDimension[], keep: ReadonlySet<string>): string {
  return orderedDraft(dims)
    .flatMap((d) => (d.key !== null && keep.has(d.key) ? [d.key] : []))
    .join('|');
}

/** `dims` with the pillars of `pillars` applied the way the editor applies them
 *  (a pillar change moves the dimension to the end of its new pillar), so a
 *  pillar change alone is not counted as a reorder. */
function withPillars(dims: readonly DraftDimension[], pillars: ReadonlyMap<string, string>): DraftDimension[] {
  let out = orderedDraft(dims);
  for (const d of orderedDraft(dims)) {
    const p = d.key === null ? undefined : pillars.get(d.key);
    if (p !== undefined && p.trim() !== d.pillar.trim()) out = updateDimension(out, d.uid, { pillar: p });
  }
  return out;
}

/**
 * After a 409 reload (QA-F26-1): re-apply ONLY the Admin's own changes — the
 * difference between their draft (`mine`) and the version it was edited from
 * (`base`) — on top of the latest version. Everything they did not touch keeps
 * the latest value, so another Admin's concurrent change is never reverted.
 *
 * - A field changed only by the Admin is applied.
 * - A field changed on both sides to different values, or any change to a
 *   dimension someone else deactivated or renamed meanwhile, is a conflict:
 *   the latest server value is kept unless `choices[id] === 'mine'`.
 * - Dimensions the Admin added are re-added (a label someone else also added
 *   becomes that one dimension; its differing fields are conflicts).
 * - Dimensions someone else added are kept (the server rejects a list that
 *   misses one).
 * - Order: the Admin's order is used when only they reordered; when both did,
 *   it is a conflict (default: the latest order).
 */
export function rebaseDraft(
  mine: readonly DraftDimension[],
  base: ScoringRubric,
  latest: ScoringRubric,
  choices: Readonly<Record<string, RebaseChoice>> = {},
): RebaseResult {
  const baseByKey = new Map(base.dimensions.map((d) => [d.key, d]));
  const latestByKey = new Map(latest.dimensions.map((d) => [d.key, d]));
  const latestDims = orderedDraft(draftFromRubric(latest).dimensions);
  const merged = new Map<string, DraftDimension>(latestDims.map((d) => [d.uid, d]));
  const applied: RebaseChange[] = [];
  const conflicts: RebaseConflict[] = [];
  const takeMine = (id: string) => choices[id] === 'mine';

  // 1. The Admin's field edits on dimensions that existed in the base version.
  for (const d of orderedDraft(mine)) {
    if (d.key === null) continue;
    const b = baseByKey.get(d.key);
    const l = latestByKey.get(d.key);
    const at = merged.get(d.key);
    if (!b || !l || !at) continue;
    const remoteDeactivated = b.active && !l.active;
    const remoteRenamed = b.label !== l.label;
    let next = at;
    for (const f of REBASE_FIELDS) {
      const mv = draftValue(d, f);
      const bv = servedValue(b, f);
      const lv = servedValue(l, f);
      if (mv === bv || mv === lv) continue; // not changed by the Admin, or the same change on both sides
      const id = `${d.key}:${f}`;
      let kind: RebaseConflictKind | null = null;
      let note: string | null = null;
      if (lv !== bv) {
        kind = 'both-changed';
        note = `Changed by someone else from ${rebaseDisplay(f, bv)}`;
      } else if (remoteDeactivated && f !== 'active') {
        kind = 'remote-deactivated';
        note = 'Deactivated by someone else';
      } else if (remoteRenamed && f !== 'label') {
        kind = 'remote-renamed';
        note = `Renamed by someone else (was “${b.label}”)`;
      }
      if (kind === null) {
        next = withField(next, f, mv);
        applied.push({ id, name: l.label, field: f, from: rebaseDisplay(f, lv), to: rebaseDisplay(f, mv) });
        continue;
      }
      conflicts.push({ id, kind, name: l.label, field: f, mine: rebaseDisplay(f, mv), current: rebaseDisplay(f, lv), note });
      if (takeMine(id)) next = withField(next, f, mv);
    }
    merged.set(d.key, next);
  }

  // 2. Dimensions the Admin added: re-added, unless someone else added the same label.
  const remoteAdded = latest.dimensions.filter((l) => !baseByKey.has(l.key));
  for (const n of orderedDraft(mine)) {
    if (n.key !== null) continue;
    const twin = remoteAdded.find((l) => sameText(l.label, n.label));
    if (!twin) {
      merged.set(n.uid, n);
      applied.push({
        id: `added:${n.uid}`,
        name: n.label.trim(),
        field: 'added',
        from: '',
        to: `${n.pillar.trim()}, weight ${draftValue(n, 'weight')}`,
      });
      continue;
    }
    let next = merged.get(twin.key) as DraftDimension;
    for (const f of REBASE_FIELDS) {
      if (f === 'label') continue;
      const mv = draftValue(n, f);
      const lv = servedValue(twin, f);
      if (mv === lv) continue;
      const id = `added:${n.uid}:${f}`;
      conflicts.push({
        id,
        kind: 'both-added',
        name: twin.label,
        field: f,
        mine: rebaseDisplay(f, mv),
        current: rebaseDisplay(f, lv),
        note: `Someone else also added “${twin.label}”`,
      });
      if (takeMine(id)) next = withField(next, f, mv);
    }
    merged.set(twin.key, next);
  }

  // 3. Order.
  const baseDims = orderedDraft(draftFromRubric(base).dimensions);
  const keep = new Set(base.dimensions.map((d) => d.key).filter((k) => latestByKey.has(k)));
  const minePillars = new Map(mine.flatMap((d) => (d.key === null ? [] : [[d.key, d.pillar] as const])));
  const latestPillars = new Map(latest.dimensions.map((d) => [d.key, d.pillar] as const));
  const mineReordered = keyOrder(mine, keep) !== keyOrder(withPillars(baseDims, minePillars), keep);
  const remoteReordered = keyOrder(latestDims, keep) !== keyOrder(withPillars(baseDims, latestPillars), keep);
  let useMineOrder = mineReordered;
  if (mineReordered && remoteReordered) {
    conflicts.push({
      id: 'order',
      kind: 'order',
      name: 'Dimension order',
      field: 'order',
      mine: 'your order',
      current: `the order of version ${String(latest.version)}`,
      note: 'Reordered by someone else',
    });
    useMineOrder = takeMine('order');
  } else if (mineReordered) {
    applied.push({ id: 'order', name: 'Dimension order', field: 'order', from: '', to: 'your order' });
  }

  const skeleton = (useMineOrder ? orderedDraft(mine) : latestDims).filter((d) => merged.has(d.uid));
  let list = skeleton.map((s) => ({ ...(merged.get(s.uid) as DraftDimension), pillar: s.pillar }));
  const placed = new Set(list.map((d) => d.uid));
  for (const [uid, d] of merged) if (!placed.has(uid)) list = insertIntoPillar(list, d);
  for (const d of [...list]) {
    const want = (merged.get(d.uid) as DraftDimension).pillar;
    if (want.trim() !== d.pillar.trim()) list = updateDimension(list, d.uid, { pillar: want });
  }

  return {
    draft: { baseVersion: latest.version, base: latest, dimensions: orderedDraft(list) },
    applied,
    conflicts,
  };
}

// --- server 422 mapping -------------------------------------------------------------

export interface MappedRubricError {
  fields: Record<string, RubricFieldError>;
  form: string[];
  reason: string | null;
}

/**
 * Map a 422 from `PUT /scoring-rubric` / `POST /scoring-rubric/preview` onto the
 * draft. Coded errors (contract §3) go to the fields they concern; FastAPI's
 * own field errors (no code; `detail` is the JSON list) are mapped by `loc`
 * (`["body", "dimensions", i, field]`, `i` in the order sent) or to the reason.
 */
export function mapRubricError(
  code: string | undefined,
  detail: string | undefined,
  sentOrder: readonly DraftDimension[],
): MappedRubricError {
  const out: MappedRubricError = { fields: {}, form: [], reason: null };
  if (code === 'RUBRIC_NO_ACTIVE_DIMENSION') {
    out.form.push(NO_ACTIVE_ERROR);
    return out;
  }
  if (code === 'RUBRIC_DUPLICATE_LABEL') {
    const uids = duplicateLabelUids(sentOrder);
    for (const uid of uids) out.fields[uid] = { label: 'Another dimension has this label (labels must be unique)' };
    if (uids.length === 0) out.form.push(detail ?? 'Dimension labels must be unique.');
    return out;
  }
  if (code) {
    out.form.push(detail ?? 'The server rejected this rubric.');
    return out;
  }
  let items: unknown;
  try {
    items = detail ? (JSON.parse(detail) as unknown) : null;
  } catch {
    items = null;
  }
  if (!Array.isArray(items)) {
    out.form.push(detail ?? 'The server rejected this rubric.');
    return out;
  }
  for (const item of items as { loc?: unknown[]; msg?: string }[]) {
    const loc = Array.isArray(item.loc) ? item.loc : [];
    const msg = item.msg ?? 'Invalid value';
    if (loc[1] === 'reason') {
      out.reason = msg;
      continue;
    }
    if (loc[1] === 'dimensions' && typeof loc[2] === 'number') {
      const d = sentOrder[loc[2]];
      const field = loc[3];
      if (d && (field === 'label' || field === 'pillar' || field === 'weight')) {
        out.fields[d.uid] = { ...(out.fields[d.uid] ?? {}), [field]: field === 'weight' ? WEIGHT_ERROR : msg };
        continue;
      }
    }
    out.form.push(msg);
  }
  return out;
}

// --- version history ----------------------------------------------------------------

export interface DimensionChange {
  key: string;
  label: string;
  kind: 'added' | 'changed';
  changes: { field: string; from: string; to: string }[];
}

/**
 * What changed from `prev` to `next` (two served snapshots): dimensions added,
 * and per dimension the label, pillar, weight, inverted, active and position
 * changes. Display only; every value is a served snapshot field.
 */
export function diffSnapshots(prev: ScoringRubric | undefined, next: ScoringRubric): DimensionChange[] {
  const before = new Map((prev?.dimensions ?? []).map((d) => [d.key, d]));
  const out: DimensionChange[] = [];
  const ordered = [...next.dimensions].sort((a, b) => a.display_order - b.display_order);
  // Position among the dimensions both versions have, so an insertion does not
  // mark every later dimension as moved.
  const common = (list: readonly ScoringRubricDimension[]) =>
    [...list].sort((a, b) => a.display_order - b.display_order).map((d) => d.key);
  const nextKeys = new Set(ordered.map((d) => d.key));
  const prevRank = new Map(common(prev?.dimensions ?? []).filter((k) => nextKeys.has(k)).map((k, i) => [k, i + 1]));
  const nextRank = new Map(ordered.map((d) => d.key).filter((k) => before.has(k)).map((k, i) => [k, i + 1]));
  for (const d of ordered) {
    const p = before.get(d.key);
    if (!p) {
      out.push({
        key: d.key,
        label: d.label,
        kind: 'added',
        changes: [
          { field: 'pillar', from: '—', to: d.pillar },
          { field: 'weight', from: '—', to: String(d.weight) },
          ...(d.active ? [] : [{ field: 'active', from: '—', to: 'no' }]),
        ],
      });
      continue;
    }
    const changes: DimensionChange['changes'] = [];
    if (p.label !== d.label) changes.push({ field: 'label', from: p.label, to: d.label });
    if (p.pillar !== d.pillar) changes.push({ field: 'pillar', from: p.pillar, to: d.pillar });
    if (p.weight !== d.weight) changes.push({ field: 'weight', from: String(p.weight), to: String(d.weight) });
    if (p.inverted !== d.inverted) changes.push({ field: 'inverted', from: p.inverted ? 'yes' : 'no', to: d.inverted ? 'yes' : 'no' });
    if (p.active !== d.active) changes.push({ field: 'active', from: p.active ? 'yes' : 'no', to: d.active ? 'yes' : 'no' });
    const from = prevRank.get(d.key);
    const to = nextRank.get(d.key);
    if (from !== undefined && to !== undefined && from !== to)
      changes.push({ field: 'position', from: String(p.display_order), to: String(d.display_order) });
    if (changes.length > 0) out.push({ key: d.key, label: d.label, kind: 'changed', changes });
  }
  return out;
}

/** A project is listed when its served score or either served band changes. */
export function changedPreviewProjects(preview: ScoringRubricPreview): RubricPreviewProject[] {
  return preview.projects.filter(
    (p) => p.old_normalized_pct !== p.new_normalized_pct || p.score_band_changed || p.suggested_band_changed,
  );
}


import { create } from 'zustand';

import type { EditMap, ImportOptions } from './import-rows';
import type { ImportRow, ImportSimulateResponse } from './import-types';

/**
 * The Compare tab's scenario list (P32-R05, docs/API_CONTRACT_P32.md C2; P41 ADR 0055 D4).
 * No `persist`: a page refresh clears it. Each entry is a snapshot of the request (rows +
 * options + edits + plan exclusions) and the response exactly as served, so the Compare tab
 * only reads served figures.
 *
 * - `variant` / `saved`: made in this session, kept in the browser only.
 * - `stored`: a server-saved scenario (P41) loaded for comparison; its frozen response comes
 *   from `GET /whatif/import/scenarios/{id}`. It does not count against MAX_SCENARIOS, and
 *   removing it here never deletes it on the server.
 */

export const MAX_SCENARIOS = 10;
export const MAX_COMPARE = 4;
export const MAX_SCENARIO_NAME = 60;

export interface ImportScenario {
  id: string;
  name: string;
  /** `saved` from the current result; `variant` from the scenario builder; `stored` (P41) a server record. */
  origin: 'saved' | 'variant' | 'stored';
  /** A one-line description of the builder rules (variants only). */
  rules: string | null;
  fileName: string | null;
  createdAt: number;
  rows: ImportRow[];
  options: ImportOptions;
  edits: EditMap;
  /** P41: plan projects unticked in the picker when the scenario was computed. */
  excludedPlanIds?: string[] | undefined;
  response: ImportSimulateResponse;
  /** P41: the server record behind a `stored` entry (as served). */
  stored?: StoredMeta | undefined;
}

export interface StoredMeta {
  id: string;
  sourceSha256: string;
  simulatedWeek: number;
  planVersion: number | null;
  /** P50 (API_CONTRACT_P41 §F): the stored "Plan from" / "Plan until" weeks. */
  planFromWeek?: number | undefined;
  planUntilWeek?: number | undefined;
  createdByName: string | null;
  createdAt: string;
  canEdit: boolean;
}

export type NewScenario = Omit<ImportScenario, 'id' | 'createdAt'>;

export interface ScenariosState {
  scenarios: ImportScenario[];
  /** Up to four ids to compare; the first is the baseline. */
  compareIds: string[];
  /** The two scenarios whose outcome changes are listed (ids). */
  diffPair: [string | null, string | null];

  /** Saves a snapshot and adds it to the comparison when there is room; null when full. */
  save: (s: NewScenario) => string | null;
  rename: (id: string, name: string) => void;
  remove: (id: string) => void;
  toggleCompare: (id: string) => void;
  makeBaseline: (id: string) => void;
  setDiffPair: (pair: [string | null, string | null]) => void;
  clear: () => void;
  /**
   * P41: adds a server-saved scenario to the list and ticks it for comparison when there is
   * room (an entry for the same record is refreshed and ticked instead). Returns the list id.
   */
  addStored: (s: NewScenario & { stored: StoredMeta }) => string;
  /** P41: a stored record was renamed or deleted on the server. */
  syncStored: (storedId: string, patch: { name: string } | null) => void;
}

/** Session scenarios (the ones limited by MAX_SCENARIOS). */
export function sessionCount(scenarios: readonly ImportScenario[]): number {
  return scenarios.filter((s) => s.origin !== 'stored').length;
}

let seq = 0;
function newId(): string {
  seq += 1;
  return `scn-${String(Date.now())}-${String(seq)}`;
}

export function cleanName(name: string): string {
  return name.trim().slice(0, MAX_SCENARIO_NAME);
}

/** "Scenario 3" — the first unused default name. */
export function defaultScenarioName(existing: readonly ImportScenario[], prefix = 'Scenario'): string {
  const names = new Set(existing.map((s) => s.name));
  let n = existing.length + 1;
  while (names.has(`${prefix} ${String(n)}`)) n += 1;
  return `${prefix} ${String(n)}`;
}

function pairAfter(compareIds: string[], pair: [string | null, string | null]): [string | null, string | null] {
  const ok = (id: string | null) => id !== null && compareIds.includes(id);
  const a = ok(pair[0]) ? pair[0] : (compareIds[0] ?? null);
  const b = ok(pair[1]) && pair[1] !== a ? pair[1] : (compareIds.find((id) => id !== a) ?? null);
  return [a, b];
}

export const useImportScenarios = create<ScenariosState>()((set, get) => ({
  scenarios: [],
  compareIds: [],
  diffPair: [null, null],
  save: (input) => {
    if (sessionCount(get().scenarios) >= MAX_SCENARIOS) return null;
    const id = newId();
    set((s) => {
      const compareIds = s.compareIds.length < MAX_COMPARE ? [...s.compareIds, id] : s.compareIds;
      return {
        scenarios: [
          ...s.scenarios,
          { ...input, name: cleanName(input.name) || defaultScenarioName(s.scenarios), id, createdAt: Date.now() },
        ],
        compareIds,
        diffPair: pairAfter(compareIds, s.diffPair),
      };
    });
    return id;
  },
  rename: (id, name) => {
    const clean = cleanName(name);
    if (clean === '') return;
    set((s) => ({ scenarios: s.scenarios.map((x) => (x.id === id ? { ...x, name: clean } : x)) }));
  },
  remove: (id) =>
    set((s) => {
      const compareIds = s.compareIds.filter((x) => x !== id);
      return {
        scenarios: s.scenarios.filter((x) => x.id !== id),
        compareIds,
        diffPair: pairAfter(compareIds, s.diffPair),
      };
    }),
  toggleCompare: (id) =>
    set((s) => {
      let compareIds: string[];
      if (s.compareIds.includes(id)) compareIds = s.compareIds.filter((x) => x !== id);
      else if (s.compareIds.length < MAX_COMPARE) compareIds = [...s.compareIds, id];
      else return {};
      return { compareIds, diffPair: pairAfter(compareIds, s.diffPair) };
    }),
  makeBaseline: (id) =>
    set((s) => {
      if (!s.compareIds.includes(id)) return {};
      const compareIds = [id, ...s.compareIds.filter((x) => x !== id)];
      return { compareIds, diffPair: pairAfter(compareIds, s.diffPair) };
    }),
  setDiffPair: (pair) => set((s) => ({ diffPair: pairAfter(s.compareIds, pair) })),
  clear: () => set({ scenarios: [], compareIds: [], diffPair: [null, null] }),
  addStored: (input) => {
    const existing = get().scenarios.find((x) => x.stored?.id === input.stored.id);
    const id = existing?.id ?? newId();
    set((s) => {
      const entry: ImportScenario = { ...input, origin: 'stored', id, createdAt: existing?.createdAt ?? Date.now() };
      const scenarios = existing ? s.scenarios.map((x) => (x.id === id ? entry : x)) : [...s.scenarios, entry];
      const compareIds =
        s.compareIds.includes(id) || s.compareIds.length >= MAX_COMPARE ? s.compareIds : [...s.compareIds, id];
      return { scenarios, compareIds, diffPair: pairAfter(compareIds, s.diffPair) };
    });
    return id;
  },
  syncStored: (storedId, patch) =>
    set((s) => {
      const hit = s.scenarios.find((x) => x.stored?.id === storedId);
      if (!hit) return {};
      if (patch) return { scenarios: s.scenarios.map((x) => (x.id === hit.id ? { ...x, name: patch.name } : x)) };
      const compareIds = s.compareIds.filter((x) => x !== hit.id);
      return {
        scenarios: s.scenarios.filter((x) => x.id !== hit.id),
        compareIds,
        diffPair: pairAfter(compareIds, s.diffPair),
      };
    }),
}));

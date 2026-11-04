import { create } from 'zustand';

import type { EditMap, ImportOptions } from './import-rows';
import type { ImportRow, ImportSimulateResponse } from './import-types';

/**
 * Saved plan-import scenarios (P32-R05, docs/API_CONTRACT_P32.md C2). Session only: no
 * `persist`, nothing is sent to the server, a page refresh clears them. Each scenario is a
 * snapshot of the request (rows + options + edits) and the response exactly as served, so
 * the Compare tab only reads served figures.
 */

export const MAX_SCENARIOS = 10;
export const MAX_COMPARE = 4;
export const MAX_SCENARIO_NAME = 60;

export interface ImportScenario {
  id: string;
  name: string;
  /** `saved` from the current result; `variant` from the scenario builder. */
  origin: 'saved' | 'variant';
  /** A one-line description of the builder rules (variants only). */
  rules: string | null;
  fileName: string | null;
  createdAt: number;
  rows: ImportRow[];
  options: ImportOptions;
  edits: EditMap;
  response: ImportSimulateResponse;
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
    if (get().scenarios.length >= MAX_SCENARIOS) return null;
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
}));

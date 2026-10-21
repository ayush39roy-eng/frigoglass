import { create } from 'zustand';

import {
  LINE_FACTORIES,
  categoriesForHub,
  linesFromChatScenario,
  type LineListName,
  type ScenarioLines,
} from './scenario-schema';
import type { ChatScenario, WhatIfBasis, WhatIfTarget } from '../api/whatif-types';

/**
 * What-if scenario state (P18-T03). Scenario state only (PROJECT_AND_STACK §3):
 * the draft lines, the basis and the solve target. Results are TanStack mutation
 * data, never stored here; nothing is persisted (no `persist`), and nothing is
 * saved server-side. A page refresh clears it by design.
 */

export interface WhatIfScenarioState extends ScenarioLines {
  basis: WhatIfBasis;
  target: WhatIfTarget;
  /** Raw text of the designer FTE used by estimate and solve. */
  designerFte: string;
  addLine: <K extends LineListName>(list: K) => void;
  updateLine: <K extends LineListName>(list: K, key: string, patch: Partial<ScenarioLines[K][number]>) => void;
  removeLine: (list: LineListName, key: string) => void;
  setBasis: (basis: WhatIfBasis) => void;
  setTarget: (target: WhatIfTarget) => void;
  setDesignerFte: (value: string) => void;
  /** "Edit in builder": replace the draft with the chat's scenario. */
  loadChatScenario: (scenario: ChatScenario) => void;
  reset: () => void;
}

const EMPTY: ScenarioLines = { projects: [], engineers: [], removals: [], chambers: [], downtime: [] };
const DEFAULTS = { basis: 'year', target: 'all_new_within_year', designerFte: '1' } as const;

export const useWhatIfScenario = create<WhatIfScenarioState>()((set) => ({
  ...EMPTY,
  ...DEFAULTS,
  addLine: (list) =>
    set((s) => ({ [list]: [...s[list], LINE_FACTORIES[list]()] }) as Partial<WhatIfScenarioState>),
  updateLine: (list, key, patch) =>
    set((s) => {
      const lines = (s[list] as { key: string }[]).map((l) => {
        if (l.key !== key) return l;
        const next = { ...l, ...patch } as Record<string, unknown>;
        // A hub change must leave a category the new hub's workflow accepts.
        if (list === 'projects' && 'hub' in patch && patch.hub !== undefined) {
          const hub = patch.hub as string;
          const cat = next.category as string;
          if (!categoriesForHub(hub).some((c) => c === cat)) next.category = categoriesForHub(hub).at(-1) ?? 'C';
        }
        return next;
      });
      return { [list]: lines } as Partial<WhatIfScenarioState>;
    }),
  removeLine: (list, key) =>
    set((s) => ({ [list]: (s[list] as { key: string }[]).filter((l) => l.key !== key) }) as Partial<WhatIfScenarioState>),
  setBasis: (basis) => set({ basis }),
  setTarget: (target) => set({ target }),
  setDesignerFte: (designerFte) => set({ designerFte }),
  loadChatScenario: (scenario) => set({ ...linesFromChatScenario(scenario) }),
  reset: () => set({ ...EMPTY, ...DEFAULTS }),
}));

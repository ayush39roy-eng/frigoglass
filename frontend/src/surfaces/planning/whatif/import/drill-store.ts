import { create } from 'zustand';

import type { Drill } from './drilldown';

/**
 * The open drill-down (P32-R07): the one side sheet listing the projects (or parse rows)
 * behind a clicked figure. Session UI state only.
 */
export interface DrillState {
  drill: Drill | null;
  /** The figure button that opened the sheet; focus returns to it on close. */
  opener: HTMLElement | null;
  open: (drill: Drill, opener?: HTMLElement | null) => void;
  /** Close; `restoreFocus: false` when the action moves focus elsewhere (Show on Gantt). */
  close: (restoreFocus?: boolean) => void;
}

export const useDrill = create<DrillState>()((set) => ({
  drill: null,
  opener: null,
  open: (drill, opener = null) => set({ drill, opener }),
  close: (restoreFocus = true) => set((s) => ({ drill: null, opener: restoreFocus ? s.opener : null })),
}));

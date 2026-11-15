import * as React from 'react';
import { createStore, useStore, type StoreApi } from 'zustand';

/**
 * P34-T02 (D34-3): the grid's three text filters (Project search, Hub, Leader)
 * live in a small per-page store. Each filter input subscribes to its own field,
 * so typing re-renders that input and the page's filter pipeline (which reads
 * deferred values) but never rebuilds the grid's column definitions or remounts
 * an input (no focus loss). The board tab's search shares `q`.
 */

export type TextFilterField = 'q' | 'hubText' | 'leaderText';

export interface TextFilterState {
  q: string;
  hubText: string;
  leaderText: string;
  set: (field: TextFilterField, value: string) => void;
  reset: () => void;
}

export function createTextFilterStore(): StoreApi<TextFilterState> {
  return createStore<TextFilterState>()((set) => ({
    q: '',
    hubText: '',
    leaderText: '',
    set: (field, value) => set({ [field]: value } as Pick<TextFilterState, TextFilterField>),
    reset: () => set({ q: '', hubText: '', leaderText: '' }),
  }));
}

/** Provided by the Matrix page with its own store (`<TextFilterContext.Provider value={store}>`). */
export const TextFilterContext = React.createContext<StoreApi<TextFilterState> | null>(null);

export function useTextFilter<T>(selector: (s: TextFilterState) => T): T {
  const store = React.useContext(TextFilterContext);
  if (!store) throw new Error('useTextFilter needs a TextFilterProvider');
  return useStore(store, selector);
}

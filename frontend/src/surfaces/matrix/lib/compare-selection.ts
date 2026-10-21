import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { COMPARE_MAX } from '../api/types';

/**
 * P21 Compare selection: up to `COMPARE_MAX` projects, kept for the browser
 * session (sessionStorage) so it survives filter changes and navigation. Holds
 * ids and display names only; the compared figures come from
 * `GET /priorities/compare`.
 */
export interface CompareItem {
  id: string;
  name: string;
  hub: string;
}

interface CompareSelectionState {
  items: CompareItem[];
  /** Set when an add was refused because the cap was reached. */
  capHit: boolean;
  toggle: (item: CompareItem) => void;
  remove: (id: string) => void;
  clear: () => void;
  dismissCap: () => void;
}

export const useCompareSelection = create<CompareSelectionState>()(
  persist(
    (set) => ({
      items: [],
      capHit: false,
      toggle: (item) =>
        set((s) => {
          if (s.items.some((i) => i.id === item.id)) {
            return { items: s.items.filter((i) => i.id !== item.id), capHit: false };
          }
          if (s.items.length >= COMPARE_MAX) return { capHit: true };
          return { items: [...s.items, item], capHit: false };
        }),
      remove: (id) => set((s) => ({ items: s.items.filter((i) => i.id !== id), capHit: false })),
      clear: () => set({ items: [], capHit: false }),
      dismissCap: () => set({ capHit: false }),
    }),
    {
      name: 'rpd-matrix-compare',
      storage: createJSONStorage(() => sessionStorage),
      partialize: (s) => ({ items: s.items }),
    },
  ),
);

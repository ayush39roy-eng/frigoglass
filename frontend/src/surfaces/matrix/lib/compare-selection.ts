import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { SIGNED_OUT_EVENT } from '@/lib/auth/use-sign-out';

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

/**
 * P21-R01 (security S21-L2, second half): a same-tab sign-out clears the
 * in-memory selection too, so the next user never sees the previous user's
 * project names and hubs. Sign-out has already removed the `rpd-` keys; the
 * persisted key is removed again after the reset so it is not written back.
 */
export function clearCompareSelectionOnSignOut(): void {
  useCompareSelection.getState().clear();
  useCompareSelection.persist.clearStorage();
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener(SIGNED_OUT_EVENT, clearCompareSelectionOnSignOut);
}

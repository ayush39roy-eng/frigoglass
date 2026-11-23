import { create } from 'zustand';
import { createJSONStorage, persist, type StateStorage } from 'zustand/middleware';

/**
 * P61 (ADR 0069): the per-user "Auto-recalculate" switch.
 *
 * On (default) = today's behaviour: every save recalculates the plan. Off =
 * every plan write the UI sends carries `defer_recalc: true` (added centrally
 * in `lib/api/client.ts`, see `lib/api/defer-recalc.ts`), so saves are instant
 * and the user presses "Recalculate now" once when done.
 *
 * Stored in this browser (`localStorage`), keyed per signed-in email, so two
 * people sharing a browser keep their own choice. A storage that throws
 * (private mode, quota) is ignored: the switch then lives for the tab only.
 */

const safeStorage: StateStorage = {
  getItem: (name) => {
    try {
      return globalThis.localStorage.getItem(name);
    } catch {
      return null;
    }
  },
  setItem: (name, value) => {
    try {
      globalThis.localStorage.setItem(name, value);
    } catch {
      // Storage unavailable: keep the in-memory value.
    }
  },
  removeItem: (name) => {
    try {
      globalThis.localStorage.removeItem(name);
    } catch {
      // ignore
    }
  },
};

interface RecalcModeState {
  /** Per signed-in email; a user with no entry is On. */
  manualUsers: Record<string, true>;
  /** The email the switch currently applies to (set from the session). */
  activeEmail: string | null;
  setActiveEmail: (email: string | null) => void;
  setAutoRecalc: (on: boolean) => void;
}

const ANON = '';

export const useRecalcModeStore = create<RecalcModeState>()(
  persist(
    (set) => ({
      manualUsers: {},
      activeEmail: null,
      setActiveEmail: (activeEmail) => set({ activeEmail }),
      setAutoRecalc: (on) =>
        set((state) => {
          const key = state.activeEmail ?? ANON;
          const manualUsers = { ...state.manualUsers };
          if (on) delete manualUsers[key];
          else manualUsers[key] = true;
          return { manualUsers };
        }),
    }),
    {
      name: 'rpd-recalc-mode',
      storage: createJSONStorage(() => safeStorage),
      partialize: (state) => ({ manualUsers: state.manualUsers }),
    },
  ),
);

function autoOf(state: RecalcModeState): boolean {
  return state.manualUsers[state.activeEmail ?? ANON] !== true;
}

/** The switch for the signed-in user (true = auto-recalculate, the default). */
export function useAutoRecalc(): boolean {
  return useRecalcModeStore(autoOf);
}

/** Outside React: true when writes must carry `defer_recalc: true`. */
export function isDeferringRecalc(): boolean {
  return !autoOf(useRecalcModeStore.getState());
}

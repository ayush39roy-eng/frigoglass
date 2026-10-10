import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useShallow } from 'zustand/react/shallow';

/**
 * Global hub filter (P12, ADR 0020, API_CONTRACT_P12 §7).
 *
 * One hub id (or `null` = "All hubs") chosen in the header and read by every
 * portfolio surface. Each surface passes `hub_id: hubId ?? undefined` to the API
 * and puts `hubId` in its query key; the server filters (ANDed with the caller's
 * hub scope, never widening it). The browser never computes a hub figure (I9/I19).
 *
 * Persisted per browser under `rpd-hub-filter`. The header resets a persisted hub
 * that is no longer in the caller's scope back to `null`.
 */
export interface HubFilterState {
  hubId: string | null;
  setHubId: (id: string | null) => void;
}

export const useHubFilterStore = create<HubFilterState>()(
  persist(
    (set) => ({
      hubId: null,
      setHubId: (hubId) => set({ hubId }),
    }),
    { name: 'rpd-hub-filter', partialize: (state) => ({ hubId: state.hubId }) },
  ),
);

export function useHubFilter(): { hubId: string | null; setHubId: (id: string | null) => void } {
  return useHubFilterStore(useShallow((s) => ({ hubId: s.hubId, setHubId: s.setHubId })));
}

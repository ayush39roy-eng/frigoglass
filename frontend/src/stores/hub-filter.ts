import { useMemo } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useShallow } from 'zustand/react/shallow';

import { LAB_REGIONS, type LabRegion } from '@/types/enums';

/**
 * Global hub / country filter (P12 ADR 0020, extended by P13 ADR 0025 and
 * API_CONTRACT_P13 §4).
 *
 * Two mutually exclusive levels chosen in the header (and, for the country, the
 * Dashboard's segmented buttons):
 * - `region` — a country, i.e. a hub's served `lab_region` (Greece / India /
 *   Romania). Choosing one clears `hubId`.
 * - `hubId` — one hub. Choosing one clears `region`.
 * - both `null` — "All hubs".
 *
 * Every portfolio surface sends both as `hub_id` / `region` (see
 * `useHubFilterParams`) and puts both in its query key; the server filters
 * (ANDed with the caller's hub scope, never widening it). The browser never
 * computes a hub or country figure (I9/I19/I23).
 *
 * Persisted per browser under `rpd-hub-filter` (version 1). Version-0 payloads
 * (`{ hubId }`, P12) migrate to `{ hubId, region: null }`. The header resets a
 * persisted hub that is no longer in the caller's scope back to `null`.
 */
export interface HubFilterState {
  hubId: string | null;
  region: LabRegion | null;
  setHubId: (id: string | null) => void;
  setRegion: (region: LabRegion | null) => void;
  clear: () => void;
}

/** The two query params every hub-filtered endpoint takes. */
export interface HubFilterParams {
  hub_id?: string;
  region?: LabRegion;
}

export function isLabRegion(value: unknown): value is LabRegion {
  return typeof value === 'string' && (LAB_REGIONS as readonly string[]).includes(value);
}

interface PersistedHubFilter {
  hubId: string | null;
  region: LabRegion | null;
}

/** Old (`{ hubId }`, version 0) and malformed payloads load safely. Exported for tests. */
export function migrateHubFilter(persisted: unknown): PersistedHubFilter {
  const raw = (persisted && typeof persisted === 'object' ? persisted : {}) as Record<string, unknown>;
  const hubId = typeof raw.hubId === 'string' ? raw.hubId : null;
  const region = isLabRegion(raw.region) ? raw.region : null;
  // Mutually exclusive: a payload carrying both keeps the hub (the narrower choice).
  return { hubId, region: hubId !== null ? null : region };
}

export const useHubFilterStore = create<HubFilterState>()(
  persist(
    (set) => ({
      hubId: null,
      region: null,
      setHubId: (hubId) => set({ hubId, region: null }),
      setRegion: (region) => set({ region, hubId: null }),
      clear: () => set({ hubId: null, region: null }),
    }),
    {
      name: 'rpd-hub-filter',
      version: 1,
      migrate: (persisted) => migrateHubFilter(persisted) as unknown as HubFilterState,
      partialize: (state) => ({ hubId: state.hubId, region: state.region }),
    },
  ),
);

export function useHubFilter(): {
  hubId: string | null;
  region: LabRegion | null;
  setHubId: (id: string | null) => void;
  setRegion: (region: LabRegion | null) => void;
  clear: () => void;
} {
  return useHubFilterStore(
    useShallow((s) => ({
      hubId: s.hubId,
      region: s.region,
      setHubId: s.setHubId,
      setRegion: s.setRegion,
      clear: s.clear,
    })),
  );
}

/** `{ hub_id?, region? }` for the API — absent keys mean "not filtered". */
export function toHubFilterParams(hubId: string | null, region: LabRegion | null): HubFilterParams {
  const params: HubFilterParams = {};
  if (hubId) params.hub_id = hubId;
  if (region) params.region = region;
  return params;
}

/** The current global filter as API params (contract §4). */
export function useHubFilterParams(): HubFilterParams {
  const hubId = useHubFilterStore((s) => s.hubId);
  const region = useHubFilterStore((s) => s.region);
  return useMemo(() => toHubFilterParams(hubId, region), [hubId, region]);
}

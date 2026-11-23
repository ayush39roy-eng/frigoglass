import { useMemo } from 'react';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { useShallow } from 'zustand/react/shallow';

import { LAB_REGIONS, type LabRegion } from '@/types/enums';

/**
 * Global hub / country filter (P12 ADR 0020, P13 ADR 0025; multi-select per
 * `docs/API_CONTRACT_MULTISELECT.md` §2–§3, owner ask 2026-11-13).
 *
 * The header picks any mix of countries and hubs:
 * - `regions` — countries, i.e. served hub `lab_region`s (Greece / India / Romania);
 * - `hubIds` — individual hubs;
 * - both empty — "All hubs".
 *
 * The server UNIONS the two lists (a project is in view when its hub is in
 * `hub_id` OR its hub's region is in `region`) and ANDs the result with the
 * caller's RBAC scope (never wider). Every portfolio surface sends both lists as
 * REPEATED params (`useHubFilterParams`) and keys its queries on the SORTED
 * lists. The browser never computes a hub or country figure (I9/I19/I23).
 *
 * Persisted per browser under `rpd-hub-filter`, version 2. Older payloads
 * migrate: v0 `{ hubId }` and v1 `{ hubId, region }` become one-element lists
 * (`null` → `[]`). The header drops persisted hubs / countries that are no
 * longer in the caller's scope.
 *
 * Legacy mirrors: `hubId` / `region` are kept (not persisted) for the one
 * surface not yet converted (the Matrix, reworked concurrently; contract §3).
 * They carry the selection only when it is exactly one hub or exactly one
 * country; any other selection reads `null` there.
 */
export interface HubFilterState {
  hubIds: string[];
  regions: LabRegion[];
  /** @deprecated legacy single-value mirror (Matrix only); use `hubIds`. */
  hubId: string | null;
  /** @deprecated legacy single-value mirror (Matrix only); use `regions`. */
  region: LabRegion | null;
  setHubIds: (ids: readonly string[]) => void;
  setRegions: (regions: readonly LabRegion[]) => void;
  /** Set both lists in one store write. */
  setSelection: (hubIds: readonly string[], regions: readonly LabRegion[]) => void;
  toggleHub: (id: string) => void;
  toggleRegion: (region: LabRegion) => void;
  /** Replace the whole selection with one hub (`null` clears everything). */
  setHubId: (id: string | null) => void;
  /** Replace the whole selection with one country (`null` clears everything). */
  setRegion: (region: LabRegion | null) => void;
  clear: () => void;
}

/** The two query params every hub-filtered endpoint takes, as repeated params. */
export interface HubFilterParams {
  hub_id?: string[];
  region?: LabRegion[];
}

/** The selection as plain lists (what fetchers and query keys take). */
export interface HubSelection {
  hubIds: readonly string[];
  regions: readonly LabRegion[];
}

export const NO_HUB_SELECTION: HubSelection = { hubIds: [], regions: [] };

export function isLabRegion(value: unknown): value is LabRegion {
  return typeof value === 'string' && (LAB_REGIONS as readonly string[]).includes(value);
}

interface PersistedHubFilter {
  hubIds: string[];
  regions: LabRegion[];
}

function uniqueStrings(values: Iterable<unknown>): string[] {
  const out: string[] = [];
  for (const v of values) if (typeof v === 'string' && v !== '' && !out.includes(v)) out.push(v);
  return out;
}

/** Countries in the fixed Greece / India / Romania order, deduplicated. */
function canonicalRegions(values: Iterable<unknown>): LabRegion[] {
  const picked = new Set<unknown>(values);
  return LAB_REGIONS.filter((r) => picked.has(r));
}

/**
 * Load any persisted payload safely (exported for tests):
 * - v2 `{ hubIds: string[], regions: LabRegion[] }` — kept, malformed entries dropped;
 * - v1 `{ hubId, region }` / v0 `{ hubId }` — a value becomes `[value]`, `null` becomes `[]`;
 * - anything else — "All hubs".
 */
export function migrateHubFilter(persisted: unknown): PersistedHubFilter {
  const raw = (persisted && typeof persisted === 'object' ? persisted : {}) as Record<string, unknown>;
  const hubIds = Array.isArray(raw.hubIds)
    ? uniqueStrings(raw.hubIds as unknown[])
    : typeof raw.hubId === 'string' && raw.hubId !== ''
      ? [raw.hubId]
      : [];
  const regions = Array.isArray(raw.regions)
    ? canonicalRegions(raw.regions as unknown[])
    : isLabRegion(raw.region)
      ? [raw.region]
      : [];
  return { hubIds, regions };
}

/** The legacy single-value mirrors for a selection (see the header comment). */
export function legacyMirrors(
  hubIds: readonly string[],
  regions: readonly LabRegion[],
): { hubId: string | null; region: LabRegion | null } {
  return {
    hubId: hubIds.length === 1 && regions.length === 0 ? (hubIds[0] ?? null) : null,
    region: regions.length === 1 && hubIds.length === 0 ? (regions[0] ?? null) : null,
  };
}

function selectionState(
  hubIds: readonly string[],
  regions: readonly LabRegion[],
): Pick<HubFilterState, 'hubIds' | 'regions' | 'hubId' | 'region'> {
  const ids = uniqueStrings(hubIds);
  const rs = canonicalRegions(regions);
  return { hubIds: ids, regions: rs, ...legacyMirrors(ids, rs) };
}

export const useHubFilterStore = create<HubFilterState>()(
  persist(
    (set, get) => ({
      hubIds: [],
      regions: [],
      hubId: null,
      region: null,
      setHubIds: (ids) => set(selectionState(ids, get().regions)),
      setRegions: (regions) => set(selectionState(get().hubIds, regions)),
      setSelection: (hubIds, regions) => set(selectionState(hubIds, regions)),
      toggleHub: (id) => {
        const cur = get().hubIds;
        set(selectionState(cur.includes(id) ? cur.filter((h) => h !== id) : [...cur, id], get().regions));
      },
      toggleRegion: (region) => {
        const cur = get().regions;
        set(selectionState(get().hubIds, cur.includes(region) ? cur.filter((r) => r !== region) : [...cur, region]));
      },
      setHubId: (id) => set(selectionState(id === null ? [] : [id], [])),
      setRegion: (region) => set(selectionState([], region === null ? [] : [region])),
      clear: () => set(selectionState([], [])),
    }),
    {
      name: 'rpd-hub-filter',
      version: 2,
      migrate: (persisted) => migrateHubFilter(persisted) as unknown as HubFilterState,
      partialize: (state) => ({ hubIds: state.hubIds, regions: state.regions }),
      // Re-validate the stored lists and rebuild the legacy mirrors on load.
      merge: (persisted, current) => {
        const { hubIds, regions } = migrateHubFilter(persisted);
        return { ...current, ...selectionState(hubIds, regions) };
      },
    },
  ),
);

/**
 * Legacy compatibility: a direct `setState({ hubId })` / `setState({ region })`
 * (the not-yet-converted Matrix and its tests) writes only a mirror. When the
 * mirrors no longer match the lists, rebuild the lists from them, so every
 * converted surface sees the same selection. The actions above always keep the
 * two consistent, so this never fires for them (and cannot loop).
 */
useHubFilterStore.subscribe((s) => {
  const m = legacyMirrors(s.hubIds, s.regions);
  if (m.hubId !== s.hubId || m.region !== s.region) {
    s.setSelection(s.hubId ? [s.hubId] : [], s.region ? [s.region] : []);
  }
});

export function useHubFilter(): Pick<
  HubFilterState,
  | 'hubIds'
  | 'regions'
  | 'hubId'
  | 'region'
  | 'setHubIds'
  | 'setRegions'
  | 'setSelection'
  | 'toggleHub'
  | 'toggleRegion'
  | 'setHubId'
  | 'setRegion'
  | 'clear'
> {
  return useHubFilterStore(
    useShallow((s) => ({
      hubIds: s.hubIds,
      regions: s.regions,
      hubId: s.hubId,
      region: s.region,
      setHubIds: s.setHubIds,
      setRegions: s.setRegions,
      setSelection: s.setSelection,
      toggleHub: s.toggleHub,
      toggleRegion: s.toggleRegion,
      setHubId: s.setHubId,
      setRegion: s.setRegion,
      clear: s.clear,
    })),
  );
}

/** `true` when any hub or country is selected. */
export function hasHubSelection(sel: HubSelection): boolean {
  return sel.hubIds.length > 0 || sel.regions.length > 0;
}

/** ADR 0068: exactly one hub in view (one hub picked, no country), so a hub
 *  rank alone is unambiguous. A country or several hubs mix hubs in one list:
 *  the global rank is shown too. */
export function isSingleHubSelection(sel: HubSelection): boolean {
  return sel.hubIds.length === 1 && sel.regions.length === 0;
}

/** The current selection as plain lists, stable across unrelated renders. */
export function useHubSelection(): HubSelection {
  const hubIds = useHubFilterStore((s) => s.hubIds);
  const regions = useHubFilterStore((s) => s.regions);
  return useMemo(() => ({ hubIds, regions }), [hubIds, regions]);
}

/**
 * `{ hub_id?, region? }` for the API: SORTED lists, sent as repeated params
 * (`hub_id=a&hub_id=b`); an empty list is left out ("not filtered").
 */
export function toHubFilterParams(hubIds: readonly string[], regions: readonly LabRegion[]): HubFilterParams {
  const params: HubFilterParams = {};
  if (hubIds.length > 0) params.hub_id = [...hubIds].sort();
  if (regions.length > 0) params.region = [...regions].sort();
  return params;
}

/** The current global filter as API params (contract §2). */
export function useHubFilterParams(): HubFilterParams {
  const hubIds = useHubFilterStore((s) => s.hubIds);
  const regions = useHubFilterStore((s) => s.regions);
  return useMemo(() => toHubFilterParams(hubIds, regions), [hubIds, regions]);
}

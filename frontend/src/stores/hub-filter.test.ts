import { afterEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import {
  legacyMirrors,
  migrateHubFilter,
  toHubFilterParams,
  useHubFilter,
  useHubFilterParams,
  useHubFilterStore,
  useHubSelection,
} from './hub-filter';

afterEach(() => {
  useHubFilterStore.getState().clear();
  localStorage.removeItem('rpd-hub-filter');
});

describe('useHubFilterStore — multi-select (contract §3)', () => {
  it('defaults to "All hubs" (both lists empty)', () => {
    expect(useHubFilterStore.getState()).toMatchObject({ hubIds: [], regions: [], hubId: null, region: null });
  });

  it('toggles hubs and countries independently (the server unions them)', () => {
    const st = useHubFilterStore.getState();
    st.toggleRegion('India');
    useHubFilterStore.getState().toggleHub('hub-gr');
    useHubFilterStore.getState().toggleHub('hub-ro');
    expect(useHubFilterStore.getState()).toMatchObject({ hubIds: ['hub-gr', 'hub-ro'], regions: ['India'] });
    useHubFilterStore.getState().toggleHub('hub-gr');
    useHubFilterStore.getState().toggleRegion('Greece');
    expect(useHubFilterStore.getState()).toMatchObject({ hubIds: ['hub-ro'], regions: ['Greece', 'India'] });
    useHubFilterStore.getState().clear();
    expect(useHubFilterStore.getState()).toMatchObject({ hubIds: [], regions: [] });
  });

  it('setHubId / setRegion replace the whole selection with one value (null clears)', () => {
    useHubFilterStore.getState().setSelection(['a', 'b'], ['India']);
    useHubFilterStore.getState().setHubId('hub-pd');
    expect(useHubFilterStore.getState()).toMatchObject({ hubIds: ['hub-pd'], regions: [] });
    useHubFilterStore.getState().setRegion('Romania');
    expect(useHubFilterStore.getState()).toMatchObject({ hubIds: [], regions: ['Romania'] });
    useHubFilterStore.getState().setRegion(null);
    expect(useHubFilterStore.getState()).toMatchObject({ hubIds: [], regions: [] });
  });

  it('drops duplicates and keeps countries in Greece / India / Romania order', () => {
    useHubFilterStore.getState().setSelection(['x', 'x', ''], ['Romania', 'Greece', 'Romania']);
    expect(useHubFilterStore.getState()).toMatchObject({ hubIds: ['x'], regions: ['Greece', 'Romania'] });
  });

  it('keeps the legacy single-value mirrors only for exactly one hub or one country', () => {
    expect(legacyMirrors(['h'], [])).toEqual({ hubId: 'h', region: null });
    expect(legacyMirrors([], ['India'])).toEqual({ hubId: null, region: 'India' });
    expect(legacyMirrors(['h'], ['India'])).toEqual({ hubId: null, region: null });
    expect(legacyMirrors(['a', 'b'], [])).toEqual({ hubId: null, region: null });
    useHubFilterStore.getState().setHubId('hub-1');
    expect(useHubFilterStore.getState()).toMatchObject({ hubId: 'hub-1', region: null });
    useHubFilterStore.getState().toggleHub('hub-2');
    expect(useHubFilterStore.getState()).toMatchObject({ hubId: null, region: null });
  });

  it('a legacy direct setState({ hubId } / { region }) is reconciled into the lists (Matrix compatibility)', () => {
    useHubFilterStore.setState({ hubId: 'hub-romania' });
    expect(useHubFilterStore.getState()).toMatchObject({ hubIds: ['hub-romania'], regions: [] });
    useHubFilterStore.setState({ hubId: null, region: 'India' });
    expect(useHubFilterStore.getState()).toMatchObject({ hubIds: [], regions: ['India'] });
    useHubFilterStore.setState({ hubId: null, region: null });
    expect(useHubFilterStore.getState()).toMatchObject({ hubIds: [], regions: [] });
  });

  it('persists the lists under rpd-hub-filter, version 2 (mirrors are not stored)', () => {
    useHubFilterStore.getState().setSelection(['hub-india'], ['Romania']);
    const stored = JSON.parse(localStorage.getItem('rpd-hub-filter') ?? '{}') as {
      state?: unknown;
      version?: number;
    };
    expect(stored.state).toEqual({ hubIds: ['hub-india'], regions: ['Romania'] });
    expect(stored.version).toBe(2);
  });

  it('useHubFilter() exposes the lists and the toggles', () => {
    const { result } = renderHook(() => useHubFilter());
    expect(result.current.hubIds).toEqual([]);
    act(() => result.current.toggleHub('hub-romania'));
    act(() => result.current.toggleRegion('India'));
    expect(result.current.hubIds).toEqual(['hub-romania']);
    expect(result.current.regions).toEqual(['India']);
  });

  it('useHubSelection() is stable across unrelated renders', () => {
    const { result, rerender } = renderHook(() => useHubSelection());
    const first = result.current;
    rerender();
    expect(result.current).toBe(first);
    act(() => useHubFilterStore.getState().toggleRegion('Greece'));
    expect(result.current).not.toBe(first);
    expect(result.current).toEqual({ hubIds: [], regions: ['Greece'] });
  });
});

describe('persisted-state migration (v0 / v1 → v2)', () => {
  it('v1 { hubId } becomes [hubId]; null becomes []', async () => {
    localStorage.setItem('rpd-hub-filter', JSON.stringify({ state: { hubId: 'hub-greece', region: null }, version: 1 }));
    await useHubFilterStore.persist.rehydrate();
    expect(useHubFilterStore.getState()).toMatchObject({
      hubIds: ['hub-greece'],
      regions: [],
      hubId: 'hub-greece',
      region: null,
    });
  });

  it('v1 { region } becomes [region]', async () => {
    localStorage.setItem('rpd-hub-filter', JSON.stringify({ state: { hubId: null, region: 'India' }, version: 1 }));
    await useHubFilterStore.persist.rehydrate();
    expect(useHubFilterStore.getState()).toMatchObject({ hubIds: [], regions: ['India'], region: 'India' });
  });

  it('v0 (P12) { hubId } migrates without losing the hub', async () => {
    localStorage.setItem('rpd-hub-filter', JSON.stringify({ state: { hubId: 'hub-ro' }, version: 0 }));
    await useHubFilterStore.persist.rehydrate();
    expect(useHubFilterStore.getState()).toMatchObject({ hubIds: ['hub-ro'], regions: [] });
  });

  it('rehydrates a v2 payload as stored', async () => {
    localStorage.setItem(
      'rpd-hub-filter',
      JSON.stringify({ state: { hubIds: ['a', 'b'], regions: ['Romania', 'India'] }, version: 2 }),
    );
    await useHubFilterStore.persist.rehydrate();
    expect(useHubFilterStore.getState()).toMatchObject({ hubIds: ['a', 'b'], regions: ['India', 'Romania'] });
  });

  it('migrateHubFilter drops malformed values', () => {
    expect(migrateHubFilter(undefined)).toEqual({ hubIds: [], regions: [] });
    expect(migrateHubFilter({ hubId: 42, region: 'Atlantis' })).toEqual({ hubIds: [], regions: [] });
    expect(migrateHubFilter({ hubId: null, region: null })).toEqual({ hubIds: [], regions: [] });
    expect(migrateHubFilter({ region: 'Greece' })).toEqual({ hubIds: [], regions: ['Greece'] });
    expect(migrateHubFilter({ hubId: 'h', region: 'Greece' })).toEqual({ hubIds: ['h'], regions: ['Greece'] });
    expect(migrateHubFilter({ hubIds: ['a', 7, 'a'], regions: ['Mars', 'India'] })).toEqual({
      hubIds: ['a'],
      regions: ['India'],
    });
  });
});

describe('API params (contract §1–§2)', () => {
  it('useHubFilterParams() gives sorted lists, absent keys when empty', () => {
    const { result } = renderHook(() => useHubFilterParams());
    expect(result.current).toEqual({});
    const first = result.current;
    act(() => useHubFilterStore.getState().setRegions(['Romania', 'India']));
    expect(result.current).toEqual({ region: ['India', 'Romania'] });
    expect(result.current).not.toBe(first);
    act(() => useHubFilterStore.getState().setHubIds(['hub-z', 'hub-a']));
    expect(result.current).toEqual({ hub_id: ['hub-a', 'hub-z'], region: ['India', 'Romania'] });
    expect(toHubFilterParams([], [])).toEqual({});
  });
});

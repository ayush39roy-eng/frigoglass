import { afterEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import { migrateHubFilter, toHubFilterParams, useHubFilter, useHubFilterParams, useHubFilterStore } from './hub-filter';

afterEach(() => {
  useHubFilterStore.setState({ hubId: null, region: null });
  localStorage.removeItem('rpd-hub-filter');
});

describe('useHubFilterStore (ADR 0020)', () => {
  it('defaults to "All hubs" (null)', () => {
    expect(useHubFilterStore.getState().hubId).toBeNull();
  });

  it('persists the choice per browser under rpd-hub-filter', () => {
    useHubFilterStore.getState().setHubId('hub-india');
    const stored = JSON.parse(localStorage.getItem('rpd-hub-filter') ?? '{}') as { state?: { hubId?: string } };
    expect(stored.state?.hubId).toBe('hub-india');
    useHubFilterStore.getState().setHubId(null);
    const cleared = JSON.parse(localStorage.getItem('rpd-hub-filter') ?? '{}') as { state?: { hubId?: unknown } };
    expect(cleared.state?.hubId).toBeNull();
  });

  it('rehydrates a stored choice', async () => {
    localStorage.setItem('rpd-hub-filter', JSON.stringify({ state: { hubId: 'hub-greece' }, version: 0 }));
    await useHubFilterStore.persist.rehydrate();
    expect(useHubFilterStore.getState().hubId).toBe('hub-greece');
  });

  it('useHubFilter() exposes hubId + setHubId', () => {
    const { result } = renderHook(() => useHubFilter());
    expect(result.current.hubId).toBeNull();
    act(() => result.current.setHubId('hub-romania'));
    expect(result.current.hubId).toBe('hub-romania');
  });
});

describe('country filter (P13, ADR 0025)', () => {
  it('defaults to no country', () => {
    expect(useHubFilterStore.getState().region).toBeNull();
  });

  it('setRegion clears the hub; setHubId clears the country; clear() resets both', () => {
    const st = useHubFilterStore.getState();
    st.setHubId('hub-india');
    useHubFilterStore.getState().setRegion('Greece');
    expect(useHubFilterStore.getState()).toMatchObject({ hubId: null, region: 'Greece' });
    useHubFilterStore.getState().setHubId('hub-romania');
    expect(useHubFilterStore.getState()).toMatchObject({ hubId: 'hub-romania', region: null });
    useHubFilterStore.getState().setRegion('India');
    useHubFilterStore.getState().clear();
    expect(useHubFilterStore.getState()).toMatchObject({ hubId: null, region: null });
  });

  it('persists the country under rpd-hub-filter, version 1', () => {
    useHubFilterStore.getState().setRegion('Romania');
    const stored = JSON.parse(localStorage.getItem('rpd-hub-filter') ?? '{}') as {
      state?: { hubId?: unknown; region?: unknown };
      version?: number;
    };
    expect(stored.state).toEqual({ hubId: null, region: 'Romania' });
    expect(stored.version).toBe(1);
  });

  it('migrates an old P12 { hubId } payload (version 0) without losing the hub', async () => {
    localStorage.setItem('rpd-hub-filter', JSON.stringify({ state: { hubId: 'hub-greece' }, version: 0 }));
    await useHubFilterStore.persist.rehydrate();
    expect(useHubFilterStore.getState()).toMatchObject({ hubId: 'hub-greece', region: null });
  });

  it('rehydrates a version-1 country payload', async () => {
    localStorage.setItem('rpd-hub-filter', JSON.stringify({ state: { hubId: null, region: 'India' }, version: 1 }));
    await useHubFilterStore.persist.rehydrate();
    expect(useHubFilterStore.getState()).toMatchObject({ hubId: null, region: 'India' });
  });

  it('migrateHubFilter drops malformed values and keeps the two levels exclusive', () => {
    expect(migrateHubFilter(undefined)).toEqual({ hubId: null, region: null });
    expect(migrateHubFilter({ hubId: 42, region: 'Atlantis' })).toEqual({ hubId: null, region: null });
    expect(migrateHubFilter({ region: 'Greece' })).toEqual({ hubId: null, region: 'Greece' });
    expect(migrateHubFilter({ hubId: 'h', region: 'Greece' })).toEqual({ hubId: 'h', region: null });
  });

  it('useHubFilterParams() gives { hub_id?, region? } with absent keys when unset', () => {
    const { result } = renderHook(() => useHubFilterParams());
    expect(result.current).toEqual({});
    const first = result.current;
    act(() => useHubFilterStore.getState().setRegion('India'));
    expect(result.current).toEqual({ region: 'India' });
    expect(result.current).not.toBe(first);
    act(() => useHubFilterStore.getState().setHubId('hub-1'));
    expect(result.current).toEqual({ hub_id: 'hub-1' });
    expect(toHubFilterParams(null, null)).toEqual({});
  });
});

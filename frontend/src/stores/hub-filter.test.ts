import { afterEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import { useHubFilter, useHubFilterStore } from './hub-filter';

afterEach(() => {
  useHubFilterStore.setState({ hubId: null });
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

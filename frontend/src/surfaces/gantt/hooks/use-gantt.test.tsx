import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import * as React from 'react';

vi.mock('../api/gantt-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../api/gantt-api')>();
  return {
    ...actual,
    fetchGantt: vi.fn(),
    toggleFreeze: vi.fn(),
    fetchActiveScheduleRun: vi.fn(),
  };
});

import * as api from '../api/gantt-api';
import { useGantt, useToggleFreeze } from './use-gantt';

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, Wrapper };
}

beforeEach(() => vi.clearAllMocks());

describe('useGantt', () => {
  it('re-fetches when the hub filter changes (hubId is part of the query key)', async () => {
    vi.mocked(api.fetchGantt).mockResolvedValue({
      has_active_schedule_run: true,
      schedule_run_version: 3,
      total_count: 0,
      rows: [],
    });
    const { Wrapper } = makeWrapper();
    const { rerender } = renderHook(
      ({ hubId }: { hubId: string | undefined }) => useGantt({ hubId }),
      { wrapper: Wrapper, initialProps: { hubId: undefined } as { hubId: string | undefined } },
    );
    await waitFor(() => expect(api.fetchGantt).toHaveBeenCalledTimes(1));
    rerender({ hubId: 'hub-1' });
    await waitFor(() => expect(api.fetchGantt).toHaveBeenCalledTimes(2));
    rerender({ hubId: 'hub-2' });
    await waitFor(() => expect(api.fetchGantt).toHaveBeenCalledTimes(3));
    expect(vi.mocked(api.fetchGantt).mock.calls[2]?.[0]).toEqual({ hubId: 'hub-2' });
  });
});

describe('useToggleFreeze', () => {
  it('invalidates the gantt keys but NOT schedule-runs / dashboard / capacity (freeze does not recalc)', async () => {
    vi.mocked(api.toggleFreeze).mockResolvedValue({
      id: 'p1',
      name: 'P1',
      frozen: true,
      actual_start_week: 10,
    });
    const { client, Wrapper } = makeWrapper();
    const spy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useToggleFreeze(), { wrapper: Wrapper });

    await result.current.mutateAsync({
      projectId: 'p1',
      body: { frozen: true, actual_start_week: 10 },
    });

    await waitFor(() => expect(spy).toHaveBeenCalled());
    const keys = spy.mock.calls.map((c) => c[0]?.queryKey);
    expect(keys).toContainEqual(['gantt']);
    for (const key of keys) {
      expect(key).not.toContainEqual('schedule-runs');
      expect(key).not.toContainEqual('dashboard');
      expect(key).not.toContainEqual('capacity');
    }
  });
});

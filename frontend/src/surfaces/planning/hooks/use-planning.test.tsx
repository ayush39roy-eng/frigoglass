import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import * as React from 'react';

vi.mock('../api/planning-api', () => ({
  fetchEngineers: vi.fn(),
  createEngineer: vi.fn(),
  updateEngineer: vi.fn(),
  deleteEngineer: vi.fn(),
  fetchChambers: vi.fn(),
  createChamber: vi.fn(),
  updateChamber: vi.fn(),
  deleteChamber: vi.fn(),
  fetchActiveScheduleRun: vi.fn(),
  triggerApplyLogic: vi.fn(),
}));

import * as api from '../api/planning-api';
import {
  useApplyLogic,
  useChamberList,
  useCreateChamber,
  useCreateEngineer,
  useDeleteChamber,
  useDeleteEngineer,
  useEngineerList,
  useUpdateChamber,
  useUpdateEngineer,
} from './use-planning';

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, Wrapper };
}

beforeEach(() => vi.clearAllMocks());

describe('use-planning', () => {
  it('re-fetches the engineer list when the hub filter changes (hubId is part of the query key)', async () => {
    vi.mocked(api.fetchEngineers).mockResolvedValue([]);
    const { Wrapper } = makeWrapper();
    const { rerender } = renderHook(
      ({ hubId }: { hubId: string | undefined }) => useEngineerList(hubId),
      { wrapper: Wrapper, initialProps: { hubId: undefined } as { hubId: string | undefined } },
    );
    await waitFor(() => expect(api.fetchEngineers).toHaveBeenCalledTimes(1));
    rerender({ hubId: 'hub-1' });
    await waitFor(() => expect(api.fetchEngineers).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.fetchEngineers).mock.calls[1]?.[0]).toBe('hub-1');
  });

  it('fetches the chamber list with no arguments', async () => {
    vi.mocked(api.fetchChambers).mockResolvedValue([]);
    const { Wrapper } = makeWrapper();
    renderHook(() => useChamberList(), { wrapper: Wrapper });
    await waitFor(() => expect(api.fetchChambers).toHaveBeenCalledTimes(1));
  });

  it('on create engineer, invalidates the engineer list AND the live capacity keys (hub-load / utilization-matrix)', async () => {
    vi.mocked(api.createEngineer).mockResolvedValue({ id: 'e1' } as never);
    const { client, Wrapper } = makeWrapper();
    const spy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useCreateEngineer(), { wrapper: Wrapper });
    await result.current.mutateAsync({ name: 'Ada', hub_id: 'hub-1' });
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const keys = spy.mock.calls.map((c) => c[0]?.queryKey);
    expect(keys).toContainEqual(['engineers']);
    expect(keys).toContainEqual(['capacity', 'hub-load']);
    expect(keys).toContainEqual(['capacity', 'utilization-matrix']);
    // Engineer/chamber CRUD does NOT recompute the schedule itself — the load
    // (booked) side of capacity, plus dashboard/gantt/schedule-runs, only
    // change via Apply Logic.
    for (const key of keys) {
      expect(key).not.toEqual(['schedule-runs']);
      expect(key).not.toEqual(['dashboard']);
      expect(key).not.toEqual(['gantt']);
    }
  });

  it('on update/delete engineer, also invalidates the live capacity keys', async () => {
    vi.mocked(api.updateEngineer).mockResolvedValue({ id: 'e1' } as never);
    vi.mocked(api.deleteEngineer).mockResolvedValue(undefined);
    const { client, Wrapper } = makeWrapper();
    const spy = vi.spyOn(client, 'invalidateQueries');

    const { result: updateResult } = renderHook(() => useUpdateEngineer(), { wrapper: Wrapper });
    await updateResult.current.mutateAsync({ engineerId: 'e1', body: { fte: 0.5 } });
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls.map((c) => c[0]?.queryKey)).toContainEqual(['capacity', 'hub-load']);

    spy.mockClear();
    const { result: deleteResult } = renderHook(() => useDeleteEngineer(), { wrapper: Wrapper });
    await deleteResult.current.mutateAsync('e1');
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls.map((c) => c[0]?.queryKey)).toContainEqual(['capacity', 'utilization-matrix']);
  });

  it('on create/update/delete chamber, invalidates the chamber list AND the live capacity keys', async () => {
    vi.mocked(api.createChamber).mockResolvedValue({ id: 'c1' } as never);
    vi.mocked(api.updateChamber).mockResolvedValue({ id: 'c1' } as never);
    vi.mocked(api.deleteChamber).mockResolvedValue(undefined);
    const { client, Wrapper } = makeWrapper();
    const spy = vi.spyOn(client, 'invalidateQueries');

    const { result: createResult } = renderHook(() => useCreateChamber(), { wrapper: Wrapper });
    await createResult.current.mutateAsync({ code: 'GR-CH1', lab_region: 'Greece', max_concurrent: 2 });
    await waitFor(() => expect(spy).toHaveBeenCalled());
    let keys = spy.mock.calls.map((c) => c[0]?.queryKey);
    expect(keys).toContainEqual(['chambers']);
    expect(keys).toContainEqual(['capacity', 'hub-load']);

    spy.mockClear();
    const { result: updateResult } = renderHook(() => useUpdateChamber(), { wrapper: Wrapper });
    await updateResult.current.mutateAsync({ chamberId: 'c1', body: { max_concurrent: 3 } });
    await waitFor(() => expect(spy).toHaveBeenCalled());
    keys = spy.mock.calls.map((c) => c[0]?.queryKey);
    expect(keys).toContainEqual(['capacity', 'utilization-matrix']);

    spy.mockClear();
    const { result: deleteResult } = renderHook(() => useDeleteChamber(), { wrapper: Wrapper });
    await deleteResult.current.mutateAsync('c1');
    await waitFor(() => expect(spy).toHaveBeenCalled());
    keys = spy.mock.calls.map((c) => c[0]?.queryKey);
    expect(keys).toContainEqual(['chambers']);
  });

  it('on Apply Logic, broadly invalidates schedule-runs/dashboard/gantt/capacity', async () => {
    vi.mocked(api.triggerApplyLogic).mockResolvedValue({
      schedule_run: {
        id: 'r1',
        version: 2,
        solver_type: 'greedy',
        status: 'completed',
        is_active: true,
        horizon_weeks: 78,
        current_week: 31,
        trigger_reason: 'manual_recalc',
        created_at: '2026-01-01T00:00:00Z',
      },
      project_count: 46,
      left_out_count: 8,
      within_year_count: 9,
      spillover_count: 10,
    });
    const { client, Wrapper } = makeWrapper();
    const spy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useApplyLogic(), { wrapper: Wrapper });
    await result.current.mutateAsync();
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const keys = spy.mock.calls.map((c) => c[0]?.queryKey);
    expect(keys).toContainEqual(['schedule-runs']);
    expect(keys).toContainEqual(['dashboard']);
    expect(keys).toContainEqual(['gantt']);
    expect(keys).toContainEqual(['capacity']);
  });
});

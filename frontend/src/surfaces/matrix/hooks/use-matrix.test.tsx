import { describe, expect, it, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import * as React from 'react';

vi.mock('../api/matrix-api', () => ({
  fetchPriorityMatrix: vi.fn(),
  fetchPrioritySummary: vi.fn(),
  updatePriorityScore: vi.fn(),
  applyScenario: vi.fn(),
  fetchScenarioVersions: vi.fn(),
  fetchScenarioVersionDetail: vi.fn(),
}));
vi.mock('@/lib/api/reference', () => ({ useCurrencyRates: vi.fn() }));

import * as api from '../api/matrix-api';
import {
  usePriorityMatrix,
  useUpdatePriorityScore,
  useApplyScenario,
  useScenarioVersions,
  useScenarioVersionDetail,
} from './use-matrix';
import type { ScenarioApplyRequest } from '../api/types';

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, Wrapper };
}

beforeEach(() => vi.clearAllMocks());

describe('use-matrix', () => {
  it('passes the selected currency straight to the fetcher (no client conversion)', async () => {
    vi.mocked(api.fetchPriorityMatrix).mockResolvedValue([]);
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => usePriorityMatrix({ currency: 'INR' }), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(vi.mocked(api.fetchPriorityMatrix).mock.calls[0]?.[0]).toMatchObject({ currency: 'INR' });
  });

  it('re-fetches with the new currency when it changes', async () => {
    vi.mocked(api.fetchPriorityMatrix).mockResolvedValue([]);
    const { Wrapper } = makeWrapper();
    const { rerender } = renderHook(
      ({ c }: { c: 'EUR' | 'USD' }) => usePriorityMatrix({ currency: c }),
      { wrapper: Wrapper, initialProps: { c: 'EUR' } as { c: 'EUR' | 'USD' } },
    );
    await waitFor(() => expect(api.fetchPriorityMatrix).toHaveBeenCalledTimes(1));
    rerender({ c: 'USD' });
    await waitFor(() => expect(api.fetchPriorityMatrix).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.fetchPriorityMatrix).mock.calls[1]?.[0]).toMatchObject({ currency: 'USD' });
  });

  it('re-fetches when the hub filter changes (hubId is part of the query key)', async () => {
    vi.mocked(api.fetchPriorityMatrix).mockResolvedValue([]);
    const { Wrapper } = makeWrapper();
    const { rerender } = renderHook(
      ({ hubId }: { hubId: string | undefined }) => usePriorityMatrix({ currency: 'EUR', hubId }),
      { wrapper: Wrapper, initialProps: { hubId: undefined } as { hubId: string | undefined } },
    );
    await waitFor(() => expect(api.fetchPriorityMatrix).toHaveBeenCalledTimes(1));
    rerender({ hubId: 'hub-1' });
    await waitFor(() => expect(api.fetchPriorityMatrix).toHaveBeenCalledTimes(2));
    rerender({ hubId: 'hub-2' });
    await waitFor(() => expect(api.fetchPriorityMatrix).toHaveBeenCalledTimes(3));
    expect(vi.mocked(api.fetchPriorityMatrix).mock.calls[2]?.[0]).toMatchObject({ hubId: 'hub-2' });
  });

  it('on a successful edit, invalidates the priority-matrix keys but NOT schedule-runs / capacity', async () => {
    vi.mocked(api.updatePriorityScore).mockResolvedValue({} as never);
    const { client, Wrapper } = makeWrapper();
    const spy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useUpdatePriorityScore(), { wrapper: Wrapper });

    await result.current.mutateAsync({
      projectId: 'p1',
      body: {
        strategic_project: 3, new_customer: 3, new_options: 3, regulatory_compliance: 3,
        quality_improvements: 3, rm_savings: 3, total_rm_savings: 3, gross_margins: 3,
        profitability: 3, annual_volume: 3, three_year_volume: 3, new_models: 3,
        capex_investment: 3, hard_gates: [],
      },
    });

    await waitFor(() => expect(spy).toHaveBeenCalled());
    const invalidatedKeys = spy.mock.calls.map((c) => c[0]?.queryKey);
    expect(invalidatedKeys).toContainEqual(['priority-matrix']);
    for (const key of invalidatedKeys) {
      expect(key).not.toContainEqual('schedule-runs');
      expect(key).not.toContainEqual('capacity');
    }
  });

  it('applyScenario POSTs the diff verbatim and, on success, invalidates priority-matrix but NOT schedule-runs / capacity / gantt / dashboard', async () => {
    const response = {
      run: {
        id: 'r1', version: 4, applied_by_user_id: 'u1', notes: null,
        entity_types_touched: ['PRIORITY_SCORE'], change_count: 1, created_at: '2026-09-01T00:00:00Z',
      },
      updated_priority_scores: ['s1'],
      suggested_bands: { p1: 'P1' },
    };
    vi.mocked(api.applyScenario).mockResolvedValue(response as never);
    const { client, Wrapper } = makeWrapper();
    const spy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useApplyScenario(), { wrapper: Wrapper });

    const body: ScenarioApplyRequest = {
      notes: null,
      priority_scores: [
        {
          project_id: 'p1',
          strategic_project: 5, new_customer: 3, new_options: 3, regulatory_compliance: 3,
          quality_improvements: 3, rm_savings: 3, total_rm_savings: 3, gross_margins: 3,
          profitability: 3, annual_volume: 3, three_year_volume: 3, new_models: 3,
          capex_investment: 3, hard_gates: [],
        },
      ],
    };
    const returned = await result.current.mutateAsync(body);

    expect(api.applyScenario).toHaveBeenCalledWith(body);
    expect(returned).toEqual(response);
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const invalidatedKeys = spy.mock.calls.map((c) => c[0]?.queryKey);
    expect(invalidatedKeys).toContainEqual(['priority-matrix']);
    for (const key of invalidatedKeys) {
      expect(key).not.toContainEqual('schedule-runs');
      expect(key).not.toContainEqual('capacity');
      expect(key).not.toContainEqual('gantt');
      expect(key).not.toContainEqual('dashboard');
    }
  });

  describe('useScenarioVersions (P5-T03)', () => {
    it('fetches the version list when enabled (default)', async () => {
      vi.mocked(api.fetchScenarioVersions).mockResolvedValue([]);
      const { Wrapper } = makeWrapper();
      const { result } = renderHook(() => useScenarioVersions(), { wrapper: Wrapper });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(api.fetchScenarioVersions).toHaveBeenCalledTimes(1);
    });

    it('does not fetch when enabled: false (dialog closed)', () => {
      vi.mocked(api.fetchScenarioVersions).mockResolvedValue([]);
      const { Wrapper } = makeWrapper();
      renderHook(() => useScenarioVersions({ enabled: false }), { wrapper: Wrapper });
      expect(api.fetchScenarioVersions).not.toHaveBeenCalled();
    });
  });

  describe('useScenarioVersionDetail (P5-T03)', () => {
    it('fetches the given version', async () => {
      const detail = {
        id: 'r1', version: 4, applied_by_user_id: 'u1', notes: null,
        entity_types_touched: ['priority_score'], change_count: 1, created_at: '2026-09-01T00:00:00Z',
        changes: [],
      };
      vi.mocked(api.fetchScenarioVersionDetail).mockResolvedValue(detail as never);
      const { Wrapper } = makeWrapper();
      const { result } = renderHook(() => useScenarioVersionDetail(4), { wrapper: Wrapper });
      await waitFor(() => expect(result.current.isSuccess).toBe(true));
      expect(api.fetchScenarioVersionDetail).toHaveBeenCalledWith(4, expect.anything());
    });

    it('does not fetch when version is null (nothing selected)', () => {
      vi.mocked(api.fetchScenarioVersionDetail).mockResolvedValue({} as never);
      const { Wrapper } = makeWrapper();
      renderHook(() => useScenarioVersionDetail(null), { wrapper: Wrapper });
      expect(api.fetchScenarioVersionDetail).not.toHaveBeenCalled();
    });
  });
});

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import * as React from 'react';

vi.mock('../api/dashboard-api', () => ({
  fetchCompletingWithinYear: vi.fn(),
  fetchDashboardProjects: vi.fn(),
  fetchActiveScheduleRun: vi.fn(),
  fetchPipelineTotals: vi.fn(),
  fetchStatusOverview: vi.fn(),
  fetchHubTypePipeline: vi.fn(),
  fetchDashboardAnalytics: vi.fn(),
}));

import * as api from '../api/dashboard-api';
import {
  useCompletingWithinYear,
  useCrossFilterBreakdowns,
  useDashboardProjects,
  useActiveScheduleRun,
  usePipelineTotals,
} from './use-dashboard';
import { ApiError } from '@/lib/api/client';

let lastClient: QueryClient | null = null;
function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  lastClient = client;
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

beforeEach(() => vi.clearAllMocks());

describe('dashboard hooks', () => {
  it('useCompletingWithinYear surfaces the I9 endpoint payload verbatim', async () => {
    vi.mocked(api.fetchCompletingWithinYear).mockResolvedValue({
      has_active_schedule_run: true,
      schedule_run_version: 2,
      within_year_count: 9,
      spillover_count: 4,
      left_out_count: 2,
      blocked_count: 1,
      priority_delivery: [],
      rows: [],
    });
    const { result } = renderHook(() => useCompletingWithinYear(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.within_year_count).toBe(9);
    expect(result.current.data?.blocked_count).toBe(1);
  });

  it('useDashboardProjects forwards its params to the fetcher', async () => {
    vi.mocked(api.fetchDashboardProjects).mockResolvedValue({ total_count: 0, rows: [] });
    const { result } = renderHook(
      () => useDashboardProjects({ status_: 'In Queue', priority: 'P1' }),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(vi.mocked(api.fetchDashboardProjects).mock.calls[0]![0]).toEqual({
      status_: 'In Queue',
      priority: 'P1',
    });
  });

  it('does not retry a 403 (auth failures do not self-heal)', async () => {
    vi.mocked(api.fetchActiveScheduleRun).mockRejectedValue(new ApiError(403, 'nope'));
    const client = new QueryClient();
    const Wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useActiveScheduleRun(true), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(vi.mocked(api.fetchActiveScheduleRun)).toHaveBeenCalledTimes(1);
  });

  it('P31: the selection is in the query key, SORTED (press order never splits the cache)', async () => {
    vi.mocked(api.fetchPipelineTotals).mockResolvedValue({} as never);
    const { result } = renderHook(
      () => usePipelineTotals('h1', null, { categories: ['B', 'A+'], types: ['NM', 'CO'] }),
      { wrapper: wrapper() },
    );
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    const keys = lastClient!.getQueryCache().getAll().map((q) => q.queryKey);
    expect(keys).toContainEqual([
      'dashboard',
      'pipeline-totals',
      { hubId: 'h1', region: null },
      { category: ['A+', 'B'], type: ['CO', 'NM'] },
    ]);
  });

  it('P31 cross-filter: each donut is served WITHOUT its own dimension, with the other one', async () => {
    vi.mocked(api.fetchDashboardAnalytics).mockResolvedValue({} as never);
    vi.mocked(api.fetchPipelineTotals).mockResolvedValue({} as never);
    renderHook(() => useCrossFilterBreakdowns(null, 'Greece', { categories: ['A'], types: ['NM'] }), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(api.fetchDashboardAnalytics).toHaveBeenCalledTimes(2));
    const sels = vi.mocked(api.fetchDashboardAnalytics).mock.calls.map((c) => c[3]);
    expect(sels).toContainEqual({ categories: ['A'], types: [] });
    expect(sels).toContainEqual({ categories: [], types: ['NM'] });
    expect(vi.mocked(api.fetchDashboardAnalytics).mock.calls.every((c) => c[1] === null && c[2] === 'Greece')).toBe(true);
    await waitFor(() => expect(api.fetchPipelineTotals).toHaveBeenCalledTimes(2));
  });

  it('useDashboardProjects keys category / type as sorted lists', async () => {
    vi.mocked(api.fetchDashboardProjects).mockResolvedValue({ total_count: 0, rows: [] });
    const { result } = renderHook(() => useDashboardProjects({ category: ['C', 'A'], type: ['RC', 'NM'] }), {
      wrapper: wrapper(),
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    // The request keeps the given (canonical) order; the key is sorted.
    expect(vi.mocked(api.fetchDashboardProjects).mock.calls[0]![0]).toEqual({ category: ['C', 'A'], type: ['RC', 'NM'] });
    const key = lastClient!.getQueryCache().getAll()[0]!.queryKey;
    expect(key).toEqual(['dashboard', 'projects', { category: ['A', 'C'], type: ['NM', 'RC'] }]);
  });
});

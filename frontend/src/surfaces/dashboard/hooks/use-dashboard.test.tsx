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
}));

import * as api from '../api/dashboard-api';
import { useCompletingWithinYear, useDashboardProjects, useActiveScheduleRun } from './use-dashboard';
import { ApiError } from '@/lib/api/client';

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
      rows: [],
    });
    const { result } = renderHook(() => useCompletingWithinYear(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.within_year_count).toBe(9);
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
});

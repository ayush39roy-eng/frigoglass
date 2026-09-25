import { describe, expect, it, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import * as React from 'react';

vi.mock('../api/capacity-api', () => ({
  fetchHubLoadVsCapacity: vi.fn(),
  fetchClassBreakdown: vi.fn(),
  fetchUtilizationMatrix: vi.fn(),
  fetchActiveScheduleRun: vi.fn(),
}));

import * as api from '../api/capacity-api';
import { useHubLoadVsCapacity, useUtilizationMatrix } from './use-capacity';
import { ApiError } from '@/lib/api/client';

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

beforeEach(() => vi.clearAllMocks());

describe('capacity hooks', () => {
  it('surfaces the hub-load payload verbatim (no client-side derivation)', async () => {
    vi.mocked(api.fetchHubLoadVsCapacity).mockResolvedValue({
      has_active_schedule_run: true,
      schedule_run_version: 5,
      remaining_weeks: 47,
      rows: [
        {
          hub: 'R&D-Greece',
          design_load_weeks: 120,
          design_capacity_weeks: 94.5,
          lab_load_units: 18.5,
          lab_capacity_units: 47,
        },
      ],
    });
    const { result } = renderHook(() => useHubLoadVsCapacity(), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data?.rows[0]?.design_load_weeks).toBe(120);
    expect(result.current.data?.rows[0]?.design_capacity_weeks).toBe(94.5);
  });

  it('does not retry a 403 (auth failures do not self-heal)', async () => {
    vi.mocked(api.fetchUtilizationMatrix).mockRejectedValue(new ApiError(403, 'nope'));
    const client = new QueryClient();
    const Wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useUtilizationMatrix(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(vi.mocked(api.fetchUtilizationMatrix)).toHaveBeenCalledTimes(1);
  });
});

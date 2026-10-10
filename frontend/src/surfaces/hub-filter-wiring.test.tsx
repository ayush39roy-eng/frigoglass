import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';

vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return { ...actual, apiGet: vi.fn() };
});

import { apiGet } from '@/lib/api/client';
import {
  useCompletingWithinYear,
  useDashboardProjects,
  useHubTypePipeline,
  usePipelineTotals,
  useStatusOverview,
} from '@/surfaces/dashboard/hooks/use-dashboard';
import { useClassBreakdown, useHubLoadVsCapacity, useUtilizationMatrix } from '@/surfaces/capacity/hooks/use-capacity';
import { usePriorityMatrix, usePrioritySummary } from '@/surfaces/matrix/hooks/use-matrix';
import { useGantt } from '@/surfaces/gantt/hooks/use-gantt';

/**
 * P12 (ADR 0020, API_CONTRACT_P12 §4/§7): every portfolio query carries the
 * global hub filter in its key AND sends it as `hub_id`; "All hubs" (null)
 * sends no `hub_id` and has its own cache entry.
 */

const mockApiGet = vi.mocked(apiGet);
const HUB = '11111111-1111-1111-1111-111111111111';

function setup<T>(hook: () => T) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  renderHook(hook, { wrapper });
  return client;
}

function keys(client: QueryClient): unknown[] {
  return client.getQueryCache().getAll().map((q) => q.queryKey);
}

function hubIdSent(path: string): unknown {
  const call = mockApiGet.mock.calls.find((c) => c[0] === path);
  const opts = call?.[1] as { query?: Record<string, unknown> } | undefined;
  return opts?.query?.hub_id;
}

beforeEach(() => {
  mockApiGet.mockReset();
  mockApiGet.mockResolvedValue({});
});

describe('hub filter wiring: query key + hub_id per surface', () => {
  it.each<[string, () => unknown, string, unknown[]]>([
    ['dashboard pipeline totals', () => usePipelineTotals(HUB), '/dashboard/pipeline-totals', ['dashboard', 'pipeline-totals', { hubId: HUB }]],
    ['dashboard status overview', () => useStatusOverview(HUB), '/dashboard/status-overview', ['dashboard', 'status-overview', { hubId: HUB }]],
    ['dashboard hub × type', () => useHubTypePipeline(HUB), '/dashboard/hub-type-pipeline', ['dashboard', 'hub-type-pipeline', { hubId: HUB }]],
    ['dashboard within year', () => useCompletingWithinYear(HUB), '/dashboard/completing-within-year', ['dashboard', 'completing-within-year', { hubId: HUB }]],
    ['dashboard / projects list', () => useDashboardProjects({ hub_id: HUB }), '/dashboard/projects', ['dashboard', 'projects', { hub_id: HUB, category: undefined, status_: undefined, priority: undefined }]],
    ['capacity hub load (+ dashboard booked card)', () => useHubLoadVsCapacity({ hubId: HUB }), '/capacity/hub-load', ['capacity', 'hub-load', { hubId: HUB }]],
    ['capacity class breakdown', () => useClassBreakdown(HUB), '/capacity/class-breakdown', ['capacity', 'class-breakdown', { hubId: HUB }]],
    ['capacity utilization', () => useUtilizationMatrix(HUB), '/capacity/utilization-matrix', ['capacity', 'utilization-matrix', { hubId: HUB }]],
    ['matrix summary', () => usePrioritySummary(HUB), '/priorities/summary', ['priority-matrix', 'summary', { hubId: HUB }]],
    ['matrix grid', () => usePriorityMatrix({ currency: 'EUR', hubId: HUB }), '/priorities', ['priority-matrix', { currency: 'EUR', hubId: HUB, category: undefined }]],
    ['gantt', () => useGantt({ hubId: HUB }), '/gantt', ['gantt', { hubId: HUB }]],
  ])('%s', async (_name, hook, path, key) => {
    const client = setup(hook);
    await waitFor(() => expect(mockApiGet).toHaveBeenCalled());
    expect(hubIdSent(path)).toBe(HUB);
    expect(keys(client)).toContainEqual(key);
  });

  it('"All hubs" sends no hub_id and is a distinct cache entry', async () => {
    const client = setup(() => {
      usePipelineTotals(null);
      useHubLoadVsCapacity({ hubId: null });
      return usePrioritySummary(null);
    });
    await waitFor(() => expect(mockApiGet).toHaveBeenCalledTimes(3));
    for (const call of mockApiGet.mock.calls) {
      expect((call[1] as { query?: unknown }).query).toBeUndefined();
    }
    expect(keys(client)).toEqual(
      expect.arrayContaining([
        ['dashboard', 'pipeline-totals', { hubId: null }],
        ['capacity', 'hub-load', { hubId: null }],
        ['priority-matrix', 'summary', { hubId: null }],
      ]),
    );
  });

  it('prefix invalidation still reaches every hub entry', async () => {
    const client = setup(() => useHubLoadVsCapacity({ hubId: HUB }));
    await waitFor(() => expect(mockApiGet).toHaveBeenCalled());
    const before = mockApiGet.mock.calls.length;
    await client.invalidateQueries({ queryKey: ['capacity', 'hub-load'] });
    expect(mockApiGet.mock.calls.length).toBeGreaterThan(before);
  });
});

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
  useProjectFacets,
  useRegionSummary,
  useStatusOverview,
} from '@/surfaces/dashboard/hooks/use-dashboard';
import { useClassBreakdown, useHubLoadVsCapacity, useUtilizationMatrix } from '@/surfaces/capacity/hooks/use-capacity';
import { usePriorityMatrix, usePrioritySummary } from '@/surfaces/matrix/hooks/use-matrix';
import { useGantt } from '@/surfaces/gantt/hooks/use-gantt';

/**
 * P12 (ADR 0020, API_CONTRACT_P12 §4/§7) + P13 (ADR 0025, API_CONTRACT_P13 §4):
 * every portfolio query carries the global hub AND country filter in its key
 * and sends them as `hub_id` / `region`; "All hubs" (both null) sends neither
 * and has its own cache entry.
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

function sent(path: string, param: string): unknown {
  const call = mockApiGet.mock.calls.find((c) => c[0] === path);
  const opts = call?.[1] as { query?: Record<string, unknown> } | undefined;
  return opts?.query?.[param];
}

function hubIdSent(path: string): unknown {
  return sent(path, 'hub_id');
}

beforeEach(() => {
  mockApiGet.mockReset();
  mockApiGet.mockResolvedValue({});
});

describe('hub filter wiring: query key + hub_id per surface', () => {
  it.each<[string, () => unknown, string, unknown[]]>([
    ['dashboard pipeline totals', () => usePipelineTotals(HUB), '/dashboard/pipeline-totals', ['dashboard', 'pipeline-totals', { hubId: HUB, region: null }]],
    ['dashboard status overview', () => useStatusOverview(HUB), '/dashboard/status-overview', ['dashboard', 'status-overview', { hubId: HUB, region: null }]],
    ['dashboard hub × type', () => useHubTypePipeline(HUB), '/dashboard/hub-type-pipeline', ['dashboard', 'hub-type-pipeline', { hubId: HUB, region: null }]],
    ['dashboard within year', () => useCompletingWithinYear(HUB), '/dashboard/completing-within-year', ['dashboard', 'completing-within-year', { hubId: HUB, region: null }]],
    ['dashboard / projects list', () => useDashboardProjects({ hub_id: HUB }), '/dashboard/projects', ['dashboard', 'projects', { hub_id: HUB, category: undefined, status_: undefined, priority: undefined }]],
    ['capacity hub load (+ dashboard booked card)', () => useHubLoadVsCapacity({ hubId: HUB }), '/capacity/hub-load', ['capacity', 'hub-load', { hubId: HUB, region: null }]],
    ['capacity class breakdown', () => useClassBreakdown(HUB), '/capacity/class-breakdown', ['capacity', 'class-breakdown', { hubId: HUB, region: null }]],
    ['capacity utilization', () => useUtilizationMatrix(HUB), '/capacity/utilization-matrix', ['capacity', 'utilization-matrix', { hubId: HUB, region: null }]],
    ['matrix summary', () => usePrioritySummary(HUB), '/priorities/summary', ['priority-matrix', 'summary', { hubId: HUB, region: null }]],
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
        ['dashboard', 'pipeline-totals', { hubId: null, region: null }],
        ['capacity', 'hub-load', { hubId: null, region: null }],
        ['priority-matrix', 'summary', { hubId: null, region: null }],
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

describe('country filter wiring (P13, ADR 0025): region in the key and the request', () => {
  it.each<[string, () => unknown, string, unknown[]]>([
    ['dashboard pipeline totals', () => usePipelineTotals(null, 'India'), '/dashboard/pipeline-totals', ['dashboard', 'pipeline-totals', { hubId: null, region: 'India' }]],
    ['dashboard status overview', () => useStatusOverview(null, 'India'), '/dashboard/status-overview', ['dashboard', 'status-overview', { hubId: null, region: 'India' }]],
    ['dashboard hub × type', () => useHubTypePipeline(null, 'India'), '/dashboard/hub-type-pipeline', ['dashboard', 'hub-type-pipeline', { hubId: null, region: 'India' }]],
    ['dashboard within year', () => useCompletingWithinYear(null, 'India'), '/dashboard/completing-within-year', ['dashboard', 'completing-within-year', { hubId: null, region: 'India' }]],
    ['dashboard region summary', () => useRegionSummary(null, 'India'), '/dashboard/region-summary', ['dashboard', 'region-summary', { hubId: null, region: 'India' }]],
    ['dashboard register facets', () => useProjectFacets(null, 'India'), '/dashboard/projects/facets', ['dashboard', 'projects-facets', { hubId: null, region: 'India' }]],
    ['dashboard / projects list', () => useDashboardProjects({ region: 'India' }), '/dashboard/projects', ['dashboard', 'projects', { hub_id: undefined, category: undefined, status_: undefined, priority: undefined, region: 'India' }]],
    ['capacity hub load', () => useHubLoadVsCapacity({ region: 'India' }), '/capacity/hub-load', ['capacity', 'hub-load', { hubId: null, region: 'India' }]],
    ['capacity class breakdown', () => useClassBreakdown(null, 'India'), '/capacity/class-breakdown', ['capacity', 'class-breakdown', { hubId: null, region: 'India' }]],
    ['capacity utilization', () => useUtilizationMatrix(null, 'India'), '/capacity/utilization-matrix', ['capacity', 'utilization-matrix', { hubId: null, region: 'India' }]],
    ['matrix summary', () => usePrioritySummary(null, 'India'), '/priorities/summary', ['priority-matrix', 'summary', { hubId: null, region: 'India' }]],
    ['matrix grid', () => usePriorityMatrix({ currency: 'EUR', region: 'India' }), '/priorities', ['priority-matrix', { currency: 'EUR', hubId: undefined, region: 'India', category: undefined }]],
    ['gantt', () => useGantt({ region: 'India' }), '/gantt', ['gantt', { hubId: undefined, region: 'India' }]],
  ])('%s', async (_name, hook, path, key) => {
    const client = setup(hook);
    await waitFor(() => expect(mockApiGet).toHaveBeenCalled());
    expect(sent(path, 'region')).toBe('India');
    expect(sent(path, 'hub_id')).toBeUndefined();
    expect(keys(client)).toContainEqual(key);
  });

  it('a country and "All hubs" are distinct cache entries', async () => {
    const client = setup(() => {
      usePipelineTotals(null, null);
      return usePipelineTotals(null, 'Greece');
    });
    await waitFor(() => expect(mockApiGet).toHaveBeenCalledTimes(2));
    expect(keys(client)).toEqual(
      expect.arrayContaining([
        ['dashboard', 'pipeline-totals', { hubId: null, region: null }],
        ['dashboard', 'pipeline-totals', { hubId: null, region: 'Greece' }],
      ]),
    );
  });
});

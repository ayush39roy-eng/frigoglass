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
import { useClassBreakdown, useHubLoadVsCapacity } from '@/surfaces/capacity/hooks/use-capacity';
import { usePriorityMatrix, usePrioritySummary } from '@/surfaces/matrix/hooks/use-matrix';
import { useGantt } from '@/surfaces/gantt/hooks/use-gantt';

/**
 * P12 (ADR 0020, API_CONTRACT_P12 §4/§7) + P13 (ADR 0025, API_CONTRACT_P13 §4),
 * multi-select (docs/API_CONTRACT_MULTISELECT.md §2–§3): every portfolio query
 * carries the global hub AND country selection in its key (SORTED lists) and
 * sends them as repeated `hub_id` / `region` params; "All hubs" (both empty)
 * sends neither and has its own cache entry. The Matrix is not converted in
 * this pass and still sends single values.
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

const one = { hubIds: [HUB], regions: [] };
const india = { hubIds: [], regions: ['India' as const] };
const none = { hubIds: [], regions: [] };

describe('hub filter wiring: query key + hub_id per surface', () => {
  it.each<[string, () => unknown, string, unknown, unknown[]]>([
    ['dashboard pipeline totals', () => usePipelineTotals(one), '/dashboard/pipeline-totals', [HUB], ['dashboard', 'pipeline-totals', { hubIds: [HUB], regions: [] }]],
    ['dashboard status overview', () => useStatusOverview(one), '/dashboard/status-overview', [HUB], ['dashboard', 'status-overview', { hubIds: [HUB], regions: [] }]],
    ['dashboard hub × type', () => useHubTypePipeline(one), '/dashboard/hub-type-pipeline', [HUB], ['dashboard', 'hub-type-pipeline', { hubIds: [HUB], regions: [] }]],
    ['dashboard within year', () => useCompletingWithinYear(one), '/dashboard/completing-within-year', [HUB], ['dashboard', 'completing-within-year', { hubIds: [HUB], regions: [] }]],
    ['dashboard / projects list', () => useDashboardProjects({ hub_id: [HUB] }), '/dashboard/projects', [HUB], ['dashboard', 'projects', { hub_id: [HUB], category: undefined, status_: undefined, priority: undefined }]],
    ['capacity hub load (+ dashboard booked card)', () => useHubLoadVsCapacity({ hub: one }), '/capacity/hub-load', [HUB], ['capacity', 'hub-load', { hubIds: [HUB], regions: [] }]],
    ['capacity class breakdown', () => useClassBreakdown(one), '/capacity/class-breakdown', [HUB], ['capacity', 'class-breakdown', { hubIds: [HUB], regions: [] }]],
    ['matrix summary (legacy single value)', () => usePrioritySummary(HUB), '/priorities/summary', HUB, ['priority-matrix', 'summary', { hubIds: [HUB], regions: [] }]],
    ['matrix grid (legacy single value)', () => usePriorityMatrix({ currency: 'EUR', hubId: HUB }), '/priorities', HUB, ['priority-matrix', { currency: 'EUR', hubId: HUB, category: undefined }]],
    ['gantt', () => useGantt({ hubIds: [HUB] }), '/gantt', [HUB], ['gantt', { hubIds: [HUB] }]],
  ])('%s', async (_name, hook, path, sentValue, key) => {
    const client = setup(hook);
    await waitFor(() => expect(mockApiGet).toHaveBeenCalled());
    expect(hubIdSent(path)).toEqual(sentValue);
    expect(keys(client)).toContainEqual(key);
  });

  it('"All hubs" sends no hub_id and is a distinct cache entry', async () => {
    const client = setup(() => {
      usePipelineTotals(none);
      useHubLoadVsCapacity({ hub: none });
      return usePrioritySummary(null);
    });
    await waitFor(() => expect(mockApiGet).toHaveBeenCalledTimes(3));
    for (const call of mockApiGet.mock.calls) {
      expect((call[1] as { query?: unknown }).query).toBeUndefined();
    }
    expect(keys(client)).toEqual(
      expect.arrayContaining([
        ['dashboard', 'pipeline-totals', { hubIds: [], regions: [] }],
        ['capacity', 'hub-load', { hubIds: [], regions: [] }],
        ['priority-matrix', 'summary', { hubIds: [], regions: [] }],
      ]),
    );
  });

  it('prefix invalidation still reaches every hub entry', async () => {
    const client = setup(() => useHubLoadVsCapacity({ hub: one }));
    await waitFor(() => expect(mockApiGet).toHaveBeenCalled());
    const before = mockApiGet.mock.calls.length;
    await client.invalidateQueries({ queryKey: ['capacity', 'hub-load'] });
    expect(mockApiGet.mock.calls.length).toBeGreaterThan(before);
  });
});

describe('country filter wiring (P13, ADR 0025): region in the key and the request', () => {
  it.each<[string, () => unknown, string, unknown, unknown[]]>([
    ['dashboard pipeline totals', () => usePipelineTotals(india), '/dashboard/pipeline-totals', ['India'], ['dashboard', 'pipeline-totals', { hubIds: [], regions: ['India'] }]],
    ['dashboard status overview', () => useStatusOverview(india), '/dashboard/status-overview', ['India'], ['dashboard', 'status-overview', { hubIds: [], regions: ['India'] }]],
    ['dashboard hub × type', () => useHubTypePipeline(india), '/dashboard/hub-type-pipeline', ['India'], ['dashboard', 'hub-type-pipeline', { hubIds: [], regions: ['India'] }]],
    ['dashboard within year', () => useCompletingWithinYear(india), '/dashboard/completing-within-year', ['India'], ['dashboard', 'completing-within-year', { hubIds: [], regions: ['India'] }]],
    ['dashboard region summary', () => useRegionSummary(india), '/dashboard/region-summary', ['India'], ['dashboard', 'region-summary', { hubIds: [], regions: ['India'] }]],
    ['dashboard register facets', () => useProjectFacets(india), '/dashboard/projects/facets', ['India'], ['dashboard', 'projects-facets', { hubIds: [], regions: ['India'] }]],
    ['dashboard / projects list', () => useDashboardProjects({ region: ['India'] }), '/dashboard/projects', ['India'], ['dashboard', 'projects', { hub_id: undefined, category: undefined, status_: undefined, priority: undefined, region: ['India'] }]],
    ['capacity hub load', () => useHubLoadVsCapacity({ hub: india }), '/capacity/hub-load', ['India'], ['capacity', 'hub-load', { hubIds: [], regions: ['India'] }]],
    ['capacity class breakdown', () => useClassBreakdown(india), '/capacity/class-breakdown', ['India'], ['capacity', 'class-breakdown', { hubIds: [], regions: ['India'] }]],
    ['matrix summary (legacy)', () => usePrioritySummary(null, 'India'), '/priorities/summary', 'India', ['priority-matrix', 'summary', { hubIds: [], regions: ['India'] }]],
    ['matrix grid (legacy)', () => usePriorityMatrix({ currency: 'EUR', region: 'India' }), '/priorities', 'India', ['priority-matrix', { currency: 'EUR', hubId: undefined, region: 'India', category: undefined }]],
    ['gantt', () => useGantt({ regions: ['India'] }), '/gantt', ['India'], ['gantt', { hubIds: undefined, regions: ['India'] }]],
  ])('%s', async (_name, hook, path, sentValue, key) => {
    const client = setup(hook);
    await waitFor(() => expect(mockApiGet).toHaveBeenCalled());
    expect(sent(path, 'region')).toEqual(sentValue);
    expect(sent(path, 'hub_id')).toBeUndefined();
    expect(keys(client)).toContainEqual(key);
  });

  it('a country and "All hubs" are distinct cache entries', async () => {
    const client = setup(() => {
      usePipelineTotals(none);
      return usePipelineTotals({ hubIds: [], regions: ['Greece'] });
    });
    await waitFor(() => expect(mockApiGet).toHaveBeenCalledTimes(2));
    expect(keys(client)).toEqual(
      expect.arrayContaining([
        ['dashboard', 'pipeline-totals', { hubIds: [], regions: [] }],
        ['dashboard', 'pipeline-totals', { hubIds: [], regions: ['Greece'] }],
      ]),
    );
  });
});

describe('multi-select wiring (contract §2): hubs AND countries together, repeated + sorted', () => {
  it('sends both lists as repeated params and keys them sorted (pick order never splits the cache)', async () => {
    const client = setup(() => {
      usePipelineTotals({ hubIds: ['h-b', 'h-a'], regions: ['Romania', 'India'] });
      return usePipelineTotals({ hubIds: ['h-a', 'h-b'], regions: ['India', 'Romania'] });
    });
    await waitFor(() => expect(mockApiGet).toHaveBeenCalled());
    expect(sent('/dashboard/pipeline-totals', 'hub_id')).toEqual(['h-a', 'h-b']);
    expect(sent('/dashboard/pipeline-totals', 'region')).toEqual(['India', 'Romania']);
    const totals = keys(client).filter((k) => (k as unknown[])[1] === 'pipeline-totals');
    expect(totals).toEqual([['dashboard', 'pipeline-totals', { hubIds: ['h-a', 'h-b'], regions: ['India', 'Romania'] }]]);
  });
});

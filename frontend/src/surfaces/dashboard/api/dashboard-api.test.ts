import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return { ...actual, apiGet: vi.fn() };
});

import { ApiError, apiGet } from '@/lib/api/client';
import {
  fetchActiveScheduleRun,
  fetchCompletingWithinYear,
  fetchDashboardAnalytics,
  fetchDashboardProjects,
  fetchHubTypePipeline,
  fetchPipelineTotals,
  fetchProjectFacets,
  fetchRegionSummary,
  fetchStatusOverview,
} from './dashboard-api';

const mockApiGet = vi.mocked(apiGet);

afterEach(() => {
  vi.clearAllMocks();
});

describe('dashboard-api', () => {
  it('requests the I9 endpoint verbatim', async () => {
    mockApiGet.mockResolvedValueOnce({
      has_active_schedule_run: false,
      schedule_run_version: null,
      within_year_count: 0,
      spillover_count: 0,
      left_out_count: 0,
      blocked_count: 0,
      priority_delivery: [],
      rows: [],
    });
    await fetchCompletingWithinYear();
    expect(mockApiGet).toHaveBeenCalledWith('/dashboard/completing-within-year', {});
  });

  it('forwards filters using the backend param names (status_ trailing underscore)', async () => {
    mockApiGet.mockResolvedValueOnce({ total_count: 0, rows: [] });
    await fetchDashboardProjects({ status_: 'In Queue', category: ['A+'] });
    expect(mockApiGet).toHaveBeenCalledWith('/dashboard/projects', {
      query: {
        hub_id: undefined,
        category: ['A+'],
        status_: 'In Queue',
        priority: undefined,
      },
    });
  });

  it('P31: every Dashboard aggregate sends the category / type selection as repeated params beside hub / region', async () => {
    const sel = { categories: ['A+', 'A'] as const, types: ['NM'] as const };
    const cases: [string, () => Promise<unknown>][] = [
      ['/dashboard/pipeline-totals', () => fetchPipelineTotals({}, 'h1', null, sel)],
      ['/dashboard/status-overview', () => fetchStatusOverview({}, 'h1', null, sel)],
      ['/dashboard/hub-type-pipeline', () => fetchHubTypePipeline({}, 'h1', null, sel)],
      ['/dashboard/completing-within-year', () => fetchCompletingWithinYear({}, 'h1', null, sel)],
      ['/dashboard/region-summary', () => fetchRegionSummary({}, 'h1', null, sel)],
      ['/dashboard/analytics', () => fetchDashboardAnalytics({}, 'h1', null, sel)],
      ['/dashboard/projects/facets', () => fetchProjectFacets({}, 'h1', null, sel)],
    ];
    for (const [path, call] of cases) {
      mockApiGet.mockResolvedValueOnce({});
      await call();
      expect(mockApiGet).toHaveBeenLastCalledWith(path, {
        query: { hub_id: 'h1', region: undefined, category: ['A+', 'A'], type: ['NM'] },
      });
    }
    // Only a type selection: no category param at all (empty list = no filter).
    mockApiGet.mockResolvedValueOnce({});
    await fetchPipelineTotals({}, null, 'India', { categories: [], types: ['CO', 'Unmapped'] });
    expect(mockApiGet).toHaveBeenLastCalledWith('/dashboard/pipeline-totals', {
      query: { hub_id: undefined, region: 'India', category: undefined, type: ['CO', 'Unmapped'] },
    });
    // No selection and no hub: the request is unchanged from before P31.
    mockApiGet.mockResolvedValueOnce({});
    await fetchPipelineTotals({}, null, null, { categories: [], types: [] });
    expect(mockApiGet).toHaveBeenLastCalledWith('/dashboard/pipeline-totals', {});
  });

  it('treats a 404 from /schedule-runs/active as "no run yet", not an error', async () => {
    mockApiGet.mockRejectedValueOnce(new ApiError(404, 'not found'));
    await expect(fetchActiveScheduleRun()).resolves.toBeNull();
  });

  it('rethrows a non-404 error from /schedule-runs/active', async () => {
    mockApiGet.mockRejectedValueOnce(new ApiError(403, 'forbidden'));
    await expect(fetchActiveScheduleRun()).rejects.toBeInstanceOf(ApiError);
  });
});

describe('fetchDashboardAnalytics (P13-T10)', () => {
  it('sends no filter params for "All hubs"', async () => {
    mockApiGet.mockResolvedValueOnce({});
    await fetchDashboardAnalytics();
    expect(mockApiGet).toHaveBeenCalledWith('/dashboard/analytics', {});
  });

  it('forwards the global hub / country filter as hub_id / region', async () => {
    mockApiGet.mockResolvedValueOnce({});
    await fetchDashboardAnalytics({}, null, 'India');
    expect(mockApiGet).toHaveBeenCalledWith('/dashboard/analytics', {
      query: { hub_id: undefined, region: 'India' },
    });
  });
});

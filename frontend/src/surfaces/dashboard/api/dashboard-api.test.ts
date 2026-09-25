import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return { ...actual, apiGet: vi.fn() };
});

import { ApiError, apiGet } from '@/lib/api/client';
import {
  fetchActiveScheduleRun,
  fetchCompletingWithinYear,
  fetchDashboardProjects,
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
      rows: [],
    });
    await fetchCompletingWithinYear();
    expect(mockApiGet).toHaveBeenCalledWith('/dashboard/completing-within-year', {});
  });

  it('forwards filters using the backend param names (status_ trailing underscore)', async () => {
    mockApiGet.mockResolvedValueOnce({ total_count: 0, rows: [] });
    await fetchDashboardProjects({ status_: 'In Queue', category: 'A+' });
    expect(mockApiGet).toHaveBeenCalledWith('/dashboard/projects', {
      query: {
        hub_id: undefined,
        category: 'A+',
        status_: 'In Queue',
        priority: undefined,
      },
    });
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

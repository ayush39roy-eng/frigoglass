import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return { ...actual, apiGet: vi.fn() };
});

import { ApiError, apiGet } from '@/lib/api/client';
import {
  fetchActiveScheduleRun,
  fetchClassBreakdown,
  fetchHubLoadVsCapacity,
  fetchUtilizationMatrix,
} from './capacity-api';

const mockApiGet = vi.mocked(apiGet);

afterEach(() => {
  vi.clearAllMocks();
});

describe('capacity-api', () => {
  it('requests the hub-load endpoint verbatim', async () => {
    mockApiGet.mockResolvedValueOnce({
      has_active_schedule_run: false,
      schedule_run_version: null,
      remaining_weeks: 47,
      rows: [],
    });
    await fetchHubLoadVsCapacity();
    expect(mockApiGet).toHaveBeenCalledWith('/capacity/hub-load', {});
  });

  it('requests the class-breakdown endpoint verbatim', async () => {
    mockApiGet.mockResolvedValueOnce({
      has_active_schedule_run: false,
      schedule_run_version: null,
      rows: [],
    });
    await fetchClassBreakdown();
    expect(mockApiGet).toHaveBeenCalledWith('/capacity/class-breakdown', {});
  });

  it('requests the utilization-matrix endpoint verbatim', async () => {
    mockApiGet.mockResolvedValueOnce({
      has_active_schedule_run: false,
      schedule_run_version: null,
      engineers: [],
      chambers: [],
    });
    await fetchUtilizationMatrix();
    expect(mockApiGet).toHaveBeenCalledWith('/capacity/utilization-matrix', {});
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

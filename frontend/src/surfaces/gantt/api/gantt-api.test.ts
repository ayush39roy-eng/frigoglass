import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api/client')>();
  return { ...actual, apiGet: vi.fn(), apiSend: vi.fn() };
});

import { apiGet, apiSend, ApiError } from '@/lib/api/client';
import { fetchActiveScheduleRun, fetchGantt, toggleFreeze } from './gantt-api';

afterEach(() => vi.clearAllMocks());

describe('fetchGantt', () => {
  it('GETs /gantt with the hub_id filter and the max page size (no client math)', async () => {
    vi.mocked(apiGet).mockResolvedValue({ has_active_schedule_run: true, rows: [] });
    await fetchGantt({ hubId: 'hub-7' });
    expect(apiGet).toHaveBeenCalledWith('/gantt', expect.objectContaining({
      query: { hub_id: 'hub-7', limit: 500 },
    }));
  });

  it('omits hub_id when no hub filter is set', async () => {
    vi.mocked(apiGet).mockResolvedValue({ has_active_schedule_run: true, rows: [] });
    await fetchGantt({});
    expect(vi.mocked(apiGet).mock.calls[0]?.[1]?.query).toEqual({ hub_id: undefined, limit: 500 });
  });
});

describe('toggleFreeze', () => {
  it('POSTs the freeze body verbatim to the project freeze endpoint', async () => {
    vi.mocked(apiSend).mockResolvedValue({ id: 'p1', frozen: true, actual_start_week: 12 });
    await toggleFreeze('p1', { frozen: true, actual_start_week: 12 });
    expect(apiSend).toHaveBeenCalledWith('POST', '/gantt/projects/p1/freeze', {
      frozen: true,
      actual_start_week: 12,
    });
  });
});

describe('fetchActiveScheduleRun', () => {
  it('returns null on a 404 (no schedule computed yet is a normal state)', async () => {
    vi.mocked(apiGet).mockRejectedValue(new ApiError(404, 'not found'));
    await expect(fetchActiveScheduleRun()).resolves.toBeNull();
  });

  it('rethrows a non-404 error', async () => {
    vi.mocked(apiGet).mockRejectedValue(new ApiError(403, 'forbidden'));
    await expect(fetchActiveScheduleRun()).rejects.toBeInstanceOf(ApiError);
  });
});

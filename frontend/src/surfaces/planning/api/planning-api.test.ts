import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return { ...actual, apiGet: vi.fn(), apiSend: vi.fn() };
});

import { ApiError, apiGet, apiSend } from '@/lib/api/client';
import {
  createChamber,
  createEngineer,
  deleteChamber,
  deleteEngineer,
  fetchActiveScheduleRun,
  fetchChambers,
  fetchEngineers,
  triggerApplyLogic,
  updateChamber,
  updateEngineer,
} from './planning-api';

const mockApiGet = vi.mocked(apiGet);
const mockApiSend = vi.mocked(apiSend);

afterEach(() => {
  vi.clearAllMocks();
});

describe('planning-api', () => {
  it('requests /engineers with the hub_id query param', async () => {
    mockApiGet.mockResolvedValueOnce([]);
    await fetchEngineers('hub-1');
    expect(mockApiGet).toHaveBeenCalledWith('/engineers', { query: { hub_id: 'hub-1' } });
  });

  it('requests /engineers with no hub_id when unfiltered', async () => {
    mockApiGet.mockResolvedValueOnce([]);
    await fetchEngineers(undefined);
    expect(mockApiGet).toHaveBeenCalledWith('/engineers', { query: { hub_id: undefined } });
  });

  it('POSTs a new engineer verbatim', async () => {
    mockApiSend.mockResolvedValueOnce({ id: 'e1' });
    const body = { name: 'Ada', hub_id: 'hub-1', fte: 1.0, allowed_categories: [] };
    await createEngineer(body);
    expect(mockApiSend).toHaveBeenCalledWith('POST', '/engineers', body);
  });

  it('PATCHes an engineer verbatim', async () => {
    mockApiSend.mockResolvedValueOnce({ id: 'e1' });
    await updateEngineer('e1', { fte: 0.5 });
    expect(mockApiSend).toHaveBeenCalledWith('PATCH', '/engineers/e1', { fte: 0.5 });
  });

  it('DELETEs an engineer', async () => {
    mockApiSend.mockResolvedValueOnce(undefined);
    await deleteEngineer('e1');
    expect(mockApiSend).toHaveBeenCalledWith('DELETE', '/engineers/e1');
  });

  it('requests /chambers with no query params (server-side lab-region scoping only)', async () => {
    mockApiGet.mockResolvedValueOnce([]);
    await fetchChambers();
    expect(mockApiGet).toHaveBeenCalledWith('/chambers', {});
  });

  it('POSTs a new chamber verbatim', async () => {
    mockApiSend.mockResolvedValueOnce({ id: 'c1' });
    const body = { code: 'GR-CH1', lab_region: 'Greece' as const, max_concurrent: 2 };
    await createChamber(body);
    expect(mockApiSend).toHaveBeenCalledWith('POST', '/chambers', body);
  });

  it('PATCHes a chamber verbatim', async () => {
    mockApiSend.mockResolvedValueOnce({ id: 'c1' });
    await updateChamber('c1', { max_concurrent: 3 });
    expect(mockApiSend).toHaveBeenCalledWith('PATCH', '/chambers/c1', { max_concurrent: 3 });
  });

  it('DELETEs a chamber', async () => {
    mockApiSend.mockResolvedValueOnce(undefined);
    await deleteChamber('c1');
    expect(mockApiSend).toHaveBeenCalledWith('DELETE', '/chambers/c1');
  });

  it('treats a 404 from /schedule-runs/active as "no run yet", not an error', async () => {
    mockApiGet.mockRejectedValueOnce(new ApiError(404, 'not found'));
    await expect(fetchActiveScheduleRun()).resolves.toBeNull();
  });

  it('rethrows a non-404 error from /schedule-runs/active', async () => {
    mockApiGet.mockRejectedValueOnce(new ApiError(403, 'forbidden'));
    await expect(fetchActiveScheduleRun()).rejects.toBeInstanceOf(ApiError);
  });

  it('POSTs the greedy-recalc trigger with no body', async () => {
    mockApiSend.mockResolvedValueOnce({
      schedule_run: {
        id: 'r1',
        version: 1,
        solver_type: 'greedy',
        status: 'completed',
        is_active: true,
        horizon_weeks: 78,
        current_week: 31,
        trigger_reason: 'manual_recalc',
        created_at: '2026-01-01T00:00:00Z',
      },
      project_count: 46,
      left_out_count: 8,
      within_year_count: 9,
      spillover_count: 10,
    });
    await triggerApplyLogic();
    expect(mockApiSend).toHaveBeenCalledWith('POST', '/schedule-runs/greedy-recalc');
  });
});

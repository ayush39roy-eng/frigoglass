import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return { ...actual, apiGet: vi.fn() };
});

import { apiGet } from '@/lib/api/client';
import { fetchAuditLog } from './audit-log-api';

const mockApiGet = vi.mocked(apiGet);

afterEach(() => {
  vi.clearAllMocks();
});

describe('fetchAuditLog', () => {
  it('requests GET /audit-log verbatim with every filter forwarded by name', async () => {
    mockApiGet.mockResolvedValueOnce({ items: [], total_count: 0, limit: 50, offset: 0 });
    await fetchAuditLog({
      entity_type: 'Project',
      entity_id: 'p-1',
      actor_user_id: 'u-1',
      action: 'project.update',
      hub_id: 'h-1',
      occurred_from: '2026-01-01T00:00:00.000Z',
      occurred_to: '2026-01-31T23:59:59.999Z',
      limit: 50,
      offset: 0,
    });
    expect(mockApiGet).toHaveBeenCalledWith('/audit-log', {
      query: {
        entity_type: 'Project',
        entity_id: 'p-1',
        actor_user_id: 'u-1',
        action: 'project.update',
        hub_id: 'h-1',
        occurred_from: '2026-01-01T00:00:00.000Z',
        occurred_to: '2026-01-31T23:59:59.999Z',
        limit: 50,
        offset: 0,
      },
    });
  });

  it('sends undefined for an omitted filter rather than a placeholder value', async () => {
    mockApiGet.mockResolvedValueOnce({ items: [], total_count: 0, limit: 50, offset: 0 });
    await fetchAuditLog({});
    expect(mockApiGet).toHaveBeenCalledWith('/audit-log', {
      query: {
        entity_type: undefined,
        entity_id: undefined,
        actor_user_id: undefined,
        action: undefined,
        hub_id: undefined,
        occurred_from: undefined,
        occurred_to: undefined,
        limit: undefined,
        offset: undefined,
      },
    });
  });
});

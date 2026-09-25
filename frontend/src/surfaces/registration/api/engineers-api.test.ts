import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return { ...actual, apiGet: vi.fn() };
});

import { apiGet } from '@/lib/api/client';
import { fetchEngineerOptions } from './engineers-api';

const mockApiGet = vi.mocked(apiGet);

afterEach(() => vi.clearAllMocks());

describe('engineers-api', () => {
  it('requests /engineers filtered by hub_id when a hub is given', async () => {
    mockApiGet.mockResolvedValueOnce([]);
    await fetchEngineerOptions('hub-1');
    expect(mockApiGet).toHaveBeenCalledWith('/engineers', { query: { hub_id: 'hub-1' } });
  });

  it('omits hub_id when no hub is given (unfiltered — server hub-scopes anyway)', async () => {
    mockApiGet.mockResolvedValueOnce([]);
    await fetchEngineerOptions(undefined);
    expect(mockApiGet).toHaveBeenCalledWith('/engineers', { query: { hub_id: undefined } });
  });
});

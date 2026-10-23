import * as React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';

vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return { ...actual, apiGet: vi.fn() };
});

import { apiGet } from '@/lib/api/client';

import { isEmptyBoardFilters, usePriorityBoard } from './api';

afterEach(() => vi.clearAllMocks());

describe('Priority board API (P31 multi-select)', () => {
  it('an empty list is "no filter"', () => {
    expect(isEmptyBoardFilters({ category: [], type: [], q: undefined })).toBe(true);
    expect(isEmptyBoardFilters({ category: ['A'] })).toBe(false);
  });

  it('sends repeated params and keys them SORTED (OR within a param: order is irrelevant)', async () => {
    vi.mocked(apiGet).mockResolvedValue({ run_id: null, columns: [] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => usePriorityBoard('h1', null, { category: ['C', 'A+'], type: ['RC', 'NM'] }), {
      wrapper,
    });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiGet).toHaveBeenCalledWith(
      '/priority-board',
      expect.objectContaining({ query: expect.objectContaining({ category: ['A+', 'C'], type: ['NM', 'RC'] }) }),
    );
    expect(client.getQueryCache().getAll()[0]!.queryKey).toEqual([
      'priority-board',
      'h1',
      null,
      { category: ['A+', 'C'], type: ['NM', 'RC'] },
    ]);
  });
});

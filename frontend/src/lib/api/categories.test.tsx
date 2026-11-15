import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';

import { getCategoryCatalog } from '@/lib/category-catalog';
import { WITH_B2_TEST_CATEGORIES } from '@/test/category-fixtures';

// The real module (setup.ts mocks it for every other test).
vi.unmock('@/lib/api/categories');

const apiGet = vi.fn();
vi.mock('./client', async (orig) => ({ ...(await orig<typeof import('./client')>()), apiGet: (...a: unknown[]) => apiGet(...a) }));

import { useCategories, useCategoryCodes } from './categories';

function wrapper({ children }: { children: React.ReactNode }): React.JSX.Element {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe('useCategories (P33 B1)', () => {
  it('fetches GET /reference/categories without hub_id, keeps rank order and mirrors the list', async () => {
    apiGet.mockResolvedValue([...WITH_B2_TEST_CATEGORIES].reverse());
    const { result } = renderHook(() => ({ all: useCategories(), codes: useCategoryCodes() }), { wrapper });
    await waitFor(() => expect(result.current.all.isPending).toBe(false));
    expect(apiGet).toHaveBeenCalledWith('/reference/categories', expect.objectContaining({ query: undefined }));
    expect(result.current.all.catalog.codes).toEqual(['A+', 'A', 'B', 'B2', 'C', 'A-OEM', 'B-OEM', 'C-OEM']);
    expect(result.current.codes).toEqual(result.current.all.catalog.codes);
    expect(getCategoryCatalog().has('B2')).toBe(true);
  });

  it('codes are null (keep URL values as written) when the list failed', async () => {
    apiGet.mockRejectedValue(new Error('down'));
    const { result } = renderHook(() => ({ all: useCategories(), codes: useCategoryCodes() }), { wrapper });
    await waitFor(() => expect(result.current.all.isError).toBe(true));
    expect(result.current.codes).toBeNull();
  });
});

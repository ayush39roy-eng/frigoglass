import { describe, expect, it, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, useLocation } from 'react-router-dom';
import * as React from 'react';

vi.mock('../api/registration-api', () => ({ fetchProject: vi.fn() }));

import { fetchProject } from '../api/registration-api';
import type { ProjectRead } from '../api/types';
import { registrationEditHref } from '@/lib/registration-links';
import { useEditDeepLink } from './use-edit-deep-link';

/** P13 (ADR 0025 §5), P22-T01: the Dashboard register's Edit → `/projects?edit=<id>`. */

const ID = '3f2b8c1e-9a4d-4e6f-8b2a-1c0d9e8f7a65';

function wrapperAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
    </QueryClientProvider>
  );
}

beforeEach(() => {
  vi.mocked(fetchProject).mockReset();
});

describe('useEditDeepLink', () => {
  it('builds the edit href', () => {
    expect(registrationEditHref('p 1')).toBe('/projects?edit=p%201');
  });

  it('opens the edit form for ?edit=<id> once loaded, then drops the param', async () => {
    const project = { id: ID, name: 'Cooler' } as ProjectRead;
    vi.mocked(fetchProject).mockResolvedValue(project);
    const open = vi.fn();
    const { result } = renderHook(
      () => {
        useEditDeepLink(true, open);
        return useLocation();
      },
      { wrapper: wrapperAt(`/projects?edit=${ID}`) },
    );
    await waitFor(() => expect(open).toHaveBeenCalledWith(project));
    expect(fetchProject).toHaveBeenCalledWith(ID, expect.anything());
    await waitFor(() => expect(result.current.search).toBe(''));
  });

  it('never fetches without Registration write, and still drops the param', async () => {
    const open = vi.fn();
    const { result } = renderHook(
      () => {
        useEditDeepLink(false, open);
        return useLocation();
      },
      { wrapper: wrapperAt(`/projects?edit=${ID}`) },
    );
    await waitFor(() => expect(result.current.search).toBe(''));
    expect(fetchProject).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });

  it.each(['p-1', '../me', `${ID}x`, ' '])('ignores a non-UUID ?edit=%j: never fetches, drops the param (P13-F11)', async (bad) => {
    const open = vi.fn();
    const { result } = renderHook(
      () => {
        useEditDeepLink(true, open);
        return useLocation();
      },
      { wrapper: wrapperAt(`/projects?edit=${encodeURIComponent(bad)}`) },
    );
    await waitFor(() => expect(result.current.search).toBe(''));
    expect(fetchProject).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();
  });
});

import * as React from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('./client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./client')>()),
  apiSend: vi.fn(),
}));

import { ApiError, apiSend } from './client';
import { useSetProjectVip } from './vip';

const send = vi.mocked(apiSend);
const LIST_KEY = ['priority-matrix', { currency: 'EUR' }];
const ROW_KEY = ['priority-matrix', 'row', 'p1'];
const DIST_KEY = ['priority-matrix', 'distribution', {}];

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  client.setQueryData(LIST_KEY, [
    { project_id: 'p1', project_name: 'Cooler A', is_vip: false },
    { project_id: 'p2', project_name: 'Cooler B', is_vip: true },
  ]);
  client.setQueryData(ROW_KEY, { project_id: 'p1', is_vip: false });
  client.setQueryData(DIST_KEY, { total_projects: 2 });
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useSetProjectVip(), { wrapper });
  return { client, result, invalidate };
}

const vipOf = (client: QueryClient, id: string) =>
  (client.getQueryData(LIST_KEY) as { project_id: string; is_vip: boolean }[]).find((r) => r.project_id === id)?.is_vip;

beforeEach(() => {
  send.mockReset();
});

describe('useSetProjectVip (P34-T02 VIP star fix)', () => {
  it('pins the cached Matrix rows at once, before the PUT answers, then re-reads every VIP reader', async () => {
    let resolve: (v: unknown) => void = () => undefined;
    send.mockReturnValue(new Promise((r) => (resolve = r)));
    const { client, result, invalidate } = setup();
    act(() => result.current.mutate({ projectId: 'p1', isVip: true }));
    await waitFor(() => expect(vipOf(client, 'p1')).toBe(true));
    expect(client.getQueryData(ROW_KEY)).toEqual({ project_id: 'p1', is_vip: true });
    // Non-row entries untouched; other rows untouched.
    expect(client.getQueryData(DIST_KEY)).toEqual({ total_projects: 2 });
    expect(vipOf(client, 'p2')).toBe(true);
    // P47 (ADR 0059): the pin starts from the opposite value.
    expect(send).toHaveBeenCalledWith('PUT', '/projects/p1/vip', { is_vip: true, base: { is_vip: false } });
    expect(invalidate).not.toHaveBeenCalled();

    await act(async () => {
      resolve({ project_id: 'p1', is_vip: true });
    });
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['priority-matrix'] }));
    for (const key of ['priority-board', 'vip-board', 'dashboard', 'gantt']) {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: [key] });
    }
  });

  it('rolls the pin back on a 403 and reports the error', async () => {
    const forbidden = new ApiError(403, 'forbidden');
    send.mockImplementation(() => Promise.reject(forbidden));
    const { client, result } = setup();
    act(() => result.current.mutate({ projectId: 'p1', isVip: true }));
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBe(forbidden);
    expect(vipOf(client, 'p1')).toBe(false);
    expect(client.getQueryData(ROW_KEY)).toEqual({ project_id: 'p1', is_vip: false });
  });
});

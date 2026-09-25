import { describe, expect, it, vi, beforeEach } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import * as React from 'react';

vi.mock('../api/registration-api', () => ({
  fetchProjects: vi.fn(),
  fetchHardGateStatus: vi.fn(),
  createProject: vi.fn(),
  updateProject: vi.fn(),
  submitProject: vi.fn(),
}));
vi.mock('../api/engineers-api', () => ({ fetchEngineerOptions: vi.fn() }));

import * as api from '../api/registration-api';
import * as engineersApi from '../api/engineers-api';
import {
  useCreateProject,
  useEngineerOptions,
  useHardGateStatus,
  useProjectList,
  useSubmitProject,
  useUpdateProject,
} from './use-registration';

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, Wrapper };
}

beforeEach(() => vi.clearAllMocks());

describe('use-registration', () => {
  it('re-fetches the project list when the hub filter changes (hubId is part of the query key)', async () => {
    vi.mocked(api.fetchProjects).mockResolvedValue([]);
    const { Wrapper } = makeWrapper();
    const { rerender } = renderHook(
      ({ hubId }: { hubId: string | undefined }) => useProjectList({ hubId }),
      { wrapper: Wrapper, initialProps: { hubId: undefined } as { hubId: string | undefined } },
    );
    await waitFor(() => expect(api.fetchProjects).toHaveBeenCalledTimes(1));
    rerender({ hubId: 'hub-1' });
    await waitFor(() => expect(api.fetchProjects).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.fetchProjects).mock.calls[1]?.[0]).toMatchObject({ hubId: 'hub-1' });
  });

  it('does not fetch hard-gate status when no project id is given', () => {
    const { Wrapper } = makeWrapper();
    renderHook(() => useHardGateStatus(null), { wrapper: Wrapper });
    expect(api.fetchHardGateStatus).not.toHaveBeenCalled();
  });

  it('fetches hard-gate status for a given project id', async () => {
    vi.mocked(api.fetchHardGateStatus).mockResolvedValue({
      can_leave_draft: false,
      missing_fields: ['category'],
    });
    const { Wrapper } = makeWrapper();
    const { result } = renderHook(() => useHardGateStatus('p1'), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(api.fetchHardGateStatus).toHaveBeenCalledWith('p1', expect.anything());
  });

  it('does not fetch engineer options until a hub is selected', () => {
    const { Wrapper } = makeWrapper();
    renderHook(() => useEngineerOptions(undefined), { wrapper: Wrapper });
    expect(engineersApi.fetchEngineerOptions).not.toHaveBeenCalled();
  });

  it('on create, invalidates the project list', async () => {
    vi.mocked(api.createProject).mockResolvedValue({ id: 'p1' } as never);
    const { client, Wrapper } = makeWrapper();
    const spy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useCreateProject(), { wrapper: Wrapper });
    await result.current.mutateAsync({ name: 'Cooler A', hub_id: 'hub-1' });
    await waitFor(() => expect(spy).toHaveBeenCalled());
    expect(spy.mock.calls.map((c) => c[0]?.queryKey)).toContainEqual(['projects']);
  });

  it('on update, invalidates the project list AND this project`s hard-gate status', async () => {
    vi.mocked(api.updateProject).mockResolvedValue({ id: 'p1' } as never);
    const { client, Wrapper } = makeWrapper();
    const spy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useUpdateProject(), { wrapper: Wrapper });
    await result.current.mutateAsync({ projectId: 'p1', body: { name: 'Cooler B' } });
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const keys = spy.mock.calls.map((c) => c[0]?.queryKey);
    expect(keys).toContainEqual(['projects']);
    expect(keys).toContainEqual(['projects', 'detail', 'p1', 'hard-gate-status']);
  });

  it('on submit, invalidates the list + hard-gate status but not schedule-runs / dashboard / gantt / capacity', async () => {
    vi.mocked(api.submitProject).mockResolvedValue({ id: 'p1' } as never);
    const { client, Wrapper } = makeWrapper();
    const spy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useSubmitProject(), { wrapper: Wrapper });
    await result.current.mutateAsync({ projectId: 'p1', body: { target_status: 'In Queue' } });
    await waitFor(() => expect(spy).toHaveBeenCalled());
    const keys = spy.mock.calls.map((c) => c[0]?.queryKey);
    expect(keys).toContainEqual(['projects']);
    for (const key of keys) {
      expect(key).not.toContainEqual('schedule-runs');
      expect(key).not.toContainEqual('dashboard');
      expect(key).not.toContainEqual('gantt');
      expect(key).not.toContainEqual('capacity');
    }
  });
});

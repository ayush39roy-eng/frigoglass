import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as React from 'react';

vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return { ...actual, apiGet: vi.fn() };
});

import { apiGet, ApiError } from '@/lib/api/client';

import { FOLLOW_UP_POLL_MS, FOLLOW_UP_TIMEOUT_MS, useFollowUpRunWatcher } from './use-follow-up-run';

const mockApiGet = vi.mocked(apiGet);

function setup() {
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const hook = renderHook(() => useFollowUpRunWatcher(), { wrapper });
  return { hook, invalidate };
}

function invalidatedRoots(spy: { mock: { calls: unknown[][] } }): unknown[] {
  return spy.mock.calls.map((c) => (c[0] as { queryKey: unknown[] }).queryKey[0]);
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  mockApiGet.mockReset();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('useFollowUpRunWatcher (ADR 0023)', () => {
  it('reads a baseline, then invalidates every active-run-backed query when the active run changes and stops on the follow-up', async () => {
    mockApiGet
      .mockResolvedValueOnce({ id: 'run-1', trigger_reason: 'manual' })
      .mockResolvedValueOnce({ id: 'run-1', trigger_reason: 'manual' })
      .mockResolvedValueOnce({ id: 'run-2', trigger_reason: 'follow_up' });
    const { hook, invalidate } = setup();

    act(() => hook.result.current.start());
    expect(hook.result.current.watching).toBe(true);
    await advance(0);
    expect(mockApiGet).toHaveBeenCalledWith('/schedule-runs/active', expect.anything());
    expect(invalidate).not.toHaveBeenCalled();

    await advance(FOLLOW_UP_POLL_MS); // same run: nothing
    expect(invalidate).not.toHaveBeenCalled();

    await advance(FOLLOW_UP_POLL_MS); // the follow-up landed
    const roots = invalidatedRoots(invalidate);
    for (const root of ['gantt', 'dashboard', 'capacity', 'schedule-runs', 'projects', 'priority-board', 'vip-projects', 'check-ins']) {
      expect(roots).toContain(root);
    }
    expect(hook.result.current.watching).toBe(false);

    const calls = mockApiGet.mock.calls.length;
    await advance(FOLLOW_UP_POLL_MS * 3);
    expect(mockApiGet.mock.calls.length).toBe(calls);
  });

  it('refreshes when the in-flight run activates and keeps watching for the follow-up', async () => {
    mockApiGet
      .mockResolvedValueOnce({ id: 'run-1', trigger_reason: 'manual' })
      .mockResolvedValueOnce({ id: 'run-2', trigger_reason: 'priority_move' })
      .mockResolvedValue({ id: 'run-2', trigger_reason: 'priority_move' });
    const { hook, invalidate } = setup();
    act(() => hook.result.current.start());
    await advance(0);
    await advance(FOLLOW_UP_POLL_MS);
    expect(invalidate).toHaveBeenCalled();
    expect(hook.result.current.watching).toBe(true);
  });

  it('treats a 404 as "no active run" and gives up after 3 minutes', async () => {
    mockApiGet.mockRejectedValue(new ApiError(404, 'none'));
    const { hook, invalidate } = setup();
    act(() => hook.result.current.start());
    await advance(0);
    await advance(FOLLOW_UP_TIMEOUT_MS + FOLLOW_UP_POLL_MS);
    expect(hook.result.current.watching).toBe(false);
    expect(invalidate).not.toHaveBeenCalled();
    const calls = mockApiGet.mock.calls.length;
    expect(calls).toBeGreaterThan(30);
    expect(calls).toBeLessThanOrEqual(FOLLOW_UP_TIMEOUT_MS / FOLLOW_UP_POLL_MS + 2);
  });

  it('keeps polling through a transient error', async () => {
    mockApiGet
      .mockResolvedValueOnce({ id: 'run-1', trigger_reason: null })
      .mockRejectedValueOnce(new ApiError(503, 'down'))
      .mockResolvedValueOnce({ id: 'run-3', trigger_reason: 'follow_up' });
    const { hook, invalidate } = setup();
    act(() => hook.result.current.start());
    await advance(0);
    await advance(FOLLOW_UP_POLL_MS);
    await advance(FOLLOW_UP_POLL_MS);
    expect(invalidate).toHaveBeenCalled();
    expect(hook.result.current.watching).toBe(false);
  });

  it('stops polling on unmount', async () => {
    mockApiGet.mockResolvedValue({ id: 'run-1', trigger_reason: null });
    const { hook } = setup();
    act(() => hook.result.current.start());
    await advance(0);
    hook.unmount();
    const calls = mockApiGet.mock.calls.length;
    await advance(FOLLOW_UP_POLL_MS * 4);
    expect(mockApiGet.mock.calls.length).toBe(calls);
  });
});

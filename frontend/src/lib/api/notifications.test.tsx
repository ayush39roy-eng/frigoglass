import { afterEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import * as React from 'react';

import {
  fetchNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotifications,
  type NotificationListResponse,
} from './notifications';

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function makeList(overrides: Partial<NotificationListResponse> = {}): NotificationListResponse {
  return {
    items: [],
    total_count: 0,
    unread_count: 0,
    limit: 20,
    offset: 0,
    ...overrides,
  };
}

function makeWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const Wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, Wrapper };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('fetchNotifications', () => {
  it('requests a fixed page (limit=20, offset=0) — no unread_only filter (the badge and the list share one response)', async () => {
    const fetchMock = vi.fn((_input: string | URL) => Promise.resolve(jsonResponse(makeList())));
    vi.stubGlobal('fetch', fetchMock);

    await fetchNotifications();

    const url = new URL(String(fetchMock.mock.calls[0]?.[0]));
    expect(url.pathname).toBe('/notifications');
    expect(url.searchParams.get('limit')).toBe('20');
    expect(url.searchParams.get('offset')).toBe('0');
    expect(url.searchParams.has('unread_only')).toBe(false);
  });
});

describe('markNotificationRead / markAllNotificationsRead', () => {
  it('POSTs to /notifications/{id}/read', async () => {
    const fetchMock = vi.fn((_input: string | URL, _init?: RequestInit) =>
      Promise.resolve(jsonResponse({ id: 'n1', read_at: '2026-09-04T10:00:00Z' })),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await markNotificationRead('n1');

    expect(result).toEqual({ id: 'n1', read_at: '2026-09-04T10:00:00Z' });
    const call = fetchMock.mock.calls[0];
    expect(String(call?.[0])).toContain('/notifications/n1/read');
    expect(call?.[1]?.method).toBe('POST');
  });

  it('POSTs to /notifications/read-all', async () => {
    const fetchMock = vi.fn((_input: string | URL, _init?: RequestInit) =>
      Promise.resolve(jsonResponse({ marked_count: 3 })),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await markAllNotificationsRead();

    expect(result).toEqual({ marked_count: 3 });
    const call = fetchMock.mock.calls[0];
    expect(String(call?.[0])).toContain('/notifications/read-all');
    expect(call?.[1]?.method).toBe('POST');
  });
});

describe('useNotifications', () => {
  it('fetches on mount and exposes items + unread_count from a single response', async () => {
    const list = makeList({
      items: [
        {
          id: 'n1',
          reason: 'delay_introduced',
          project_id: 'p1',
          hub_id: 'h1',
          message: 'Project X delayed to week 40',
          schedule_run_id: 'r2',
          previous_schedule_run_id: 'r1',
          read_at: null,
          created_at: '2026-09-04T09:00:00Z',
        },
      ],
      total_count: 1,
      unread_count: 1,
    });
    const fetchMock = vi.fn((_input: string | URL) => Promise.resolve(jsonResponse(list)));
    vi.stubGlobal('fetch', fetchMock);
    const { Wrapper } = makeWrapper();

    const { result } = renderHook(() => useNotifications(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.unread_count).toBe(1);
    expect(result.current.data?.items).toHaveLength(1);
  });

  it('polls again after the 60s interval elapses', async () => {
    const fetchMock = vi.fn((_input: string | URL) => Promise.resolve(jsonResponse(makeList())));
    vi.stubGlobal('fetch', fetchMock);
    // Fake timers from before mount — TanStack Query's own internal
    // `setTimeout` for `refetchInterval` must be created under fake time for
    // `advanceTimersByTimeAsync` to fast-forward it; switching to fake timers
    // after a real-timer-scheduled interval already exists does not retarget it.
    vi.useFakeTimers();
    const { Wrapper } = makeWrapper();

    renderHook(() => useNotifications(), { wrapper: Wrapper });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not retry a 401 (auth failures do not fix themselves on retry)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ detail: 'Unauthorized' }), {
            status: 401,
            headers: { 'content-type': 'application/json' },
          }),
        ),
      ),
    );
    // A real (retry-enabled) client here, not `makeWrapper`'s retry:false one —
    // this test exercises `retryUnlessAuth` itself, not just the query's happy path.
    const client = new QueryClient();
    const Wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );

    const { result } = renderHook(() => useNotifications(), { wrapper: Wrapper });
    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
  });
});

describe('useMarkNotificationRead', () => {
  it('invalidates the notifications query on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(jsonResponse({ id: 'n1', read_at: '2026-09-04T10:00:00Z' }))),
    );
    const { client, Wrapper } = makeWrapper();
    const spy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useMarkNotificationRead(), { wrapper: Wrapper });

    await result.current.mutateAsync('n1');

    await waitFor(() => expect(spy).toHaveBeenCalledWith({ queryKey: ['notifications'] }));
  });
});

describe('useMarkAllNotificationsRead', () => {
  it('invalidates the notifications query on success', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(jsonResponse({ marked_count: 2 }))));
    const { client, Wrapper } = makeWrapper();
    const spy = vi.spyOn(client, 'invalidateQueries');
    const { result } = renderHook(() => useMarkAllNotificationsRead(), { wrapper: Wrapper });

    await result.current.mutateAsync();

    await waitFor(() => expect(spy).toHaveBeenCalledWith({ queryKey: ['notifications'] }));
  });
});

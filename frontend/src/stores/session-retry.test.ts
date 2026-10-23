import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api/client';
import { getDevUserEmail, setDevUserEmail } from '@/lib/api/dev-user';
import { makeMe } from '@/test/session';

import {
  SESSION_ATTEMPT_TIMEOUT_MS,
  SESSION_RETRY_BUDGET_MS,
  sessionRetryDelay,
  useSessionStore,
} from './session';

/** P31-R01: `/me` survives an API cold start (Render free tier). */

const api = { fetchMe: vi.fn() };
vi.mock('@/lib/api/session', () => ({
  fetchMe: () => api.fetchMe(),
  fetchDevUsers: () => Promise.resolve([]),
}));

const network = (): ApiError => new ApiError(0, 'Network request failed');
const state = () => useSessionStore.getState();

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  useSessionStore.getState().reset();
  setDevUserEmail('sam.super@example.com');
});

afterEach(() => {
  useSessionStore.getState().reset();
  setDevUserEmail(null);
  vi.useRealTimers();
});

describe('session /me retry schedule (P31-R01)', () => {
  it('backs off 1, 2, 4, 8, 15 s and then repeats 15 s', () => {
    expect([0, 1, 2, 3, 4, 5, 6, 9].map(sessionRetryDelay)).toEqual([
      1_000, 2_000, 4_000, 8_000, 15_000, 15_000, 15_000, 15_000,
    ]);
  });

  it('network errors, then success within the budget: ready, and the dev user is kept', async () => {
    api.fetchMe
      .mockRejectedValueOnce(network())
      .mockRejectedValueOnce(new ApiError(502, 'Bad Gateway'))
      .mockResolvedValueOnce(makeMe());
    const done = state().load();

    await vi.advanceTimersByTimeAsync(0);
    expect(state().status).toBe('loading');
    expect(state().waking).toMatchObject({ attempt: 1 });
    expect(api.fetchMe).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(999);
    expect(api.fetchMe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(api.fetchMe).toHaveBeenCalledTimes(2);
    expect(state().waking).toMatchObject({ attempt: 2 });

    await vi.advanceTimersByTimeAsync(2_000);
    await done;
    expect(api.fetchMe).toHaveBeenCalledTimes(3);
    expect(state().status).toBe('ready');
    expect(state().waking).toBeNull();
    expect(getDevUserEmail()).toBe('sam.super@example.com');
  });

  it('503 until the budget runs out: then a "network" error, and the dev user is still kept', async () => {
    api.fetchMe.mockRejectedValue(new ApiError(503, 'Service Unavailable'));
    const done = state().load();

    await vi.advanceTimersByTimeAsync(SESSION_RETRY_BUDGET_MS - 1);
    expect(state().status).toBe('loading');
    await vi.advanceTimersByTimeAsync(SESSION_RETRY_BUDGET_MS);
    await done;

    expect(state().status).toBe('error');
    expect(state().errorKind).toBe('network');
    expect(state().waking).toBeNull();
    // 1+2+4+8+15×5 = 90 s of waits → 10 attempts, never past the budget.
    expect(api.fetchMe).toHaveBeenCalledTimes(10);
    expect(getDevUserEmail()).toBe('sam.super@example.com');
  });

  it('a 401 is final at once: no retries', async () => {
    api.fetchMe.mockRejectedValue(new ApiError(401, 'unauthorized'));
    await state().load();
    expect(state().errorKind).toBe('unauthorized');
    await vi.advanceTimersByTimeAsync(SESSION_RETRY_BUDGET_MS);
    expect(api.fetchMe).toHaveBeenCalledTimes(1);
  });

  it.each([400, 403, 404, 500])('a %i is not retried', async (status) => {
    api.fetchMe.mockRejectedValue(new ApiError(status, 'nope'));
    await state().load();
    expect(state().status).toBe('error');
    expect(state().errorKind).toBe('other');
    await vi.advanceTimersByTimeAsync(SESSION_RETRY_BUDGET_MS);
    expect(api.fetchMe).toHaveBeenCalledTimes(1);
  });

  it('an attempt that hangs is aborted after the per-attempt timeout and retried', async () => {
    api.fetchMe.mockReturnValueOnce(new Promise(() => undefined)).mockResolvedValueOnce(makeMe());
    const done = state().load();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(SESSION_ATTEMPT_TIMEOUT_MS - 1);
    expect(state().waking).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(state().waking).toMatchObject({ attempt: 1 });
    await vi.advanceTimersByTimeAsync(1_000);
    await done;
    expect(state().status).toBe('ready');
  });

  it('retryNow skips the current backoff wait', async () => {
    api.fetchMe.mockRejectedValueOnce(network()).mockRejectedValueOnce(network()).mockResolvedValueOnce(makeMe());
    const done = state().load();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(api.fetchMe).toHaveBeenCalledTimes(2);
    state().retryNow();
    await vi.advanceTimersByTimeAsync(0);
    await done;
    expect(api.fetchMe).toHaveBeenCalledTimes(3);
    expect(state().status).toBe('ready');
  });

  it('reset during a backoff stops the retry loop', async () => {
    api.fetchMe.mockRejectedValue(network());
    void state().load();
    await vi.advanceTimersByTimeAsync(0);
    state().reset();
    await vi.advanceTimersByTimeAsync(SESSION_RETRY_BUDGET_MS);
    expect(api.fetchMe).toHaveBeenCalledTimes(1);
    expect(state().status).toBe('idle');
  });
});

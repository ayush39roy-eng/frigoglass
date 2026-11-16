import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import * as sessionApi from '@/lib/api/session';
import { makeMe, seedSession } from '@/test/session';
import { useSessionStore } from '@/stores/session';

import { BEHIND_POLL_MS, PlanClockSync, WEEK_END_GRACE_MS } from './plan-clock-sync';

function renderSync() {
  const client = new QueryClient();
  const invalidate = vi.spyOn(client, 'invalidateQueries');
  render(
    <QueryClientProvider client={client}>
      <PlanClockSync />
    </QueryClientProvider>,
  );
  return { invalidate };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  seedSession(null);
});

// Sun 22 Nov 2026 23:00 Athens (+02:00); the served week ends Mon 23 Nov 00:00 Athens.
const SUNDAY_LATE = new Date('2026-11-22T21:00:00Z');
const W47 = {
  current_week: 47,
  weeks_left_in_year: 5,
  as_of_date: '2026-11-22',
  week_source: 'calendar' as const,
  week_ends_at: '2026-11-23T00:00:00+02:00',
  plan_week: { run_week: 47, run_version: 9, status: 'current' as const },
};

describe('PlanClockSync (P37, ADR 0052 §6)', () => {
  it('refetches /me at the served week_ends_at and moves the header to the new week', async () => {
    vi.useFakeTimers({ now: SUNDAY_LATE });
    seedSession(W47);
    const fetchMe = vi.spyOn(sessionApi, 'fetchMe').mockResolvedValue(
      makeMe({
        ...W47,
        current_week: 48,
        weeks_left_in_year: 4,
        as_of_date: '2026-11-23',
        week_ends_at: '2026-11-30T00:00:00+02:00',
        plan_week: { run_week: 47, run_version: 9, status: 'recalculating' },
      }),
    );
    const { invalidate } = renderSync();

    await act(() => vi.advanceTimersByTimeAsync(60 * 60 * 1000 - 1_000));
    expect(fetchMe).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(1_000 + WEEK_END_GRACE_MS));
    expect(fetchMe).toHaveBeenCalledTimes(1);
    expect(useSessionStore.getState().me?.current_week).toBe(48);
    // A new calendar week: run-derived and calendar-week queries are refreshed.
    expect(invalidate).toHaveBeenCalled();
  });

  it('polls while the plan is behind and invalidates when the new run lands', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-16T08:00:00Z') });
    seedSession({ ...W47, as_of_date: '2026-11-16', plan_week: { run_week: 42, run_version: 8, status: 'recalculating' } });
    const fetchMe = vi.spyOn(sessionApi, 'fetchMe').mockResolvedValue(makeMe(W47));
    const { invalidate } = renderSync();
    expect(invalidate).not.toHaveBeenCalled();
    await act(() => vi.advanceTimersByTimeAsync(BEHIND_POLL_MS));
    expect(fetchMe).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalled();
    // Current now: no more polling.
    await act(() => vi.advanceTimersByTimeAsync(BEHIND_POLL_MS * 3));
    expect(fetchMe).toHaveBeenCalledTimes(1);
  });

  it('refetches on window focus', async () => {
    seedSession(W47);
    const fetchMe = vi.spyOn(sessionApi, 'fetchMe').mockResolvedValue(makeMe(W47));
    renderSync();
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await Promise.resolve();
    });
    expect(fetchMe).toHaveBeenCalledTimes(1);
  });
});

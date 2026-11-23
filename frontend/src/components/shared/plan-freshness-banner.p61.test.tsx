import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const api = vi.hoisted(() => ({ fetch: vi.fn(), recalc: vi.fn() }));
vi.mock('@/lib/api/plan-freshness', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/plan-freshness')>('@/lib/api/plan-freshness');
  return { ...actual, fetchPlanFreshness: () => api.fetch(), recalculatePlan: () => api.recalc() };
});

import { renderWithProviders } from '@/test/render';

import { PlanFreshnessBanner } from './plan-freshness-banner';
import { PlanRecalculateButton } from './plan-recalc';

const STALE = {
  stale_project_count: 7,
  last_run_at: '2026-11-23T09:15:00Z',
  last_run_version: 12,
  run_in_flight: false,
  oldest_stale_since: '2026-11-23T09:20:00Z',
};

afterEach(() => {
  vi.clearAllMocks();
});

describe('PlanFreshnessBanner (ADR 0069)', () => {
  it('shows the served count, and Recalculate now calls recalculate', async () => {
    api.fetch.mockResolvedValue(STALE);
    api.recalc.mockResolvedValue({ recalc_status: 'queued', schedule_run_id: null, baseline_run_id: null, task_id: null, in_flight_run_id: null, stale_project_count: 7 });
    renderWithProviders(<PlanFreshnessBanner />);
    expect(await screen.findByTestId('plan-freshness-text')).toHaveTextContent(
      /Plan not recalculated — 7 projects changed since/,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Recalculate now' }));
    await waitFor(() => expect(api.recalc).toHaveBeenCalledTimes(1));
  });

  it('a Hub Planner sees the text without the button', async () => {
    api.fetch.mockResolvedValue(STALE);
    renderWithProviders(<PlanFreshnessBanner />, { session: { roles: ['Hub Planner'] } });
    expect(await screen.findByTestId('plan-freshness-text')).toHaveTextContent(/7 projects changed/);
    expect(screen.queryByRole('button', { name: 'Recalculate now' })).toBeNull();
  });

  it('says Recalculating… while a run is in flight, and nothing when the plan is fresh', async () => {
    api.fetch.mockResolvedValue({ ...STALE, run_in_flight: true });
    const { unmount } = renderWithProviders(<PlanFreshnessBanner />);
    expect(await screen.findByTestId('plan-freshness-text')).toHaveTextContent('Recalculating…');
    expect(screen.queryByRole('button', { name: 'Recalculate now' })).toBeNull();
    unmount();
    api.fetch.mockResolvedValue({ ...STALE, stale_project_count: 0 });
    renderWithProviders(<PlanFreshnessBanner />);
    await waitFor(() => expect(api.fetch).toHaveBeenCalled());
    expect(screen.queryByTestId('plan-freshness-banner')).toBeNull();
  });
});

describe('PlanRecalculateButton (header, ADR 0069)', () => {
  it('is always offered to an Admin, even with nothing stale, and calls recalculate', async () => {
    api.recalc.mockResolvedValue({ recalc_status: 'queued', schedule_run_id: null, baseline_run_id: null, task_id: null, in_flight_run_id: null, stale_project_count: 0 });
    renderWithProviders(<PlanRecalculateButton />, { session: { roles: ['Admin'] } });
    const button = screen.getByTestId('plan-recalculate-header');
    expect(button).toBeEnabled();
    await userEvent.click(button);
    await waitFor(() => expect(api.recalc).toHaveBeenCalledTimes(1));
  });

  it('is disabled for a Hub Planner', () => {
    renderWithProviders(<PlanRecalculateButton />, { session: { roles: ['Hub Planner'] } });
    expect(screen.getByTestId('plan-recalculate-header')).toBeDisabled();
  });
});

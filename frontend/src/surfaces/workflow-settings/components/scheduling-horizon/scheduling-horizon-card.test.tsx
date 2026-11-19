import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import { makeMe } from '@/test/session';

vi.mock('@/lib/api/client', async (orig) => {
  const actual = await orig<typeof import('@/lib/api/client')>();
  return { ...actual, apiGet: vi.fn(), apiSend: vi.fn() };
});

import * as client from '@/lib/api/client';

import { SchedulingHorizonCard } from './scheduling-horizon-card';

const SETTINGS = { horizon_years: 5, version: 1, updated_at: null, current_week: 47, horizon_weeks_next_run: 307 };

describe('SchedulingHorizonCard (P53, R53-2)', () => {
  beforeEach(() => {
    // `/me` is re-read after a save (it serves the next run's search limit).
    vi.mocked(client.apiGet)
      .mockReset()
      .mockImplementation((path: string) => Promise.resolve(path === '/me' ? makeMe() : SETTINGS) as never);
    vi.mocked(client.apiSend).mockReset().mockResolvedValue({ ...SETTINGS, horizon_years: 7, version: 2, horizon_weeks_next_run: 411 });
  });

  it('shows the served N and search limit, saves with the version and offers Recalculate', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SchedulingHorizonCard />);
    const select = await screen.findByTestId('horizon-years-select');
    expect(select).toHaveValue('5');
    expect(screen.getByTestId('horizon-next-run')).toHaveTextContent("W47 '31");
    expect(screen.getByTestId('scheduling-horizon-card')).toHaveTextContent('Cannot be scheduled within 5 years — check resources');
    await user.selectOptions(select, '7');
    await user.click(screen.getByTestId('horizon-save'));
    await waitFor(() =>
      expect(client.apiSend).toHaveBeenCalledWith('PUT', '/scheduling-settings', { horizon_years: 7, version: 1 }),
    );
    expect(await screen.findByTestId('horizon-saved')).toHaveTextContent('applies at the next recalculation');
    expect(screen.getByTestId('plan-week-recalculate')).toBeInTheDocument();
  });

  it('is read-only for a role other than Admin / Super Admin', async () => {
    renderWithProviders(<SchedulingHorizonCard />, { session: { roles: ['Hub Planner'] } });
    expect(await screen.findByTestId('horizon-years-select')).toBeDisabled();
    expect(screen.queryByTestId('horizon-save')).toBeNull();
  });
});

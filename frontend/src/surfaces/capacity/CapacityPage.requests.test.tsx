/**
 * P19-T07: network-level check with the REAL hooks and fetchers (only `apiGet`
 * is stubbed). After the owner removed the class chart and the chamber
 * utilization matrix, the page reads hub-load, class-breakdown and (only when
 * its section is opened) engineer-utilization. It never requests
 * `/capacity/utilization-matrix`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return { ...actual, apiGet: vi.fn() };
});

import { apiGet } from '@/lib/api/client';
import { renderWithProviders } from '@/test/render';
import { useHubFilterStore } from '@/stores/hub-filter';

import CapacityPage from './CapacityPage';
import { classRow, hubRow, SUMMARY_P11 } from './test-fixtures';

const mockApiGet = vi.mocked(apiGet);

function respond(path: string): unknown {
  if (path === '/capacity/hub-load') {
    return { has_active_schedule_run: true, schedule_run_version: 6, ...SUMMARY_P11, remaining_weeks: 47, rows: [hubRow()] };
  }
  if (path === '/capacity/class-breakdown') {
    return { has_active_schedule_run: true, schedule_run_version: 6, rows: [classRow()] };
  }
  if (path === '/capacity/engineer-utilization') return { week_range: [1, 4], current_week: 2, engineers: [] };
  if (path === '/schedule-runs/active') return null;
  return {};
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('CapacityPage requests (P19-T07)', () => {
  it('never requests the chamber utilization matrix, before or after opening the engineer section', async () => {
    useHubFilterStore.setState({ hubId: null, region: null });
    mockApiGet.mockImplementation((path: string) => Promise.resolve(respond(path)) as never);
    const user = userEvent.setup();
    renderWithProviders(<CapacityPage />);

    await screen.findByTestId('hub-summary-table');
    const paths = (): string[] => mockApiGet.mock.calls.map((c) => c[0]);
    expect(paths()).toContain('/capacity/hub-load');
    expect(paths()).toContain('/capacity/class-breakdown');
    expect(paths()).not.toContain('/capacity/engineer-utilization');

    await user.click(screen.getByRole('button', { name: 'Show engineer utilization' }));
    await waitFor(() => expect(paths()).toContain('/capacity/engineer-utilization'));
    expect(paths().filter((p) => /utilization-matrix|chamber/.test(p))).toEqual([]);
  });
});

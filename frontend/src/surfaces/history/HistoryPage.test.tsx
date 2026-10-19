import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';

const client = { apiGet: vi.fn() };
vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return { ...actual, apiGet: (...a: unknown[]) => client.apiGet(...a) };
});

import HistoryPage from './HistoryPage';
import { baselineFor, type ScheduleRunListItem } from './api';

function run(version: number, over: Partial<ScheduleRunListItem> = {}): ScheduleRunListItem {
  return {
    id: `run-${String(version)}`,
    version,
    solver_type: 'greedy',
    status: 'completed',
    is_active: false,
    horizon_weeks: 78,
    current_week: 42,
    trigger_reason: null,
    solver_status: null,
    created_at: '2026-10-18T08:00:00Z',
    ...over,
  };
}

const RUNS = [
  run(5, { is_active: true, trigger_reason: 'priority_move' }),
  run(4, { status: 'failed' }),
  run(3, { trigger_reason: 'check_in' }),
  run(2, { status: 'running' }),
];

const CHANGES = {
  run_id: 'run-5',
  run_version: 5,
  against_run_id: 'run-3',
  against_run_version: 3,
  hidden_count: 2,
  rows: [
    {
      project_id: 'p1',
      project_name: 'Cooler Alpha',
      hub: 'PD-India',
      priority: 'P1',
      before_projected_end_week: 40,
      after_projected_end_week: 44,
      delta_weeks: 4,
      before_within_year: true,
      after_within_year: true,
      before_left_out: false,
      after_left_out: false,
      before_blocked: false,
      after_blocked: false,
      is_new: false,
      is_removed: false,
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  client.apiGet.mockImplementation((path: string) => {
    if (path === '/schedule-runs') return Promise.resolve(RUNS);
    if (path === '/schedule-runs/run-5/changes') return Promise.resolve(CHANGES);
    if (path === '/scenarios/versions') return Promise.resolve([]);
    if (path === '/dashboard/projects') return Promise.resolve({ total_count: 0, rows: [] });
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
});

describe('baselineFor', () => {
  it('is the next older COMPLETED run in the newest-first list', () => {
    expect(baselineFor(RUNS, 'run-5')?.id).toBe('run-3');
    expect(baselineFor(RUNS, 'run-3')).toBeNull();
    expect(baselineFor(RUNS, 'missing')).toBeNull();
  });
});

describe('HistoryPage (P13-T15)', () => {
  it('lists the schedule runs and shows the served change list of the newest against its baseline', async () => {
    renderWithProviders(<HistoryPage />);
    const items = await screen.findAllByTestId('schedule-run-item');
    expect(items).toHaveLength(4);
    expect(items[0]).toHaveTextContent('v5');
    expect(items[0]).toHaveTextContent('Active');
    expect(items[0]).toHaveTextContent('Priority move');
    expect(items[0]).toHaveAttribute('aria-pressed', 'true');
    // The scheduler's 78-week search limit is never displayed (ADR 0024).
    expect(items[0].textContent).not.toMatch(/78/);

    const list = await screen.findByTestId('changed-projects-list');
    expect(client.apiGet).toHaveBeenCalledWith('/schedule-runs/run-5/changes', expect.objectContaining({ query: { against: 'run-3' } }));
    expect(list).toHaveTextContent('Run v5 compared with v3');
    expect(within(list).getByText('Cooler Alpha')).toBeInTheDocument();
    expect(screen.getByTestId('timeline-hidden-count')).toHaveTextContent('+2 more');
  });

  it('explains why a run has no change list (not completed / earliest run)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<HistoryPage />);
    const items = await screen.findAllByTestId('schedule-run-item');
    await user.click(items[1]);
    expect(screen.getByTestId('run-changes-unavailable')).toHaveTextContent('This run is failed');
    await user.click(items[2]);
    expect(screen.getByTestId('run-changes-first')).toBeInTheDocument();
  });

  it('shows the scenario versions tab from GET /scenarios/versions', async () => {
    const user = userEvent.setup();
    renderWithProviders(<HistoryPage />);
    await user.click(screen.getByRole('tab', { name: 'Scenario versions' }));
    expect(await screen.findByText('No scenarios applied yet')).toBeInTheDocument();
    expect(client.apiGet).toHaveBeenCalledWith('/scenarios/versions', expect.anything());
  });
});

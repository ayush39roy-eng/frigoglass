import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import { ROLE_MATRIX } from '@/test/roles';
import { PRIORITY_LABELS, type ProjectPriority } from '@/types/enums';

const client = { apiGet: vi.fn(), apiSend: vi.fn() };
vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return {
    ...actual,
    apiGet: (...a: unknown[]) => client.apiGet(...a),
    apiSend: (...a: unknown[]) => client.apiSend(...a),
  };
});
vi.mock('@/lib/use-follow-up-run', () => ({
  useFollowUpRunWatcher: () => ({ start: vi.fn(), watching: false }),
}));

import type { PriorityBoardCard, PriorityBoardResponse } from './api';
import PriorityBoardPage from './PriorityBoardPage';

function card(id: string, overrides: Partial<PriorityBoardCard> = {}): PriorityBoardCard {
  return {
    project_id: id,
    name: `Project ${id}`,
    hub_id: 'hub-gr',
    hub: 'R&D-Greece',
    category: 'A',
    status: 'In Development',
    external_code: null,
    score: 70,
    band: 'P1',
    suggested_band: 'P1',
    score_band: 'P1',
    capacity_fill: false,
    capacity_fill_reason: null,
    hard_gated: false,
    is_vip: false,
    projected_end_week: 40,
    within_year: true,
    health: 'on_track',
    tracking_status: 'live',
    band_rank: 1,
    frozen: false,
    ...overrides,
  };
}

function board(cols: Partial<Record<ProjectPriority, PriorityBoardCard[]>>): PriorityBoardResponse {
  return {
    run_id: 'run-42',
    columns: (['P1', 'P2', 'P3', 'P4', 'Q'] as const).map((p) => ({
      priority: p,
      count: cols[p]?.length ?? 0,
      label: PRIORITY_LABELS[p],
      not_scheduled: p === 'P4' || p === 'Q',
      queued_count: 0,
      design_weeks: 0,
      lab_weeks: 0,
      cards: cols[p] ?? [],
    })),
  };
}

const BOARD = board({
  P1: [card('a', { name: 'Alpha Cooler' }), card('b', { name: 'Beta Cooler', band_rank: 2, suggested_band: 'P4' })],
  P3: [card('c', { name: 'Gamma Cooler' })],
});

beforeEach(() => {
  vi.clearAllMocks();
  client.apiGet.mockImplementation((path: string) => {
    if (path === '/priority-board') return Promise.resolve(BOARD);
    if (path === '/dashboard/projects/facets') return Promise.resolve({ leaders: [], steps: [] });
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
});

describe('P59 Priority board multi-select', () => {
  it('ticks cards (and a column), moves them to P2 with ONE register-edits batch, then clears the selection', async () => {
    client.apiSend.mockResolvedValue({
      project_ids: ['a', 'b', 'c'],
      projects_marked_stale: [],
      recalc_status: 'not_needed',
      schedule_run_id: null,
      baseline_run_id: null,
      task_id: null,
    });
    const user = userEvent.setup();
    renderWithProviders(<PriorityBoardPage />);
    await screen.findByRole('link', { name: 'Alpha Cooler' });

    await user.click(screen.getByRole('checkbox', { name: 'Select all P1 projects' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Gamma Cooler' }));
    expect(screen.getByTestId('board-bulk-count')).toHaveTextContent('3 selected');

    await user.selectOptions(screen.getByTestId('board-bulk-band'), 'P2');
    await user.click(screen.getByTestId('board-bulk-move'));
    const dialog = await screen.findByTestId('board-bulk-confirm');
    expect(dialog).toHaveTextContent('Move 3 projects to P2? The schedule recalculates once.');
    await user.click(within(dialog).getByRole('button', { name: 'Move' }));

    await waitFor(() => expect(client.apiSend).toHaveBeenCalledTimes(1));
    expect(client.apiSend).toHaveBeenCalledWith('POST', '/projects/register-edits', {
      edits: [
        { project_id: 'a', priority: 'P2' },
        { project_id: 'b', priority: 'P2' },
        { project_id: 'c', priority: 'P2' },
      ],
    });
    await waitFor(() => expect(screen.queryByTestId('board-bulk-bar')).not.toBeInTheDocument());
    expect(screen.getByRole('checkbox', { name: 'Select Alpha Cooler' })).not.toBeChecked();
  });

  it('a read-only role gets no tick boxes and no bulk bar', async () => {
    renderWithProviders(<PriorityBoardPage />, { session: { permissions: ROLE_MATRIX['Executive Viewer'] } });
    await screen.findByRole('link', { name: 'Alpha Cooler' });
    expect(screen.queryAllByTestId('board-select')).toHaveLength(0);
    expect(screen.queryByTestId('board-column-select-all')).not.toBeInTheDocument();
  });

  it('a card shows only the set priority; the calculated band is in its tooltip', async () => {
    renderWithProviders(<PriorityBoardPage />);
    await screen.findByRole('link', { name: 'Beta Cooler' });
    const beta = screen.getByRole('link', { name: 'Beta Cooler' }).closest<HTMLElement>('[data-testid="board-card"]');
    if (!beta) throw new Error('no card');
    const trigger = within(beta).getByTestId('priority-move-trigger');
    expect(trigger).toHaveTextContent('P1');
    expect(trigger).toHaveAttribute('title', expect.stringContaining('Calculated from score: P4'));
    expect(within(beta).queryAllByText('P4', { exact: false })).toHaveLength(0);
  });
});

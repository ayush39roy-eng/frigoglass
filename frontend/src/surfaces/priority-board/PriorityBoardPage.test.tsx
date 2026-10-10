import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ApiError } from '@/lib/api/client';
import type { PriorityMoveResponse } from '@/lib/api/priority-move';
import { useHubFilterStore } from '@/stores/hub-filter';
import { seriousAxeViolations } from '@/test/axe';
import { renderWithProviders } from '@/test/render';
import { ROLE_MATRIX } from '@/test/roles';
import type { ProjectPriority } from '@/types/enums';

const client = { apiGet: vi.fn() };
vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return { ...actual, apiGet: (...a: unknown[]) => client.apiGet(...a) };
});
const move = { moveProjectPriority: vi.fn(), fetchScheduleRunChanges: vi.fn() };
vi.mock('@/lib/api/priority-move', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/priority-move')>('@/lib/api/priority-move');
  return {
    ...actual,
    moveProjectPriority: (...a: unknown[]) => move.moveProjectPriority(...a),
    fetchScheduleRunChanges: (...a: unknown[]) => move.fetchScheduleRunChanges(...a),
  };
});
const sse = { streamSolverProgress: vi.fn() };
vi.mock('@/lib/api/sse', () => ({
  streamSolverProgress: (...a: unknown[]) => sse.streamSolverProgress(...a),
}));
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
    score: 70,
    band: 'P1',
    hard_gated: false,
    is_vip: false,
    projected_end_week: 40,
    within_year: true,
    health: 'on_track',
    tracking_status: 'live',
    ...overrides,
  };
}

function board(cols: Partial<Record<ProjectPriority, PriorityBoardCard[]>>): PriorityBoardResponse {
  return {
    run_id: 'run-42',
    columns: (['P1', 'P2', 'P3', 'P4', 'Q'] as const).map((p) => ({
      priority: p,
      count: cols[p]?.length ?? 0,
      cards: cols[p] ?? [],
    })),
  };
}

const DEFAULT_BOARD = board({
  P1: [
    card('gated', { name: 'Gated Cooler', hard_gated: true, is_vip: true, tracking_status: 'overdue' }),
    card('alpha', { name: 'Alpha Cooler', score: 65.5 }),
  ],
  P2: [card('beta', { name: 'Beta Freezer', score: 50, within_year: false, projected_end_week: 60, health: 'off_track' })],
  Q: [card('gamma', { name: 'Gamma Queue', score: null, health: null, projected_end_week: null, within_year: null, tracking_status: 'idle' })],
});

function response(overrides: Partial<PriorityMoveResponse> = {}): PriorityMoveResponse {
  return {
    project_id: 'alpha',
    priority_before: 'P1',
    priority_after: 'P2',
    recalc_status: 'queued',
    schedule_run_id: 'run-43',
    baseline_run_id: 'run-42',
    task_id: 't',
    ...overrides,
  };
}

function column(p: ProjectPriority): HTMLElement {
  const el = screen.getAllByTestId('board-column').find((c) => c.getAttribute('data-priority') === p);
  if (!el) throw new Error(`no column ${p}`);
  return el;
}

function cardEl(name: string): HTMLElement {
  // `hidden`: the confirm dialog (modal) hides the board from the a11y tree.
  const link = screen.getByRole('link', { name, hidden: true });
  const el = link.closest<HTMLElement>('[data-testid="board-card"]');
  if (!el) throw new Error(`no card ${name}`);
  return el;
}

function dataTransfer() {
  return { setData: vi.fn(), getData: vi.fn(), effectAllowed: '', dropEffect: '' };
}

/** Pointer drag of `name` onto column `to`. */
function pointerDrop(name: string, to: ProjectPriority): void {
  const dt = dataTransfer();
  fireEvent.dragStart(cardEl(name), { dataTransfer: dt });
  fireEvent.dragOver(column(to), { dataTransfer: dt });
  fireEvent.drop(column(to), { dataTransfer: dt });
}

beforeEach(() => {
  vi.clearAllMocks();
  useHubFilterStore.setState({ hubId: null });
  client.apiGet.mockImplementation((path: string) => {
    if (path === '/priority-board') return Promise.resolve(DEFAULT_BOARD);
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
  sse.streamSolverProgress.mockImplementation(async (id: string) => ({ schedule_run_id: id, status: 'completed' }));
  move.fetchScheduleRunChanges.mockResolvedValue({
    run_id: 'run-43', run_version: 43, against_run_id: 'run-42', against_run_version: 42, hidden_count: 0, rows: [],
  });
});

describe('PriorityBoardPage — served grouping', () => {
  it('renders the five served columns in order with served counts and served card order', async () => {
    renderWithProviders(<PriorityBoardPage />);
    await screen.findByRole('link', { name: 'Alpha Cooler' });
    const cols = screen.getAllByTestId('board-column');
    expect(cols.map((c) => c.getAttribute('data-priority'))).toEqual(['P1', 'P2', 'P3', 'P4', 'Q']);
    expect(within(column('P1')).getByTestId('board-column-count')).toHaveTextContent('2');
    expect(within(column('P3')).getByTestId('board-column-count')).toHaveTextContent('0');
    const p1Names = within(column('P1')).getAllByRole('link').map((l) => l.textContent);
    expect(p1Names).toEqual(['Gated Cooler', 'Alpha Cooler']);
    expect(client.apiGet).toHaveBeenCalledWith('/priority-board', expect.objectContaining({ query: { hub_id: undefined } }));
  });

  it('shows the served card facts: VIP badge, tracking chip, finish vs within-year, health, score', async () => {
    renderWithProviders(<PriorityBoardPage />);
    const gated = cardEl(await screen.findByText('Gated Cooler').then((n) => n.textContent ?? ''));
    expect(within(gated).getByTestId('vip-badge')).toBeInTheDocument();
    expect(within(gated).getByTestId('tracking-status-chip')).toHaveAttribute('data-tracking', 'overdue');
    const beta = cardEl('Beta Freezer');
    expect(within(beta).getByTestId('finish-chip')).toHaveTextContent('W60');
    expect(within(beta).getByTestId('finish-chip')).toHaveTextContent('Past W52');
    expect(within(beta).getByTestId('health-chip')).toHaveTextContent('Off track');
    expect(within(beta).queryByTestId('vip-badge')).not.toBeInTheDocument();
    const gamma = cardEl('Gamma Queue');
    expect(within(gamma).getByTestId('finish-chip')).toHaveTextContent('No projected finish');
    expect(gamma).toHaveTextContent('Score —');
  });

  it('passes the global hub filter as hub_id', async () => {
    useHubFilterStore.setState({ hubId: 'hub-gr' });
    renderWithProviders(<PriorityBoardPage />);
    await screen.findByRole('link', { name: 'Alpha Cooler' });
    expect(client.apiGet).toHaveBeenCalledWith('/priority-board', expect.objectContaining({ query: { hub_id: 'hub-gr' } }));
  });

  it('has no serious/critical axe violations', async () => {
    const { container } = renderWithProviders(<PriorityBoardPage />);
    await screen.findByRole('link', { name: 'Alpha Cooler' });
    expect(await seriousAxeViolations(container)).toEqual([]);
  });
});

describe('PriorityBoardPage — drag gating', () => {
  it('a hard-gated P1 card shows a lock and has no drag handle', async () => {
    renderWithProviders(<PriorityBoardPage />);
    await screen.findByRole('link', { name: 'Gated Cooler' });
    const gated = cardEl('Gated Cooler');
    expect(within(gated).getByTestId('board-lock')).toHaveTextContent('Hard gate: stays P1');
    expect(within(gated).queryByTestId('board-drag-handle')).not.toBeInTheDocument();
    expect(gated).toHaveAttribute('draggable', 'false');
    // a pointer drag of it never opens the move flow
    pointerDrop('Gated Cooler', 'P2');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(move.moveProjectPriority).not.toHaveBeenCalled();
  });

  it('without Registration write (Executive Viewer) nothing is draggable and the pill is read-only', async () => {
    renderWithProviders(<PriorityBoardPage />, { session: { permissions: ROLE_MATRIX['Executive Viewer'] } });
    await screen.findByRole('link', { name: 'Alpha Cooler' });
    expect(screen.queryAllByTestId('board-drag-handle')).toHaveLength(0);
    expect(screen.queryAllByTestId('priority-move-trigger')).toHaveLength(0);
    for (const el of screen.getAllByTestId('board-card')) expect(el).toHaveAttribute('draggable', 'false');
    expect(screen.getByTestId('board-read-only')).toBeInTheDocument();
    pointerDrop('Alpha Cooler', 'P2');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('with Registration write (Hub Planner) cards are draggable and carry the move control', async () => {
    renderWithProviders(<PriorityBoardPage />, { session: { permissions: ROLE_MATRIX['Hub Planner'] } });
    await screen.findByRole('link', { name: 'Alpha Cooler' });
    expect(cardEl('Alpha Cooler')).toHaveAttribute('draggable', 'true');
    expect(within(cardEl('Alpha Cooler')).getByTestId('priority-move-trigger')).toBeInTheDocument();
  });
});

describe('PriorityBoardPage — a drop is the P11 priority move', () => {
  it('queued: optimistic move, confirm, POST, run follow, then "Timeline updated" and a board refetch', async () => {
    move.moveProjectPriority.mockResolvedValue(response());
    const user = userEvent.setup();
    renderWithProviders(<PriorityBoardPage />);
    await screen.findByRole('link', { name: 'Alpha Cooler' });

    pointerDrop('Alpha Cooler', 'P2');
    // optimistic: the card is already in P2, marked pending; served counts unchanged
    expect(within(column('P2')).getByRole('link', { name: 'Alpha Cooler', hidden: true })).toBeInTheDocument();
    expect(cardEl('Alpha Cooler')).toHaveAttribute('data-pending', 'true');
    expect(within(column('P1')).getByTestId('board-column-count')).toHaveTextContent('2');

    const dialog = await screen.findByRole('dialog', { name: 'Move to P2?' });
    await user.click(within(dialog).getByRole('button', { name: 'Move to P2' }));
    expect(move.moveProjectPriority).toHaveBeenCalledWith('alpha', 'P2');
    await waitFor(() => expect(sse.streamSolverProgress).toHaveBeenCalledWith('run-43', expect.any(Function), expect.any(AbortSignal)));
    const panel = await screen.findByTestId('priority-move-panel');
    expect(await within(panel).findByRole('heading', { name: 'Timeline updated' })).toBeInTheDocument();
    // the board was refetched after the accepted move
    await waitFor(() => expect(client.apiGet.mock.calls.filter(([p]) => p === '/priority-board').length).toBeGreaterThan(1));
  });

  it('deferred: the shared flow says the timeline updates after the current recalculation', async () => {
    move.moveProjectPriority.mockResolvedValue(
      response({ recalc_status: 'deferred', schedule_run_id: null, baseline_run_id: null, task_id: null }),
    );
    const user = userEvent.setup();
    renderWithProviders(<PriorityBoardPage />);
    await screen.findByRole('link', { name: 'Alpha Cooler' });
    pointerDrop('Alpha Cooler', 'P3');
    const dialog = await screen.findByRole('dialog', { name: 'Move to P3?' });
    await user.click(within(dialog).getByRole('button', { name: 'Move to P3' }));
    const notice = await screen.findByTestId('priority-move-notice');
    expect(notice).toHaveTextContent(/timeline updates automatically after the current recalculation/);
    expect(sse.streamSolverProgress).not.toHaveBeenCalled();
  });

  it('409 HARD_GATE_FORCES_P1: the card rolls back to its served column', async () => {
    move.moveProjectPriority.mockRejectedValue(new ApiError(409, 'Conflict', 'hard gate', 'HARD_GATE_FORCES_P1'));
    const user = userEvent.setup();
    renderWithProviders(<PriorityBoardPage />);
    await screen.findByRole('link', { name: 'Alpha Cooler' });
    pointerDrop('Alpha Cooler', 'P4');
    expect(within(column('P4')).getByRole('link', { name: 'Alpha Cooler', hidden: true })).toBeInTheDocument();
    const dialog = await screen.findByRole('dialog', { name: 'Move to P4?' });
    await user.click(within(dialog).getByRole('button', { name: 'Move to P4' }));
    expect(await screen.findByTestId('priority-move-notice')).toHaveTextContent(/hard gate/);
    await waitFor(() => expect(within(column('P1')).getByRole('link', { name: 'Alpha Cooler' })).toBeInTheDocument());
    expect(within(column('P4')).queryByRole('link', { name: 'Alpha Cooler' })).not.toBeInTheDocument();
    expect(screen.getByTestId('board-announcer')).toHaveTextContent('Alpha Cooler was not moved. It is back in P1.');
  });

  it('cancelling the confirm rolls the card back without a POST', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PriorityBoardPage />);
    await screen.findByRole('link', { name: 'Alpha Cooler' });
    pointerDrop('Alpha Cooler', 'P2');
    const dialog = await screen.findByRole('dialog', { name: 'Move to P2?' });
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(within(column('P1')).getByRole('link', { name: 'Alpha Cooler' })).toBeInTheDocument());
    expect(move.moveProjectPriority).not.toHaveBeenCalled();
  });

  it('keyboard: Space picks up, arrows choose a column, Space drops into the same move flow', async () => {
    move.moveProjectPriority.mockResolvedValue(response({ recalc_status: 'not_needed', schedule_run_id: null, baseline_run_id: null }));
    const user = userEvent.setup();
    renderWithProviders(<PriorityBoardPage />);
    await screen.findByRole('link', { name: 'Alpha Cooler' });
    const handle = within(cardEl('Alpha Cooler')).getByTestId('board-drag-handle');
    handle.focus();
    await user.keyboard(' ');
    expect(handle).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('board-announcer')).toHaveTextContent('Picked up Alpha Cooler in P1');
    await user.keyboard('{ArrowRight}{ArrowRight}');
    expect(column('P3')).toHaveAttribute('data-drop-target', 'true');
    expect(screen.getByTestId('board-announcer')).toHaveTextContent('Over P3.');
    await user.keyboard(' ');
    const dialog = await screen.findByRole('dialog', { name: 'Move to P3?' });
    await user.click(within(dialog).getByRole('button', { name: 'Move to P3' }));
    expect(move.moveProjectPriority).toHaveBeenCalledWith('alpha', 'P3');
  });

  it('keyboard: Escape cancels a pick-up without moving', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PriorityBoardPage />);
    await screen.findByRole('link', { name: 'Alpha Cooler' });
    const handle = within(cardEl('Alpha Cooler')).getByTestId('board-drag-handle');
    handle.focus();
    await user.keyboard(' {ArrowRight}{Escape}');
    expect(handle).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByTestId('board-announcer')).toHaveTextContent('Move cancelled.');
  });
});

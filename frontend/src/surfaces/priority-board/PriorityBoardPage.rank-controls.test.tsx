import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ApiError } from '@/lib/api/client';
import type { PriorityMoveResponse, PriorityPreviewResponse } from '@/lib/api/priority-move';
import { useHubFilterStore } from '@/stores/hub-filter';
import { seriousAxeViolations } from '@/test/axe';
import { renderWithProviders } from '@/test/render';
import { ROLE_MATRIX } from '@/test/roles';
import type { ProjectPriority } from '@/types/enums';
import { PRIORITY_LABELS } from '@/types/enums';

/**
 * Owner request 2026-11-17: ↑ / ↓ and a typed position on every board card
 * (Cards and List layouts), sent as `{ to_rank }` through the shared preview,
 * which is now a right-hand side panel. The API module is mocked; every figure
 * asserted is served.
 */

const client = { apiGet: vi.fn() };
vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return { ...actual, apiGet: (...a: unknown[]) => client.apiGet(...a) };
});
const move = {
  moveProjectPriority: vi.fn(),
  fetchScheduleRunChanges: vi.fn(),
  previewProjectPriority: vi.fn(),
  previewProjectBandRank: vi.fn(),
  moveProjectBandRank: vi.fn(),
};
vi.mock('@/lib/api/priority-move', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/priority-move')>('@/lib/api/priority-move');
  return {
    ...actual,
    moveProjectPriority: (...a: unknown[]) => move.moveProjectPriority(...a),
    fetchScheduleRunChanges: (...a: unknown[]) => move.fetchScheduleRunChanges(...a),
    previewProjectPriority: (...a: unknown[]) => move.previewProjectPriority(...a),
    previewProjectBandRank: (...a: unknown[]) => move.previewProjectBandRank(...a),
    moveProjectBandRank: (...a: unknown[]) => move.moveProjectBandRank(...a),
  };
});
vi.mock('@/lib/api/sse', () => ({ streamSolverProgress: vi.fn() }));
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
    hub_rank: overrides.band_rank === undefined ? 1 : overrides.band_rank,
    hub_band_size: null,
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
      // P42 (API_CONTRACT_P42 §2): served label, P4 / Q flag and queued count.
      label: PRIORITY_LABELS[p],
      not_scheduled: p === 'P4' || p === 'Q',
      queued_count: (cols[p] ?? []).filter((c) => c.queued === true).length,
      design_weeks: 0,
      lab_weeks: 0,
      cards: cols[p] ?? [],
    })),
  };
}

const RANKED = board({
  P1: [
    card('a', { name: 'Ann Cooler', band_rank: 1 }),
    card('b', { name: 'Bob Cooler', band_rank: 2 }),
    card('c', { name: 'Cid Cooler', band_rank: 3 }),
  ],
  P2: [card('x', { name: 'Xen Freezer', band_rank: 1 })],
});

/** A Hub Planner's scoped view: ranks 21 / 24 of a band the browser never sees whole. */
const SCOPED = board({
  P1: [card('m', { name: 'Mid Cooler', band_rank: 21 }), card('n', { name: 'Nub Cooler', band_rank: 24 })],
});

function rankPreview(id: string): PriorityPreviewResponse {
  return {
    result: 'preview',
    project_id: id,
    from_priority: 'P1',
    to_priority: 'P1',
    baseline_run_id: 'run-42',
    preview_token: 'tok-r',
    moved: { end_week_before: 40, end_week_after: 38, within_year_before: true, within_year_after: true, left_out_before: false, left_out_after: false },
    summary: { affected: 1, delayed: 1, earlier: 1, pushed_out_of_year: 0, pulled_into_year: 0 },
    changes: [],
    hidden_count: 0,
    elapsed_ms: 5,
  };
}

function applied(id: string): PriorityMoveResponse {
  return {
    project_id: id,
    priority_before: 'P1',
    priority_after: 'P1',
    recalc_status: 'applied',
    schedule_run_id: 'run-43',
    baseline_run_id: 'run-42',
    task_id: null,
    moved: rankPreview(id).moved,
    summary: rankPreview(id).summary,
    changes: [],
    hidden_count: 0,
  };
}

function serve(data: PriorityBoardResponse): void {
  client.apiGet.mockImplementation((path: string) => {
    if (path === '/priority-board') return Promise.resolve(data);
    if (path === '/dashboard/projects/facets') return Promise.resolve({ leaders: [], steps: [] });
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
}

function column(p: ProjectPriority): HTMLElement {
  const el = screen.getAllByTestId('board-column').find((c) => c.getAttribute('data-priority') === p);
  if (!el) throw new Error(`no column ${p}`);
  return el;
}

function cardOf(name: string): HTMLElement {
  const link = screen.getByRole('link', { name, hidden: true });
  const el = link.closest<HTMLElement>('[data-testid="board-card"], [data-testid="board-list-row"]');
  if (!el) throw new Error(`no card ${name}`);
  return el;
}

function p1Names(): string[] {
  return within(column('P1'))
    .getAllByRole('link', { hidden: true })
    .map((l) => l.textContent ?? '');
}

const up = (name: string, band = 'P1') => screen.getByRole('button', { name: `Move ${name} up one position in R&D-Greece · ${band}` });
const down = (name: string, band = 'P1') => screen.getByRole('button', { name: `Move ${name} down one position in R&D-Greece · ${band}` });
const positionOf = (name: string, band = 'P1') =>
  screen.getByRole('textbox', { name: `Position of ${name} in R&D-Greece · ${band}. Type a new position and press Enter` });

async function yes(user: ReturnType<typeof userEvent.setup>, panel: HTMLElement): Promise<void> {
  const button = within(panel).getByRole('button', { name: 'Yes, apply' });
  await waitFor(() => expect(button).toBeEnabled());
  await user.click(button);
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  useHubFilterStore.getState().setSelection([], []);
  serve(RANKED);
  move.previewProjectBandRank.mockImplementation((id: string) => Promise.resolve(rankPreview(id)));
  move.moveProjectBandRank.mockImplementation((id: string) => Promise.resolve(applied(id)));
});

describe('Priority board ↑ / ↓ (owner request 2026-11-17)', () => {
  it('↑ previews { hub_rank: rank − 1 } in the right-hand side panel beside the board; Yes confirms with the token', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PriorityBoardPage />);
    await screen.findByRole('link', { name: 'Bob Cooler' });
    await user.click(up('Bob Cooler'));

    expect(move.previewProjectBandRank).toHaveBeenCalledWith('b', { hub_rank: 1 }, expect.anything());
    expect(move.previewProjectPriority).not.toHaveBeenCalled();
    // Shown optimistically before the card that holds rank 1 now, pending.
    expect(p1Names()).toEqual(['Bob Cooler', 'Ann Cooler', 'Cid Cooler']);
    expect(cardOf('Bob Cooler')).toHaveAttribute('data-pending', 'true');

    const panel = await screen.findByRole('dialog', { name: 'Move Bob Cooler to position 1 in R&D-Greece · P1?' });
    expect(panel).toHaveAttribute('data-variant', 'sheet');
    expect(panel).toHaveAttribute('data-side', 'right');
    expect(panel).toHaveTextContent('Bob Cooler (now position 2) moves to position 1 in R&D-Greece · P1; its priority stays P1.');
    // The board stays on the page beside the panel.
    expect(screen.getByTestId('priority-board')).toBeInTheDocument();

    await yes(user, panel);
    expect(move.moveProjectBandRank).toHaveBeenCalledWith('b', { hub_rank: 1 }, 'tok-r');
    expect(await screen.findByRole('dialog', { name: 'Moved to position 1 in R&D-Greece · P1' })).toBeInTheDocument();
  });

  it('↓ previews { hub_rank: rank + 1 }', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PriorityBoardPage />);
    await screen.findByRole('link', { name: 'Ann Cooler' });
    await user.click(down('Ann Cooler'));
    expect(move.previewProjectBandRank).toHaveBeenCalledWith('a', { hub_rank: 2 }, expect.anything());
    expect(p1Names()).toEqual(['Bob Cooler', 'Ann Cooler', 'Cid Cooler']);
    expect(await screen.findByRole('dialog', { name: 'Move Ann Cooler to position 2 in R&D-Greece · P1?' })).toBeInTheDocument();
  });

  it('↑ is disabled at rank 1; ↓ is disabled on the last card when the board shows the whole band', async () => {
    renderWithProviders(<PriorityBoardPage />);
    await screen.findByRole('link', { name: 'Ann Cooler' });
    expect(up('Ann Cooler')).toBeDisabled();
    expect(down('Ann Cooler')).toBeEnabled();
    expect(up('Cid Cooler')).toBeEnabled();
    // Unfiltered, no hub selection, a session scoped to every hub: the served column IS the band.
    expect(down('Cid Cooler')).toBeDisabled();
    expect(down('Xen Freezer', 'P2')).toBeDisabled();
    expect(up('Xen Freezer', 'P2')).toBeDisabled();
  });

  it('cancel rolls the card back to its served place and writes nothing; focus returns to the button', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PriorityBoardPage />);
    await screen.findByRole('link', { name: 'Cid Cooler' });
    await user.click(up('Cid Cooler'));
    expect(p1Names()).toEqual(['Ann Cooler', 'Cid Cooler', 'Bob Cooler']);
    const panel = await screen.findByRole('dialog', { name: 'Move Cid Cooler to position 2 in R&D-Greece · P1?' });
    await waitFor(() => expect(within(panel).getByRole('button', { name: 'Yes, apply' })).toBeEnabled());
    await user.click(within(panel).getByRole('button', { name: 'No, cancel' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(p1Names()).toEqual(['Ann Cooler', 'Bob Cooler', 'Cid Cooler']);
    expect(cardOf('Cid Cooler')).not.toHaveAttribute('data-pending');
    expect(move.moveProjectBandRank).not.toHaveBeenCalled();
    expect(screen.getByTestId('board-announcer')).toHaveTextContent('Move cancelled. Cid Cooler keeps its place in P1.');
    await waitFor(() => expect(up('Cid Cooler')).toHaveFocus());
  });

  it('scoped view (Hub Planner, hub filter): ↓ on the last visible card is enabled, and BAD_RANK says "already last" without any "of M"', async () => {
    serve(SCOPED);
    useHubFilterStore.getState().setSelection(['hub-gr'], []);
    move.previewProjectBandRank.mockRejectedValue(new ApiError(422, 'x', 'out of range', 'BAD_RANK'));
    const user = userEvent.setup();
    renderWithProviders(<PriorityBoardPage />, {
      session: { permissions: ROLE_MATRIX['Hub Planner'], hub_scope_all: false, hub_ids: ['hub-gr'] },
    });
    await screen.findByRole('link', { name: 'Nub Cooler' });
    expect(down('Nub Cooler')).toBeEnabled();
    await user.click(down('Nub Cooler'));
    expect(move.previewProjectBandRank).toHaveBeenCalledWith('n', { hub_rank: 25 }, expect.anything());
    const panel = await screen.findByRole('dialog', { name: 'Position not changed' });
    expect(within(panel).getByTestId('preview-error')).toHaveTextContent(
      "Nub Cooler is already last in R&D-Greece · P1, so it can't move down. Nothing was changed.",
    );
    expect(panel.textContent).not.toMatch(/ of \d/);
    // Rolled back: not pending, still at its served place.
    expect(cardOf('Nub Cooler')).not.toHaveAttribute('data-pending');
    expect(p1Names()).toEqual(['Mid Cooler', 'Nub Cooler']);
  });

  it('a session scoped to some hubs never gets ↓ disabled from the visible list (the band may be larger)', async () => {
    renderWithProviders(<PriorityBoardPage />, {
      session: { permissions: ROLE_MATRIX['Hub Planner'], hub_scope_all: false, hub_ids: ['hub-gr'] },
    });
    await screen.findByRole('link', { name: 'Cid Cooler' });
    expect(down('Cid Cooler')).toBeEnabled();
  });

  it('503 BAND_RANK_BUSY on the preview: the contract copy, rollback, one call', async () => {
    move.previewProjectBandRank.mockRejectedValue(new ApiError(503, 'x', 'busy', 'BAND_RANK_BUSY'));
    const user = userEvent.setup();
    renderWithProviders(<PriorityBoardPage />);
    await screen.findByRole('link', { name: 'Bob Cooler' });
    await user.click(up('Bob Cooler'));
    const panel = await screen.findByRole('dialog', { name: 'Position not changed' });
    expect(within(panel).getByTestId('preview-error')).toHaveTextContent(
      'Another priority change is being saved. Please try again in a moment.',
    );
    expect(move.previewProjectBandRank).toHaveBeenCalledTimes(1);
    expect(p1Names()).toEqual(['Ann Cooler', 'Bob Cooler', 'Cid Cooler']);
  });

  it('List layout: ↑ / ↓ sit on every row and send to_rank through the same panel', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PriorityBoardPage />);
    await screen.findByRole('link', { name: 'Ann Cooler' });
    await user.click(screen.getByRole('button', { name: 'List' }));
    expect(screen.getAllByTestId('board-list-row')).toHaveLength(4);
    expect(up('Ann Cooler')).toBeDisabled();
    await user.click(down('Bob Cooler'));
    expect(move.previewProjectBandRank).toHaveBeenCalledWith('b', { hub_rank: 3 }, expect.anything());
    const panel = await screen.findByRole('dialog', { name: 'Move Bob Cooler to position 3 in R&D-Greece · P1?' });
    expect(panel).toHaveAttribute('data-side', 'right');
  });

  it('read-only roles get neither arrows nor a position field, only the #n chip', async () => {
    renderWithProviders(<PriorityBoardPage />, { session: { permissions: ROLE_MATRIX['Executive Viewer'] } });
    await screen.findByRole('link', { name: 'Ann Cooler' });
    expect(screen.queryAllByTestId('board-rank-steps')).toHaveLength(0);
    expect(screen.queryAllByTestId('board-rank-input')).toHaveLength(0);
    expect(within(column('P1')).getAllByTestId('board-rank-chip')).toHaveLength(3);
  });

  it('while a move is in flight the controls do nothing', async () => {
    let resolve: (v: PriorityPreviewResponse) => void = () => undefined;
    move.previewProjectBandRank.mockReturnValueOnce(new Promise((r) => (resolve = r)));
    const user = userEvent.setup();
    renderWithProviders(<PriorityBoardPage />);
    await screen.findByRole('link', { name: 'Bob Cooler' });
    await user.click(up('Bob Cooler'));
    // The panel is open and previewing: the board behind it is busy and inert.
    await screen.findByRole('dialog', { name: 'Move Bob Cooler to position 1 in R&D-Greece · P1?' });
    const cid = screen.getByRole('button', { name: 'Move Cid Cooler up one position in R&D-Greece · P1', hidden: true });
    expect(cid).toHaveAttribute('aria-disabled', 'true');
    act(() => cid.click());
    expect(move.previewProjectBandRank).toHaveBeenCalledTimes(1);
    resolve(rankPreview('b'));
  });
});

describe('Priority board typed position (owner request 2026-11-17)', () => {
  it('the position chip is an input; typing a number + Enter previews { to_rank }', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PriorityBoardPage />);
    await screen.findByRole('link', { name: 'Ann Cooler' });
    const field = positionOf('Ann Cooler');
    expect(field).toHaveValue('1');
    await user.clear(field);
    await user.type(field, '3{Enter}');
    expect(move.previewProjectBandRank).toHaveBeenCalledTimes(1);
    expect(move.previewProjectBandRank).toHaveBeenCalledWith('a', { hub_rank: 3 }, expect.anything());
    // After Cid (rank 3 now), pending.
    expect(p1Names()).toEqual(['Bob Cooler', 'Cid Cooler', 'Ann Cooler']);
    const panel = await screen.findByRole('dialog', { name: 'Move Ann Cooler to position 3 in R&D-Greece · P1?' });
    await yes(user, panel);
    expect(move.moveProjectBandRank).toHaveBeenCalledWith('a', { hub_rank: 3 }, 'tok-r');
    // Focus moved into the panel and back: the blur never sent a second request.
    expect(move.previewProjectBandRank).toHaveBeenCalledTimes(1);
  });

  it('blur submits a changed value', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PriorityBoardPage />);
    await screen.findByRole('link', { name: 'Cid Cooler' });
    const field = positionOf('Cid Cooler');
    await user.clear(field);
    await user.type(field, '1');
    await user.tab();
    expect(move.previewProjectBandRank).toHaveBeenCalledWith('c', { hub_rank: 1 }, expect.anything());
    expect(await screen.findByRole('dialog', { name: 'Move Cid Cooler to position 1 in R&D-Greece · P1?' })).toBeInTheDocument();
  });

  it('Escape cancels the edit and restores the served rank; the same rank sends nothing', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PriorityBoardPage />);
    await screen.findByRole('link', { name: 'Bob Cooler' });
    const field = positionOf('Bob Cooler');
    await user.clear(field);
    await user.type(field, '3');
    expect(field).toHaveValue('3');
    await user.keyboard('{Escape}');
    expect(field).toHaveValue('2');
    await user.clear(field);
    await user.type(field, '2{Enter}');
    await user.tab();
    expect(move.previewProjectBandRank).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it.each(['0', 'abc', '1.5', '-2'])('rejects %s on Enter with a message and sends nothing; blur then restores', async (raw) => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<PriorityBoardPage />);
    await screen.findByRole('link', { name: 'Bob Cooler' });
    const field = positionOf('Bob Cooler');
    await user.clear(field);
    await user.type(field, `${raw}{Enter}`);
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field).toHaveAccessibleDescription('Type a whole number, 1 or more.');
    expect(screen.getByRole('alert')).toHaveTextContent('Type a whole number, 1 or more.');
    expect(move.previewProjectBandRank).not.toHaveBeenCalled();
    expect(await seriousAxeViolations(container)).toEqual([]);
    await user.tab();
    expect(field).toHaveValue('2');
    expect(field).not.toHaveAttribute('aria-invalid');
    expect(move.previewProjectBandRank).not.toHaveBeenCalled();
  });

  it('a position past the end: the server answers BAD_RANK and the panel says so (no band size)', async () => {
    move.previewProjectBandRank.mockRejectedValue(new ApiError(422, 'x', 'out of range', 'BAD_RANK'));
    const user = userEvent.setup();
    renderWithProviders(<PriorityBoardPage />);
    await screen.findByRole('link', { name: 'Ann Cooler' });
    const field = positionOf('Ann Cooler');
    await user.clear(field);
    await user.type(field, '9{Enter}');
    expect(move.previewProjectBandRank).toHaveBeenCalledWith('a', { hub_rank: 9 }, expect.anything());
    const panel = await screen.findByRole('dialog', { name: 'Position not changed' });
    expect(within(panel).getByTestId('preview-error')).toHaveTextContent(
      'There is no position 9 in R&D-Greece · P1: the band has fewer projects than that. Choose a smaller number. Nothing was changed.',
    );
    expect(panel.textContent).not.toMatch(/ of \d/);
    expect(p1Names()).toEqual(['Ann Cooler', 'Bob Cooler', 'Cid Cooler']);
    await user.click(within(panel).getByRole('button', { name: 'Done' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(positionOf('Ann Cooler')).toHaveValue('1');
  });

  it('List layout: the row position is the same input', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PriorityBoardPage />);
    await screen.findByRole('link', { name: 'Ann Cooler' });
    await user.click(screen.getByRole('button', { name: 'List' }));
    const field = positionOf('Cid Cooler');
    expect(within(cardOf('Cid Cooler')).getByTestId('board-rank-input')).toBe(field);
    await user.clear(field);
    await user.type(field, '2{Enter}');
    expect(move.previewProjectBandRank).toHaveBeenCalledWith('c', { hub_rank: 2 }, expect.anything());
  });

  it('has no serious/critical axe violations with the controls (Cards and List) and with the panel open', async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<PriorityBoardPage />);
    await screen.findByRole('link', { name: 'Ann Cooler' });
    expect(await seriousAxeViolations(container)).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'List' }));
    expect(await seriousAxeViolations(container)).toEqual([]);
    await user.click(down('Ann Cooler'));
    const panel = await screen.findByRole('dialog', { name: 'Move Ann Cooler to position 2 in R&D-Greece · P1?' });
    await waitFor(() => expect(within(panel).getByRole('button', { name: 'Yes, apply' })).toBeEnabled());
    expect(await seriousAxeViolations(panel)).toEqual([]);
  });
});

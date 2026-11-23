import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createEvent, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';

import { ApiError } from '@/lib/api/client';
import type { PriorityMoveResponse } from '@/lib/api/priority-move';
import { useHubFilterStore } from '@/stores/hub-filter';
import { seriousAxeViolations } from '@/test/axe';
import { renderWithProviders } from '@/test/render';
import { ROLE_MATRIX } from '@/test/roles';
import type { ProjectPriority } from '@/types/enums';
import { PRIORITY_LABELS } from '@/types/enums';

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
const sse = { streamSolverProgress: vi.fn() };
vi.mock('@/lib/api/sse', () => ({
  streamSolverProgress: (...a: unknown[]) => sse.streamSolverProgress(...a),
}));
vi.mock('@/lib/use-follow-up-run', () => ({
  useFollowUpRunWatcher: () => ({ start: vi.fn(), watching: false }),
}));

import { hubRow } from '@/surfaces/capacity/test-fixtures';

import type { PriorityPreviewResponse } from '@/lib/api/priority-move';

import type { PriorityBoardCard, PriorityBoardResponse } from './api';
import { boardLayoutStorageKey } from './lib/board-layout';

/** P14 (ADR 0026): every drop previews first; Yes confirms with the token. */
function boardPreview(to: ProjectPriority): PriorityPreviewResponse {
  return {
    result: 'preview',
    project_id: 'alpha',
    from_priority: 'P1',
    to_priority: to,
    baseline_run_id: 'run-42',
    preview_token: 'tok-b',
    moved: { end_week_before: 40, end_week_after: 44, within_year_before: true, within_year_after: true, left_out_before: false, left_out_after: false },
    summary: { affected: 1, delayed: 1, earlier: 0, pushed_out_of_year: 0, pulled_into_year: 0 },
    changes: [],
    hidden_count: 0,
    elapsed_ms: 5,
  };
}

async function clickYes(user: ReturnType<typeof userEvent.setup>, dialog: HTMLElement): Promise<void> {
  const yes = within(dialog).getByRole('button', { name: 'Yes, apply' });
  await waitFor(() => expect(yes).toBeEnabled());
  await user.click(yes);
}
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
      // P13-T12: served per-column remaining weeks (illustrative values).
      design_weeks: p === 'P1' ? 926 : p === 'Q' ? 310.5 : 0,
      lab_weeks: p === 'P1' ? 907 : p === 'Q' ? 308 : 0,
      cards: cols[p] ?? [],
    })),
  };
}

const DEFAULT_BOARD = board({
  P1: [
    card('gated', { name: 'Gated Cooler', hard_gated: true, is_vip: true, tracking_status: 'overdue', band_rank: 1 }),
    card('alpha', { name: 'Alpha Cooler', score: 65.5, band_rank: 2 }),
  ],
  P2: [card('beta', { name: 'Beta Freezer', score: 50, within_year: false, projected_end_week: 60, health: 'off_track', frozen: true })],
  Q: [card('gamma', { name: 'Gamma Queue', score: null, health: null, projected_end_week: null, within_year: null, tracking_status: 'idle' })],
});

/** GDPR (OQ #8): only the caller's own name is served. */
const FACETS = {
  leaders: [
    { id: 'eng-self-0001', name: 'Rishi' },
    { id: 'eng-other-9f3c', name: null },
  ],
  steps: [],
};

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

/** P36: the column slot (`li`) holding the card or list row of `name`. */
function slotOf(name: string): HTMLElement {
  const link = screen.getByRole('link', { name, hidden: true });
  const el = link.closest<HTMLElement>('[data-slot-index]');
  if (!el) throw new Error(`no slot ${name}`);
  return el;
}

/** jsdom lays nothing out: give a slot a 100 px box at y = 0 so "above / below its middle" is decidable. */
function boxSlot(el: HTMLElement): void {
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({
    top: 0, bottom: 100, height: 100, left: 0, right: 200, width: 200, x: 0, y: 0, toJSON: () => ({}),
  } as DOMRect);
}

/** jsdom has no DragEvent, so an init `clientY` is dropped: set it on the event itself. */
function dragAt(kind: 'dragOver' | 'drop', el: HTMLElement, clientY: number, dt = dataTransfer()): void {
  const event = createEvent[kind](el, { dataTransfer: dt });
  Object.defineProperty(event, 'clientY', { value: clientY });
  fireEvent(el, event);
}

/** P36: pointer drag of `name` over the card `over`, `half` = above or below its middle, then drop. */
function rankDrop(name: string, over: string, half: 'above' | 'below', { drop = true } = {}): void {
  const dt = dataTransfer();
  const slot = slotOf(over);
  boxSlot(slot);
  const clientY = half === 'above' ? 10 : 90;
  fireEvent.dragStart(cardOrRow(name), { dataTransfer: dt });
  dragAt('dragOver', slot, clientY, dt);
  if (drop) dragAt('drop', slot, clientY, dt);
}

function cardOrRow(name: string): HTMLElement {
  const link = screen.getByRole('link', { name, hidden: true });
  const el = link.closest<HTMLElement>('[data-testid="board-card"], [data-testid="board-list-row"]');
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
  useHubFilterStore.getState().setSelection([], []);
  client.apiGet.mockImplementation((path: string) => {
    if (path === '/priority-board') return Promise.resolve(DEFAULT_BOARD);
    if (path === '/dashboard/projects/facets') return Promise.resolve(FACETS);
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
  sse.streamSolverProgress.mockImplementation(async (id: string) => ({ schedule_run_id: id, status: 'completed' }));
  move.fetchScheduleRunChanges.mockResolvedValue({
    run_id: 'run-43', run_version: 43, against_run_id: 'run-42', against_run_version: 42, hidden_count: 0, rows: [],
  });
  move.previewProjectPriority.mockImplementation((_id: string, to: ProjectPriority) => Promise.resolve(boardPreview(to)));
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
    expect(client.apiGet).toHaveBeenCalledWith('/priority-board', expect.objectContaining({ query: expect.objectContaining({ hub_id: undefined, region: undefined }) }));
  });

  it('shows the served card facts: VIP badge, tracking chip, finish vs within-year, health, score', async () => {
    renderWithProviders(<PriorityBoardPage />);
    const gated = cardEl(await screen.findByText('Gated Cooler').then((n) => n.textContent ?? ''));
    expect(within(gated).getByTestId('vip-badge')).toBeInTheDocument();
    expect(within(gated).getByTestId('tracking-status-chip')).toHaveAttribute('data-tracking', 'overdue');
    const beta = cardEl('Beta Freezer');
    // ADR 0024: a finish past W52 is never printed as W60 — it reads as spillover.
    expect(within(beta).getByTestId('finish-chip')).not.toHaveTextContent('W60');
    expect(within(beta).getByTestId('finish-chip')).toHaveTextContent('Past W52 → 2027');
    expect(within(beta).getByTestId('health-chip')).toHaveTextContent('Off track');
    expect(within(beta).queryByTestId('vip-badge')).not.toBeInTheDocument();
    const gamma = cardEl('Gamma Queue');
    expect(within(gamma).getByTestId('finish-chip')).toHaveTextContent('No projected finish');
    expect(gamma).toHaveTextContent('Weighted score —');
    // P59 (owner 2026-11-23): only the set priority is drawn; the calculated band is its hover text.
    const alpha = within(cardEl('Alpha Cooler'));
    expect(alpha.queryByTestId('band-chip-suggested')).not.toBeInTheDocument();
    expect(alpha.getByTestId('priority-move-trigger')).toHaveAttribute('title', expect.stringContaining('Calculated from score: P1'));
  });

  it('passes the global hub filter as hub_id', async () => {
    useHubFilterStore.getState().setSelection(['hub-gr'], []);
    renderWithProviders(<PriorityBoardPage />);
    await screen.findByRole('link', { name: 'Alpha Cooler' });
    expect(client.apiGet).toHaveBeenCalledWith('/priority-board', expect.objectContaining({ query: expect.objectContaining({ hub_id: ['hub-gr'] }) }));
  });

  it('has no serious/critical axe violations', async () => {
    const { container } = renderWithProviders(<PriorityBoardPage />);
    await screen.findByRole('link', { name: 'Alpha Cooler' });
    expect(await seriousAxeViolations(container)).toEqual([]);
  });
});

describe('PriorityBoardPage — P13-T12 weeks and toolbar', () => {
  it('each column header shows the served remaining design / lab weeks', async () => {
    renderWithProviders(<PriorityBoardPage />);
    await screen.findByRole('link', { name: 'Alpha Cooler' });
    expect(within(column('P1')).getByTestId('board-column-weeks')).toHaveTextContent('Remaining D 926 w · L 907 w');
    expect(within(column('Q')).getByTestId('board-column-weeks')).toHaveTextContent('Remaining D 311 w · L 308 w');
  });

  it('debounces the search and sends it to the server as q', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PriorityBoardPage />);
    await screen.findByRole('link', { name: 'Alpha Cooler' });
    await user.type(screen.getByRole('searchbox', { name: 'Search' }), 'cooler');
    await waitFor(() =>
      expect(client.apiGet).toHaveBeenCalledWith('/priority-board', expect.objectContaining({ query: expect.objectContaining({ q: 'cooler' }) })),
    );
    // No intermediate keystroke reached the server.
    expect(client.apiGet).not.toHaveBeenCalledWith('/priority-board', expect.objectContaining({ query: expect.objectContaining({ q: 'coo' }) }));
  });

  it('sends Category / Type / Status / Leader as server-side filters, with the country', async () => {
    useHubFilterStore.getState().setSelection([], ['India']);
    const user = userEvent.setup();
    renderWithProviders(<PriorityBoardPage />);
    await screen.findByRole('link', { name: 'Alpha Cooler' });
    // P31: Category / Type are multi-select chip groups (repeated params, OR).
    await user.click(within(screen.getByRole('group', { name: 'Category' })).getByRole('button', { name: 'B' }));
    await user.click(within(screen.getByRole('group', { name: 'Category' })).getByRole('button', { name: 'A' }));
    await user.click(within(screen.getByRole('group', { name: 'Type' })).getByRole('button', { name: 'Cost Optimization' }));
    // Multi-select (owner ask 2026-11-13): two statuses, OR-ed by the server.
    await user.click(screen.getByRole('button', { name: 'Status' }));
    await user.click(await screen.findByRole('option', { name: 'On Hold' }));
    await user.click(screen.getByRole('option', { name: 'In Queue' }));
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Leader' }));
    await user.click(await screen.findByRole('option', { name: 'Rishi' }));
    await user.keyboard('{Escape}');
    // The last BOARD request carries every filter. (Not the last GET of any
    // path: under a loaded runner a facets fetch can land after it.)
    await waitFor(
      () => {
        const boardCalls = client.apiGet.mock.calls.filter(([p]) => p === '/priority-board');
        expect(boardCalls[boardCalls.length - 1]?.[1]).toEqual(
          expect.objectContaining({
            query: expect.objectContaining({
              region: ['India'],
              category: ['A', 'B'],
              type: ['CO'],
              status_: ['In Queue', 'On Hold'],
              leader_engineer_id: ['eng-self-0001'],
            }),
          }),
        );
      },
      { timeout: 5_000 },
    );
    expect(client.apiGet).toHaveBeenCalledWith('/dashboard/projects/facets', expect.objectContaining({ query: { region: ['India'] } }));
    // Four Radix selects: allow for a loaded runner.
  }, 15_000);

  it('shows each hub\'s served design / lab load, capacity and booked % above the board', async () => {
    client.apiGet.mockImplementation((path: string) => {
      if (path === '/priority-board') return Promise.resolve(DEFAULT_BOARD);
      if (path === '/dashboard/projects/facets') return Promise.resolve(FACETS);
      if (path === '/capacity/hub-load') {
        return Promise.resolve({
          has_active_schedule_run: true,
          schedule_run_version: 4,
          remaining_weeks: 10,
          near_full_threshold_pct: 85,
          full_threshold_pct: 100,
          areas: [],
          rows: [hubRow({ hub: 'PD-India' })],
        });
      }
      return Promise.reject(new Error(`unexpected GET ${path}`));
    });
    renderWithProviders(<PriorityBoardPage />);
    const design = await screen.findByTestId('hub-load-PD-India-design');
    expect(design).toHaveTextContent('587 / 253 wks (232 %)');
    expect(screen.getByTestId('hub-load-PD-India-lab')).toHaveTextContent('497 / 186 wks (267 %)');
    // P30 (ADR 0041): these are the served full-year DEMAND figures, labelled so.
    expect(design).toHaveTextContent('Design demand');
    expect(screen.getByTestId('hub-load-PD-India-lab')).toHaveTextContent('Lab demand (India)');
    expect(screen.getByRole('region', { name: 'Design and lab demand per hub, full year' })).toBeInTheDocument();
  });

  it('ADR 0028: a leader id with no name is offered as "Name unavailable"', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PriorityBoardPage />);
    await screen.findByRole('link', { name: 'Alpha Cooler' });
    await user.click(screen.getByRole('button', { name: 'Leader' }));
    const options = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(options).toEqual(['All leaders', 'Rishi', 'Name unavailable · 9f3c']);
  });

  it('a filtered empty board says no project matches, and Clear filters resets the toolbar', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PriorityBoardPage />);
    await screen.findByRole('link', { name: 'Alpha Cooler' });
    client.apiGet.mockImplementation((path: string) =>
      path === '/priority-board' ? Promise.resolve(board({})) : Promise.resolve(FACETS),
    );
    await user.type(screen.getByRole('searchbox', { name: 'Search' }), 'zzz');
    expect(await screen.findByText('No projects match these filters')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getByRole('searchbox', { name: 'Search' })).toHaveValue('');
  });
});

describe('PriorityBoardPage — drag gating', () => {
  it('a hard-gated P1 card shows a lock; it can be reordered within P1 (R36-10) but never leaves P1', async () => {
    renderWithProviders(<PriorityBoardPage />);
    await screen.findByRole('link', { name: 'Gated Cooler' });
    const gated = cardEl('Gated Cooler');
    expect(within(gated).getByTestId('board-lock')).toHaveTextContent('Hard gate: stays P1');
    expect(within(gated).getByRole('button', { name: 'Reorder Gated Cooler within P1' })).toBeInTheDocument();
    expect(gated).toHaveAttribute('draggable', 'true');
    // a pointer drag of it onto another column never opens the move flow
    pointerDrop('Gated Cooler', 'P2');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(move.previewProjectPriority).not.toHaveBeenCalled();
    expect(move.moveProjectPriority).not.toHaveBeenCalled();
  });

  it('a hard-gated P1 card with no served band_rank keeps the old lock-only behaviour', async () => {
    client.apiGet.mockImplementation((path: string) => {
      if (path === '/priority-board') {
        return Promise.resolve(board({ P1: [card('gated', { name: 'Gated Cooler', hard_gated: true, band_rank: null })] }));
      }
      return Promise.resolve(FACETS);
    });
    renderWithProviders(<PriorityBoardPage />);
    await screen.findByRole('link', { name: 'Gated Cooler' });
    expect(within(cardEl('Gated Cooler')).queryByTestId('board-drag-handle')).not.toBeInTheDocument();
    expect(cardEl('Gated Cooler')).toHaveAttribute('draggable', 'false');
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
    // P36: the order is visible (the served band_rank), but cannot be changed.
    expect(within(cardEl('Alpha Cooler')).getByTestId('board-rank-chip')).toHaveTextContent('#2');
    const dt = dataTransfer();
    fireEvent.dragStart(cardEl('Alpha Cooler'), { dataTransfer: dt });
    fireEvent.dragOver(slotOf('Gated Cooler'), { dataTransfer: dt });
    fireEvent.drop(slotOf('Gated Cooler'), { dataTransfer: dt });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(move.previewProjectBandRank).not.toHaveBeenCalled();
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
    // QA-P14-1: pending cue is a dashed border, never opacity (AA contrast)
    expect(cardEl('Alpha Cooler')).not.toHaveClass('opacity-70');
    expect(cardEl('Alpha Cooler')).toHaveClass('border-dashed');
    expect(within(column('P1')).getByTestId('board-column-count')).toHaveTextContent('2');

    const dialog = await screen.findByRole('dialog', { name: 'Move to P2?' });
    await clickYes(user, dialog);
    expect(move.moveProjectPriority).toHaveBeenCalledWith('alpha', 'P2', 'tok-b');
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
    await clickYes(user, dialog);
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
    await clickYes(user, dialog);
    expect(await screen.findByTestId('preview-error')).toHaveTextContent(/hard gate/);
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(within(column('P1')).getByRole('link', { name: 'Alpha Cooler' })).toBeInTheDocument());
    expect(within(column('P4')).queryByRole('link', { name: 'Alpha Cooler' })).not.toBeInTheDocument();
    expect(screen.getByTestId('board-announcer')).toHaveTextContent('Alpha Cooler was not moved. It is back in P1.');
  });

  it('P36-R03: 503 BAND_RANK_BUSY on a column move shows the contract copy and the card rolls back', async () => {
    move.moveProjectPriority.mockRejectedValue(
      new ApiError(503, 'Service Unavailable', 'busy', 'BAND_RANK_BUSY', 5),
    );
    const user = userEvent.setup();
    renderWithProviders(<PriorityBoardPage />);
    await screen.findByRole('link', { name: 'Alpha Cooler' });
    pointerDrop('Alpha Cooler', 'P4');
    const dialog = await screen.findByRole('dialog', { name: 'Move to P4?' });
    await clickYes(user, dialog);
    expect(await screen.findByTestId('preview-error')).toHaveTextContent(
      'Another priority change is being saved. Please try again in a moment.',
    );
    expect(move.moveProjectPriority).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(within(column('P1')).getByRole('link', { name: 'Alpha Cooler' })).toBeInTheDocument());
    expect(within(column('P4')).queryByRole('link', { name: 'Alpha Cooler' })).not.toBeInTheDocument();
  });

  it('P14: the drop stays pending through the preview; Yes applies in-process and the board refetches', async () => {
    move.moveProjectPriority.mockResolvedValue(
      response({ recalc_status: 'applied', schedule_run_id: 'run-43', baseline_run_id: 'run-42', task_id: null }),
    );
    const user = userEvent.setup();
    renderWithProviders(<PriorityBoardPage />);
    await screen.findByRole('link', { name: 'Alpha Cooler' });
    pointerDrop('Alpha Cooler', 'P2');
    const dialog = await screen.findByRole('dialog', { name: 'Move to P2?' });
    expect(move.previewProjectPriority).toHaveBeenCalledWith('alpha', 'P2', expect.anything());
    // Pending: shown in P2, nothing written yet.
    expect(cardEl('Alpha Cooler')).toHaveAttribute('data-pending', 'true');
    expect(move.moveProjectPriority).not.toHaveBeenCalled();
    await clickYes(user, dialog);
    expect(move.moveProjectPriority).toHaveBeenCalledWith('alpha', 'P2', 'tok-b');
    expect(await screen.findByRole('dialog', { name: 'Moved to P2' })).toBeInTheDocument();
    expect(sse.streamSolverProgress).not.toHaveBeenCalled();
    await waitFor(() => expect(client.apiGet.mock.calls.filter(([p]) => p === '/priority-board').length).toBeGreaterThan(1));
    expect(screen.getByTestId('board-announcer')).toHaveTextContent('Alpha Cooler moved to P2.');
  });

  it('P58 (owner bug "the priority remains the same"): after a move the card reads the new priority; the unchanged suggested band is labelled, never a bare old-band pill', async () => {
    // The score's suggested band does not follow a priority move. Before P58 the
    // card drew it as the same unlabelled pill as a priority, next to the score,
    // so a project moved P4 → P3 still showed "P4" on its card.
    const before = board({ P4: [card('ngc', { name: 'NGC 450', band: 'P4', suggested_band: 'P4', score_band: 'P4' })] });
    const after = board({ P3: [card('ngc', { name: 'NGC 450', band: 'P4', suggested_band: 'P4', score_band: 'P4', band_rank: 92 })] });
    let moved = false;
    client.apiGet.mockImplementation((path: string) => {
      if (path === '/priority-board') return Promise.resolve(moved ? after : before);
      if (path === '/dashboard/projects/facets') return Promise.resolve(FACETS);
      return Promise.reject(new Error(`unexpected GET ${path}`));
    });
    move.moveProjectPriority.mockImplementation(() => {
      moved = true;
      return Promise.resolve(
        response({ project_id: 'ngc', priority_before: 'P4', priority_after: 'P3', recalc_status: 'applied', task_id: null }),
      );
    });
    const user = userEvent.setup();
    renderWithProviders(<PriorityBoardPage />);
    await screen.findByRole('link', { name: 'NGC 450' });
    pointerDrop('NGC 450', 'P3');
    await clickYes(user, await screen.findByRole('dialog', { name: 'Move to P3?' }));
    expect(move.moveProjectPriority).toHaveBeenCalledWith('ngc', 'P3', 'tok-b');
    await user.keyboard('{Escape}');

    // The refetched board serves the card in P3, no longer pending.
    await waitFor(() => expect(cardEl('NGC 450')).not.toHaveAttribute('data-pending'));
    const ngc = cardEl('NGC 450');
    expect(column('P3')).toContainElement(ngc);
    expect(within(column('P4')).queryByRole('link', { name: 'NGC 450', hidden: true })).toBeNull();
    // The set priority: labelled, and its control reads P3.
    expect(within(ngc).getByTestId('board-card-priority-label')).toHaveTextContent('Priority');
    expect(within(ngc).getByTestId('priority-move-trigger')).toHaveTextContent('P3');
    // P59 (owner 2026-11-23): the calculated band (still P4) is NOT drawn; it is the
    // priority control's hover text, and no "P4" is visible on the card.
    expect(within(ngc).queryByTestId('band-chip-suggested')).not.toBeInTheDocument();
    expect(within(ngc).getByTestId('priority-move-trigger')).toHaveAttribute(
      'title',
      expect.stringContaining('Calculated from score: P4'),
    );
    expect(within(ngc).queryAllByText('P4', { exact: false })).toHaveLength(0);

    // List layout: the row shows the set priority P3, with the calculated band in its tooltip.
    await user.click(screen.getByRole('button', { name: 'List' }));
    const row = screen.getAllByTestId('board-list-row').find((r) => r.textContent?.includes('NGC 450')) as HTMLElement;
    const pill = within(row).getByTestId('board-list-priority');
    expect(pill).toHaveTextContent(/^P3$/);
    expect(within(pill).getByTitle(/Calculated from score: P4$/)).toBeInTheDocument();
    expect(within(row).queryByTestId('band-chip-suggested')).not.toBeInTheDocument();
  });

  it('No on the preview rolls the card back (snap back) without a POST', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PriorityBoardPage />);
    await screen.findByRole('link', { name: 'Alpha Cooler' });
    pointerDrop('Alpha Cooler', 'P2');
    const dialog = await screen.findByRole('dialog', { name: 'Move to P2?' });
    await user.click(within(dialog).getByRole('button', { name: 'No, cancel' }));
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
    await clickYes(user, dialog);
    expect(move.moveProjectPriority).toHaveBeenCalledWith('alpha', 'P3', 'tok-b');
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

function LocationProbe(): React.JSX.Element {
  const loc = useLocation();
  return <output data-testid="location">{loc.search}</output>;
}

describe('PriorityBoardPage — P21-T05 Cards | List layout', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('defaults to Cards; the toggle switches to a names-only list and back', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PriorityBoardPage />);
    await screen.findByRole('link', { name: 'Alpha Cooler' });
    const group = screen.getByRole('group', { name: 'Board layout' });
    expect(within(group).getByRole('button', { name: 'Cards' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByTestId('board-card').length).toBeGreaterThan(0);

    await user.click(within(group).getByRole('button', { name: 'List' }));
    expect(within(group).getByRole('button', { name: 'List' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryAllByTestId('board-card')).toHaveLength(0);
    const rows = screen.getAllByTestId('board-list-row');
    expect(rows).toHaveLength(4);
    // Names only: no score, chips or status in a row; the position and the name.
    const alpha = rows.find((r) => r.textContent?.includes('Alpha Cooler')) as HTMLElement;
    // Names only, plus the same suggested-band chip as the grid ("P1"). P36: the
    // position is the served band_rank — for a session that may re-rank, an
    // editable field (owner request 2026-11-17) labelled with its spoken form.
    // P59: the set priority (P1) on the right, not the calculated band.
    expect(alpha).toHaveTextContent(/^#R&D2Alpha CoolerP1$/);
    expect(within(alpha).getByRole('textbox', { name: /^Position of Alpha Cooler in R&D-Greece · P1/ })).toHaveValue('2');
    expect(within(alpha).getByRole('link', { name: 'Alpha Cooler' })).toHaveAttribute('title', 'Alpha Cooler');
    // Owner feedback: the full name over up to two lines (fixed 46 px row), never one truncated line.
    expect(within(alpha).getByRole('link', { name: 'Alpha Cooler' })).toHaveClass('line-clamp-2');
    expect(within(alpha).getByRole('link', { name: 'Alpha Cooler' })).not.toHaveClass('truncate');
    expect(alpha).toHaveClass('h-[46px]');
    expect(within(alpha).getByRole('link', { name: 'Alpha Cooler' })).toHaveAttribute('href', '/projects/alpha');
    expect(within(column('P1')).getByTestId('board-column-count')).toHaveTextContent('2');

    await user.click(within(group).getByRole('button', { name: 'Cards' }));
    expect(screen.getAllByTestId('board-card').length).toBeGreaterThan(0);
  });

  it('a keyboard move from a list row opens the same preview dialog and sends the same request', async () => {
    move.moveProjectPriority.mockResolvedValue(response({ recalc_status: 'not_needed', schedule_run_id: null, baseline_run_id: null }));
    const user = userEvent.setup();
    renderWithProviders(<PriorityBoardPage />);
    await screen.findByRole('link', { name: 'Alpha Cooler' });
    await user.click(screen.getByRole('button', { name: 'List' }));
    const row = screen.getAllByTestId('board-list-row').find((r) => r.textContent?.includes('Alpha Cooler')) as HTMLElement;
    const handle = within(row).getByRole('button', { name: 'Move Alpha Cooler within or between priority columns' });
    handle.focus();
    await user.keyboard(' {ArrowRight}{ArrowRight} ');
    const dialog = await screen.findByRole('dialog', { name: 'Move to P3?' });
    expect(move.previewProjectPriority).toHaveBeenCalledWith('alpha', 'P3', expect.anything());
    await clickYes(user, dialog);
    expect(move.moveProjectPriority).toHaveBeenCalledWith('alpha', 'P3', 'tok-b');
  });

  it('a pointer drop from a list row goes through the same flow', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PriorityBoardPage />);
    await screen.findByRole('link', { name: 'Alpha Cooler' });
    await user.click(screen.getByRole('button', { name: 'List' }));
    const row = screen.getAllByTestId('board-list-row').find((r) => r.textContent?.includes('Alpha Cooler')) as HTMLElement;
    const dt = dataTransfer();
    fireEvent.dragStart(row, { dataTransfer: dt });
    fireEvent.dragOver(column('P2'), { dataTransfer: dt });
    fireEvent.drop(column('P2'), { dataTransfer: dt });
    expect(await screen.findByRole('dialog', { name: 'Move to P2?' })).toBeInTheDocument();
    expect(move.previewProjectPriority).toHaveBeenCalledWith('alpha', 'P2', expect.anything());
  });

  it('remembers the choice per user in localStorage and in the URL', async () => {
    const user = userEvent.setup();
    const first = renderWithProviders(
      <>
        <PriorityBoardPage />
        <LocationProbe />
      </>,
    );
    await screen.findByRole('link', { name: 'Alpha Cooler' });
    await user.click(screen.getByRole('button', { name: 'List' }));
    expect(screen.getByTestId('location')).toHaveTextContent('layout=list');
    expect(localStorage.getItem(boardLayoutStorageKey('user-super'))).toBe('list');
    first.unmount();

    // A fresh visit with no URL param restores List from storage.
    renderWithProviders(<PriorityBoardPage />);
    await screen.findByRole('link', { name: 'Alpha Cooler' });
    expect(screen.getByRole('button', { name: 'List' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getAllByTestId('board-list-row').length).toBe(4);
    // Another user keeps the default.
    expect(localStorage.getItem(boardLayoutStorageKey('someone-else'))).toBeNull();
  });

  it('P25-T04: cards and list rows show the served suggested band chip, with the capacity-fill reason; the list shows external_code', async () => {
    const reason = 'P1 (capacity fill): hub P1 design load 9.00 of 10.00 weeks with this project';
    client.apiGet.mockImplementation((path: string) => {
      if (path === '/priority-board') {
        return Promise.resolve(
          board({
            P1: [card('alpha', { name: 'Alpha Cooler', external_code: 'FG-2026-014' })],
            P2: [card('beta', { name: 'Beta Freezer', band: 'P2', score_band: 'P2', suggested_band: 'P1', capacity_fill: true, capacity_fill_reason: reason })],
          }),
        );
      }
      if (path === '/dashboard/projects/facets') return Promise.resolve(FACETS);
      return Promise.reject(new Error(`unexpected GET ${path}`));
    });
    const user = userEvent.setup();
    renderWithProviders(<PriorityBoardPage />);
    await screen.findByRole('link', { name: 'Beta Freezer' });
    // P59: the card shows only the set priority (P2); the capacity-filled calculated band is its hover text.
    const beta = within(cardEl('Beta Freezer'));
    expect(beta.queryByTestId('band-chip-capacity-fill')).not.toBeInTheDocument();
    expect(beta.getByTestId('priority-move-trigger')).toHaveAttribute(
      'title',
      expect.stringContaining('Calculated from score: P1 (capacity fill; score band P2)'),
    );

    await user.click(screen.getByRole('button', { name: 'List' }));
    const rows = screen.getAllByTestId('board-list-row');
    const alphaRow = rows.find((r) => r.textContent?.includes('Alpha Cooler')) as HTMLElement;
    const betaRow = rows.find((r) => r.textContent?.includes('Beta Freezer')) as HTMLElement;
    // With a code: the name takes one line and the code the second.
    expect(within(alphaRow).getByTestId('board-list-code')).toHaveTextContent('FG-2026-014');
    expect(within(alphaRow).getByRole('link', { name: 'Alpha Cooler' })).toHaveClass('line-clamp-1');
    // Without a code: two lines for the name.
    expect(within(betaRow).queryByTestId('board-list-code')).not.toBeInTheDocument();
    expect(within(betaRow).getByRole('link', { name: 'Beta Freezer' })).toHaveClass('line-clamp-2');
    // P59: the row shows the set priority P2; the calculated band is its tooltip.
    const pill = within(betaRow).getByTestId('board-list-priority');
    expect(pill).toHaveTextContent(/^P2$/);
    expect(within(pill).getByTitle(/Calculated from score: P1 \(capacity fill; score band P2\)$/)).toBeInTheDocument();
  });

  it('list layout has no serious/critical axe violations', async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<PriorityBoardPage />);
    await screen.findByRole('link', { name: 'Alpha Cooler' });
    await user.click(screen.getByRole('button', { name: 'List' }));
    expect(await seriousAxeViolations(container)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// P36 (ADR 0050, API_CONTRACT_P36): reorder inside a priority column.
// ---------------------------------------------------------------------------

function rankPreview(id: string): PriorityPreviewResponse {
  return { ...boardPreview('P1'), project_id: id, from_priority: 'P1', to_priority: 'P1' };
}

const RANKED_BOARD = board({
  P1: [
    card('a', { name: 'Ann Cooler', band_rank: 1 }),
    card('b', { name: 'Bob Cooler', band_rank: 2 }),
    card('c', { name: 'Cid Cooler', band_rank: 3 }),
  ],
  P2: [card('x', { name: 'Xen Freezer', band_rank: 1 })],
});

function p1Names(): string[] {
  return within(column('P1'))
    .getAllByRole('link', { hidden: true })
    .map((l) => l.textContent ?? '');
}

describe('PriorityBoardPage — P36 reorder within a column', () => {
  beforeEach(() => {
    localStorage.clear();
    client.apiGet.mockImplementation((path: string) => {
      if (path === '/priority-board') return Promise.resolve(RANKED_BOARD);
      if (path === '/dashboard/projects/facets') return Promise.resolve(FACETS);
      return Promise.reject(new Error(`unexpected GET ${path}`));
    });
    move.previewProjectBandRank.mockImplementation((id: string) => Promise.resolve(rankPreview(id)));
  });

  it('shows the served band_rank as #n on every card and the frozen badge', async () => {
    client.apiGet.mockImplementation((path: string) =>
      path === '/priority-board' ? Promise.resolve(DEFAULT_BOARD) : Promise.resolve(FACETS),
    );
    renderWithProviders(<PriorityBoardPage />);
    await screen.findByRole('link', { name: 'Alpha Cooler' });
    // A session that may re-rank gets the served band_rank as an editable field (owner request 2026-11-17).
    expect(within(cardEl('Gated Cooler')).getByTestId('board-rank-input')).toHaveValue('1');
    expect(within(cardEl('Alpha Cooler')).getByTestId('board-rank-input')).toHaveValue('2');
    expect(within(cardEl('Alpha Cooler')).getByRole('textbox', { name: /^Position of Alpha Cooler in R&D-Greece · P1\./ })).toBeInTheDocument();
    expect(within(cardEl('Beta Freezer')).getByTestId('board-frozen-badge')).toHaveTextContent('Frozen');
    expect(within(cardEl('Alpha Cooler')).queryByTestId('board-frozen-badge')).not.toBeInTheDocument();
  });

  it('pointer: dropping above a card previews before_project_id = that card; Yes confirms with the token and follows the run', async () => {
    move.moveProjectBandRank.mockResolvedValue(response({ project_id: 'c', priority_before: 'P1', priority_after: 'P1' }));
    const user = userEvent.setup();
    renderWithProviders(<PriorityBoardPage />);
    await screen.findByRole('link', { name: 'Cid Cooler' });

    rankDrop('Cid Cooler', 'Bob Cooler', 'above', { drop: false });
    // The drop line sits above Bob; the column itself is not highlighted as a cross-column target.
    const line = within(slotOf('Bob Cooler')).getByTestId('board-drop-indicator');
    expect(line).toHaveAttribute('data-edge', 'top');
    expect(column('P1')).not.toHaveAttribute('data-drop-target');
    dragAt('drop', slotOf('Bob Cooler'), 10);

    expect(move.previewProjectBandRank).toHaveBeenCalledWith(
      'c',
      { before_project_id: 'b', after_project_id: null },
      expect.anything(),
    );
    expect(move.previewProjectPriority).not.toHaveBeenCalled();
    // Optimistic: Cid now shows between Ann and Bob, pending; the served count is unchanged.
    expect(p1Names()).toEqual(['Ann Cooler', 'Cid Cooler', 'Bob Cooler']);
    expect(cardEl('Cid Cooler')).toHaveAttribute('data-pending', 'true');
    expect(within(column('P1')).getByTestId('board-column-count')).toHaveTextContent('3');

    const dialog = await screen.findByRole('dialog', { name: 'Move Cid Cooler to position 2 in P1?' });
    expect(dialog).toHaveTextContent('Cid Cooler (now position 3) moves to position 2 in P1; its priority stays P1.');
    await clickYes(user, dialog);
    expect(move.moveProjectBandRank).toHaveBeenCalledWith('c', { before_project_id: 'b', after_project_id: null }, 'tok-b');
    expect(move.moveProjectPriority).not.toHaveBeenCalled();
    await waitFor(() => expect(sse.streamSolverProgress).toHaveBeenCalledWith('run-43', expect.any(Function), expect.any(AbortSignal)));
    const panel = await screen.findByTestId('priority-move-panel');
    expect(await within(panel).findByRole('heading', { name: 'Timeline updated' })).toBeInTheDocument();
    expect(panel).toHaveTextContent('moved to position 2 in P1');
    expect(panel).not.toHaveTextContent(/ of \d/);
    await waitFor(() => expect(client.apiGet.mock.calls.filter(([p]) => p === '/priority-board').length).toBeGreaterThan(1));
  });

  it('pointer: dropping below the last visible card sends after_project_id = that card', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PriorityBoardPage />);
    await screen.findByRole('link', { name: 'Ann Cooler' });
    rankDrop('Ann Cooler', 'Cid Cooler', 'below');
    expect(move.previewProjectBandRank).toHaveBeenCalledWith(
      'a',
      { before_project_id: null, after_project_id: 'c' },
      expect.anything(),
    );
    expect(p1Names()).toEqual(['Bob Cooler', 'Cid Cooler', 'Ann Cooler']);
    const dialog = await screen.findByRole('dialog', { name: 'Move Ann Cooler to position 3 in P1?' });
    await user.click(within(dialog).getByRole('button', { name: 'No, cancel' }));
  });

  it('pointer: a drop right above or below the dragged card itself is no move', async () => {
    renderWithProviders(<PriorityBoardPage />);
    await screen.findByRole('link', { name: 'Bob Cooler' });
    rankDrop('Bob Cooler', 'Ann Cooler', 'below', { drop: false });
    expect(screen.queryByTestId('board-drop-indicator')).not.toBeInTheDocument();
    dragAt('drop', slotOf('Ann Cooler'), 90);
    rankDrop('Bob Cooler', 'Bob Cooler', 'above');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(move.previewProjectBandRank).not.toHaveBeenCalled();
  });

  it('filtered board: anchors are visible cards; the position comes from their served band_rank', async () => {
    const filtered = board({
      P1: [
        card('a', { name: 'Ann Cooler', band_rank: 1 }),
        card('e', { name: 'Eve Cooler', band_rank: 5 }),
        card('i', { name: 'Ida Cooler', band_rank: 9 }),
      ],
    });
    client.apiGet.mockImplementation((path: string, opts?: { query?: Record<string, unknown> }) => {
      if (path === '/priority-board') return Promise.resolve(opts?.query?.q ? filtered : RANKED_BOARD);
      return Promise.resolve(FACETS);
    });
    const user = userEvent.setup();
    renderWithProviders(<PriorityBoardPage />);
    await screen.findByRole('link', { name: 'Ann Cooler' });
    await user.type(screen.getByRole('searchbox', { name: 'Search' }), 'cooler');
    await screen.findByRole('link', { name: 'Ida Cooler' });

    // Ida (#9) above Eve (#5): before Eve → position 5 in the full band.
    rankDrop('Ida Cooler', 'Eve Cooler', 'above');
    expect(move.previewProjectBandRank).toHaveBeenLastCalledWith(
      'i',
      { before_project_id: 'e', after_project_id: null },
      expect.anything(),
    );
    let dialog = await screen.findByRole('dialog', { name: 'Move Ida Cooler to position 5 in P1?' });
    // Never "of n" (P36-R02).
    expect(dialog).toHaveTextContent('moves to position 5 in P1;');
    await user.click(within(dialog).getByRole('button', { name: 'No, cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    // Ann (#1) below the last visible card (Ida #9): after Ida → position 9, never past hidden cards.
    rankDrop('Ann Cooler', 'Ida Cooler', 'below');
    expect(move.previewProjectBandRank).toHaveBeenLastCalledWith(
      'a',
      { before_project_id: null, after_project_id: 'i' },
      expect.anything(),
    );
    dialog = await screen.findByRole('dialog', { name: 'Move Ann Cooler to position 9 in P1?' });
    await user.click(within(dialog).getByRole('button', { name: 'No, cancel' }));
  });

  it('P36-R02 (W36-1): hub filter + hub-scoped Hub Planner — the scoped count (2) is smaller than the rank (24); no "of" anywhere', async () => {
    // A Hub Planner with the Greece hub selected: the server serves only the
    // in-scope part of P1 (count 2) while band_rank is the full-band position.
    const scoped = board({
      P1: [
        card('k', { name: 'Kai Cooler', band_rank: 21 }),
        card('m', { name: 'Mia Cooler', band_rank: 24 }),
      ],
    });
    expect(scoped.columns[0]?.count).toBe(2);
    useHubFilterStore.setState({ hubId: 'hub-gr', region: null });
    client.apiGet.mockImplementation((path: string, opts?: { query?: Record<string, unknown> }) => {
      if (path === '/priority-board') return Promise.resolve(String(opts?.query?.hub_id) === 'hub-gr' ? scoped : RANKED_BOARD);
      if (path === '/hubs') return Promise.resolve([]);
      return Promise.resolve(FACETS);
    });
    move.moveProjectBandRank.mockResolvedValue(
      response({ project_id: 'm', priority_before: 'P1', priority_after: 'P1', recalc_status: 'applied', task_id: null }),
    );
    const noCount = / of \d/;
    const user = userEvent.setup();
    renderWithProviders(<PriorityBoardPage />, { session: { permissions: ROLE_MATRIX['Hub Planner'] } });
    await screen.findByRole('link', { name: 'Mia Cooler' });
    expect(client.apiGet).toHaveBeenCalledWith('/priority-board', expect.objectContaining({ query: expect.objectContaining({ hub_id: ['hub-gr'] }) }));
    expect(within(column('P1')).getByTestId('board-column-count')).toHaveTextContent('2');
    const announcer = screen.getByTestId('board-announcer');

    // Keyboard: pick up Mia (#24), Up to above Kai (#21).
    within(cardEl('Mia Cooler')).getByTestId('board-drag-handle').focus();
    await user.keyboard(' ');
    expect(announcer).toHaveTextContent('Picked up Mia Cooler in P1, position 24 in P1.');
    expect(announcer).not.toHaveTextContent(noCount);
    await user.keyboard('{ArrowUp}');
    expect(announcer).toHaveTextContent('Position 21 in P1.');
    expect(announcer).not.toHaveTextContent(noCount);
    await user.keyboard('{ArrowRight}{ArrowLeft}');
    expect(announcer).toHaveTextContent('Over P1, its current column: position 21 in P1.');
    expect(announcer).not.toHaveTextContent(noCount);
    await user.keyboard(' ');
    expect(move.previewProjectBandRank).toHaveBeenCalledWith('m', { hub_rank: 21 }, expect.anything());
    expect(announcer).toHaveTextContent('Mia Cooler dropped at position 21 in R&D-Greece · P1. Confirm the move.');

    // Dialog: title, summary and the applied result.
    const dialog = await screen.findByRole('dialog', { name: 'Move Mia Cooler to position 21 in R&D-Greece · P1?' });
    expect(dialog).toHaveTextContent('Mia Cooler (now position 24) moves to position 21 in R&D-Greece · P1; its priority stays P1.');
    expect(dialog).not.toHaveTextContent(noCount);
    await clickYes(user, dialog);
    const done = await screen.findByRole('dialog', { name: 'Moved to position 21 in R&D-Greece · P1' });
    expect(done).not.toHaveTextContent(noCount);
    expect(announcer).toHaveTextContent('Mia Cooler moved to position 21 in R&D-Greece · P1.');
    expect(announcer).not.toHaveTextContent(noCount);
  });

  it('keyboard: Up/Down move the position, announced "position n in P1" (never "of N"); Space drops into the re-rank flow', async () => {
    move.moveProjectBandRank.mockResolvedValue(
      response({ project_id: 'c', priority_before: 'P1', priority_after: 'P1', recalc_status: 'applied', task_id: null }),
    );
    const user = userEvent.setup();
    renderWithProviders(<PriorityBoardPage />);
    await screen.findByRole('link', { name: 'Cid Cooler' });
    const handle = within(cardEl('Cid Cooler')).getByRole('button', { name: 'Move Cid Cooler within or between priority columns' });
    handle.focus();
    await user.keyboard(' ');
    expect(screen.getByTestId('board-announcer')).toHaveTextContent('Picked up Cid Cooler in P1, position 3 in P1.');
    await user.keyboard('{ArrowUp}');
    expect(screen.getByTestId('board-announcer')).toHaveTextContent('Position 2 in P1.');
    expect(within(slotOf('Bob Cooler')).getByTestId('board-drop-indicator')).toBeInTheDocument();
    await user.keyboard('{ArrowUp}{ArrowUp}');
    expect(screen.getByTestId('board-announcer')).toHaveTextContent('Position 1 in P1.');
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(screen.getByTestId('board-announcer')).toHaveTextContent('Position 3 in P1, its current place.');
    expect(screen.queryByTestId('board-drop-indicator')).not.toBeInTheDocument();
    await user.keyboard('{Home}');
    expect(screen.getByTestId('board-announcer')).toHaveTextContent('Position 1 in P1.');
    await user.keyboard(' ');
    expect(move.previewProjectBandRank).toHaveBeenCalledWith(
      'c',
      { before_project_id: 'a', after_project_id: null },
      expect.anything(),
    );
    const dialog = await screen.findByRole('dialog', { name: 'Move Cid Cooler to position 1 in P1?' });
    await clickYes(user, dialog);
    expect(await screen.findByRole('dialog', { name: 'Moved to position 1 in P1' })).toHaveTextContent(
      'Position changed and the timeline recalculated.',
    );
    expect(screen.getByTestId('board-announcer')).toHaveTextContent('Cid Cooler moved to position 1 in P1.');
  });

  it('keyboard: Left/Right still choose a column (the card goes last there); Up/Down there do nothing', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PriorityBoardPage />);
    await screen.findByRole('link', { name: 'Ann Cooler' });
    within(cardEl('Ann Cooler')).getByTestId('board-drag-handle').focus();
    await user.keyboard(' {ArrowRight}');
    expect(screen.getByTestId('board-announcer')).toHaveTextContent('Over P2. It would go last there.');
    await user.keyboard('{ArrowDown}');
    expect(screen.getByTestId('board-announcer')).toHaveTextContent('Up and down change the position in P1 only.');
    await user.keyboard(' ');
    const dialog = await screen.findByRole('dialog', { name: 'Move to P2?' });
    expect(move.previewProjectPriority).toHaveBeenCalledWith('a', 'P2', expect.anything());
    expect(move.previewProjectBandRank).not.toHaveBeenCalled();
    // Cross-column: the optimistic card is shown last in P2, where the server will put it.
    const p2 = within(column('P2')).getAllByRole('link', { hidden: true }).map((l) => l.textContent);
    expect(p2).toEqual(['Xen Freezer', 'Ann Cooler']);
    expect(dialog).toHaveTextContent('Ann Cooler moves from P1 to P2, last in P2.');
  });

  it('P36-R03: 503 BAND_RANK_BUSY on a re-rank confirm shows the contract copy, rolls back, never retries', async () => {
    move.moveProjectBandRank.mockRejectedValue(
      new ApiError(503, 'Service Unavailable', 'Another priority change is being saved. Please try again in a moment.', 'BAND_RANK_BUSY', 5),
    );
    const user = userEvent.setup();
    renderWithProviders(<PriorityBoardPage />);
    await screen.findByRole('link', { name: 'Cid Cooler' });
    rankDrop('Cid Cooler', 'Ann Cooler', 'above');
    const dialog = await screen.findByRole('dialog', { name: 'Move Cid Cooler to position 1 in P1?' });
    await clickYes(user, dialog);
    expect(await screen.findByTestId('preview-error')).toHaveTextContent(
      'Another priority change is being saved. Please try again in a moment.',
    );
    expect(move.moveProjectBandRank).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(p1Names()).toEqual(['Ann Cooler', 'Bob Cooler', 'Cid Cooler']));
    expect(move.moveProjectBandRank).toHaveBeenCalledTimes(1);
  });

  it('No on the preview rolls the order back without a write', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PriorityBoardPage />);
    await screen.findByRole('link', { name: 'Cid Cooler' });
    rankDrop('Cid Cooler', 'Ann Cooler', 'above');
    expect(p1Names()).toEqual(['Cid Cooler', 'Ann Cooler', 'Bob Cooler']);
    const dialog = await screen.findByRole('dialog', { name: 'Move Cid Cooler to position 1 in P1?' });
    await user.click(within(dialog).getByRole('button', { name: 'No, cancel' }));
    await waitFor(() => expect(p1Names()).toEqual(['Ann Cooler', 'Bob Cooler', 'Cid Cooler']));
    expect(cardEl('Cid Cooler')).not.toHaveAttribute('data-pending');
    expect(move.moveProjectBandRank).not.toHaveBeenCalled();
    expect(screen.getByTestId('board-announcer')).toHaveTextContent('Move cancelled. Cid Cooler keeps its place in P1.');
  });

  it('a refused re-rank (422 NOT_SAME_BAND) rolls back with honest copy', async () => {
    move.previewProjectBandRank.mockRejectedValue(new ApiError(422, 'Unprocessable', 'anchor', 'NOT_SAME_BAND'));
    const user = userEvent.setup();
    renderWithProviders(<PriorityBoardPage />);
    await screen.findByRole('link', { name: 'Cid Cooler' });
    rankDrop('Cid Cooler', 'Ann Cooler', 'above');
    expect(await screen.findByTestId('preview-error')).toHaveTextContent('The board changed since you moved the card');
    expect(screen.getByRole('dialog', { name: 'Position not changed' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(p1Names()).toEqual(['Ann Cooler', 'Bob Cooler', 'Cid Cooler']));
    expect(screen.getByTestId('board-announcer')).toHaveTextContent('Cid Cooler was not moved.');
  });

  it('409 PREVIEW_STALE on Yes re-previews once with the same placement, then confirms the fresh token', async () => {
    move.previewProjectBandRank
      .mockResolvedValueOnce(rankPreview('c'))
      .mockResolvedValueOnce({ ...rankPreview('c'), preview_token: 'tok-fresh' });
    move.moveProjectBandRank
      .mockRejectedValueOnce(new ApiError(409, 'Conflict', 'stale', 'PREVIEW_STALE'))
      .mockResolvedValueOnce(response({ project_id: 'c', priority_before: 'P1', priority_after: 'P1', recalc_status: 'applied', task_id: null }));
    const user = userEvent.setup();
    renderWithProviders(<PriorityBoardPage />);
    await screen.findByRole('link', { name: 'Cid Cooler' });
    rankDrop('Cid Cooler', 'Ann Cooler', 'above');
    let dialog = await screen.findByRole('dialog', { name: 'Move Cid Cooler to position 1 in P1?' });
    await clickYes(user, dialog);
    expect(await screen.findByTestId('preview-refreshed')).toBeInTheDocument();
    expect(move.previewProjectBandRank).toHaveBeenCalledTimes(2);
    expect(move.previewProjectBandRank).toHaveBeenLastCalledWith(
      'c',
      { before_project_id: 'a', after_project_id: null },
      expect.anything(),
    );
    // Still pending in its dropped place while the user decides again.
    expect(cardEl('Cid Cooler')).toHaveAttribute('data-pending', 'true');
    dialog = screen.getByRole('dialog', { name: 'Move Cid Cooler to position 1 in P1?' });
    await clickYes(user, dialog);
    expect(move.moveProjectBandRank).toHaveBeenLastCalledWith('c', { before_project_id: 'a', after_project_id: null }, 'tok-fresh');
    expect(await screen.findByRole('dialog', { name: 'Moved to position 1 in P1' })).toBeInTheDocument();
  });

  it('List layout: a row dropped above another row re-ranks through the same flow; rows show band_rank', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PriorityBoardPage />);
    await screen.findByRole('link', { name: 'Ann Cooler' });
    await user.click(screen.getByRole('button', { name: 'List' }));
    const ranks = within(column('P1')).getAllByTestId('board-rank-input').map((r) => (r as HTMLInputElement).value);
    expect(ranks).toEqual(['1', '2', '3']);
    rankDrop('Bob Cooler', 'Ann Cooler', 'above');
    expect(move.previewProjectBandRank).toHaveBeenCalledWith(
      'b',
      { before_project_id: 'a', after_project_id: null },
      expect.anything(),
    );
    expect(await screen.findByRole('dialog', { name: 'Move Bob Cooler to position 1 in P1?' })).toBeInTheDocument();
  });

  it('read-only roles see the order (#n) but no handles and no drop line', async () => {
    renderWithProviders(<PriorityBoardPage />, { session: { permissions: ROLE_MATRIX['Executive Viewer'] } });
    await screen.findByRole('link', { name: 'Ann Cooler' });
    expect(screen.queryAllByTestId('board-drag-handle')).toHaveLength(0);
    expect(within(column('P1')).getAllByTestId('board-rank-chip').map((c) => c.textContent)).toEqual([
      '#1Position 1 in R&D-Greece · P1',
      '#2Position 2 in R&D-Greece · P1',
      '#3Position 3 in R&D-Greece · P1',
    ]);
    rankDrop('Cid Cooler', 'Ann Cooler', 'above', { drop: false });
    expect(screen.queryByTestId('board-drop-indicator')).not.toBeInTheDocument();
    dragAt('drop', slotOf('Ann Cooler'), 10);
    expect(move.previewProjectBandRank).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('has no serious/critical axe violations with the rank chips, frozen badge and a drop line shown', async () => {
    client.apiGet.mockImplementation((path: string) =>
      path === '/priority-board'
        ? Promise.resolve(board({ P1: [card('a', { name: 'Ann Cooler', band_rank: 1, frozen: true }), card('b', { name: 'Bob Cooler', band_rank: 2 })] }))
        : Promise.resolve(FACETS),
    );
    const { container } = renderWithProviders(<PriorityBoardPage />);
    await screen.findByRole('link', { name: 'Bob Cooler' });
    rankDrop('Bob Cooler', 'Ann Cooler', 'above', { drop: false });
    expect(screen.getByTestId('board-drop-indicator')).toBeInTheDocument();
    expect(await seriousAxeViolations(container)).toEqual([]);
  });
});

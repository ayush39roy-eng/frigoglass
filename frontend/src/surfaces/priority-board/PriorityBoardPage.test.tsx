import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useLocation } from 'react-router-dom';

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
const move = { moveProjectPriority: vi.fn(), fetchScheduleRunChanges: vi.fn(), previewProjectPriority: vi.fn() };
vi.mock('@/lib/api/priority-move', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/priority-move')>('@/lib/api/priority-move');
  return {
    ...actual,
    moveProjectPriority: (...a: unknown[]) => move.moveProjectPriority(...a),
    fetchScheduleRunChanges: (...a: unknown[]) => move.fetchScheduleRunChanges(...a),
    previewProjectPriority: (...a: unknown[]) => move.previewProjectPriority(...a),
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
    ...overrides,
  };
}

function board(cols: Partial<Record<ProjectPriority, PriorityBoardCard[]>>): PriorityBoardResponse {
  return {
    run_id: 'run-42',
    columns: (['P1', 'P2', 'P3', 'P4', 'Q'] as const).map((p) => ({
      priority: p,
      count: cols[p]?.length ?? 0,
      // P13-T12: served per-column remaining weeks (illustrative values).
      design_weeks: p === 'P1' ? 926 : p === 'Q' ? 310.5 : 0,
      lab_weeks: p === 'P1' ? 907 : p === 'Q' ? 308 : 0,
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
  useHubFilterStore.setState({ hubId: null, region: null });
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
    expect(client.apiGet).toHaveBeenCalledWith('/priority-board', expect.objectContaining({ query: { hub_id: undefined } }));
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
    // P25-T04: the served suggested band is shown beside the served weighted score, as the grid's chip.
    expect(within(within(cardEl('Alpha Cooler')).getByTestId('board-card-band')).getByTitle(/Priority band P1/)).toBeInTheDocument();
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

describe('PriorityBoardPage — P13-T12 weeks and toolbar', () => {
  it('each column header shows the served remaining design / lab weeks', async () => {
    renderWithProviders(<PriorityBoardPage />);
    await screen.findByRole('link', { name: 'Alpha Cooler' });
    expect(within(column('P1')).getByTestId('board-column-weeks')).toHaveTextContent('Remaining D 926 w · L 907 w');
    expect(within(column('Q')).getByTestId('board-column-weeks')).toHaveTextContent('Remaining D 310.5 w · L 308 w');
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
    useHubFilterStore.setState({ hubId: null, region: 'India' });
    const user = userEvent.setup();
    renderWithProviders(<PriorityBoardPage />);
    await screen.findByRole('link', { name: 'Alpha Cooler' });
    await user.click(screen.getByRole('combobox', { name: 'Category' }));
    await user.click(await screen.findByRole('option', { name: 'B' }));
    await user.click(screen.getByRole('combobox', { name: 'Type' }));
    await user.click(await screen.findByRole('option', { name: /^CO ·/ }));
    await user.click(screen.getByRole('combobox', { name: 'Status' }));
    await user.click(await screen.findByRole('option', { name: 'In Queue' }));
    await user.click(screen.getByRole('combobox', { name: 'Leader' }));
    await user.click(await screen.findByRole('option', { name: 'Rishi' }));
    // The last BOARD request carries every filter. (Not the last GET of any
    // path: under a loaded runner a facets fetch can land after it.)
    await waitFor(
      () => {
        const boardCalls = client.apiGet.mock.calls.filter(([p]) => p === '/priority-board');
        expect(boardCalls[boardCalls.length - 1]?.[1]).toEqual(
          expect.objectContaining({
            query: expect.objectContaining({
              region: 'India',
              category: 'B',
              type: 'CO',
              status_: 'In Queue',
              leader_engineer_id: 'eng-self-0001',
            }),
          }),
        );
      },
      { timeout: 5_000 },
    );
    expect(client.apiGet).toHaveBeenCalledWith('/dashboard/projects/facets', expect.objectContaining({ query: { hub_id: undefined, region: 'India' } }));
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
    expect(design).toHaveTextContent('587 / 252.62 wks (232.36 %)');
    expect(screen.getByTestId('hub-load-PD-India-lab')).toHaveTextContent('496.5 / 186.22 wks (266.62 %)');
  });

  it('ADR 0028: a leader id with no name is offered as "Name unavailable"', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PriorityBoardPage />);
    await screen.findByRole('link', { name: 'Alpha Cooler' });
    await user.click(screen.getByRole('combobox', { name: 'Leader' }));
    const options = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(options).toEqual(['All', 'Rishi', 'Name unavailable · 9f3c']);
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
    // Names only, plus the same suggested-band chip as the grid ("P1").
    expect(alpha).toHaveTextContent(/^2Alpha CoolerP1$/);
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
    const handle = within(row).getByRole('button', { name: 'Move Alpha Cooler to another priority column' });
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
    // Card: the promoted chip, the score band as secondary text (it differs), the reason in the tooltip.
    const beta = within(cardEl('Beta Freezer'));
    expect(beta.getByTestId('band-chip-capacity-fill')).toHaveTextContent('P1 · capacity fill');
    expect(beta.getByTestId('band-chip-score-band')).toHaveTextContent('score band P2');
    await user.hover(beta.getByRole('button', { name: 'Suggested band P1 by capacity fill, score band P2' }));
    expect((await screen.findAllByText(reason)).length).toBeGreaterThan(0);
    // A base P1 card: plain chip, no score-band line (it equals the suggested band).
    expect(within(cardEl('Alpha Cooler')).queryByTestId('band-chip-score-band')).not.toBeInTheDocument();

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
    // Dense chip: "P1" with the fill outline; the full label stays the accessible name.
    const dense = within(betaRow).getByRole('button', { name: 'Suggested band P1 by capacity fill, score band P2' });
    expect(dense).toHaveTextContent(/^P1$/);
  });

  it('list layout has no serious/critical axe violations', async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(<PriorityBoardPage />);
    await screen.findByRole('link', { name: 'Alpha Cooler' });
    await user.click(screen.getByRole('button', { name: 'List' }));
    expect(await seriousAxeViolations(container)).toEqual([]);
  });
});

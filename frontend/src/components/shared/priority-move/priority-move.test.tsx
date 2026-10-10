import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ApiError } from '@/lib/api/client';
import type { PriorityMoveResponse, ScheduleRunChanges } from '@/lib/api/priority-move';
import { renderWithProviders } from '@/test/render';
import { ROLE_MATRIX } from '@/test/roles';
import { seriousAxeViolations } from '@/test/axe';

const api = { moveProjectPriority: vi.fn(), fetchScheduleRunChanges: vi.fn() };
vi.mock('@/lib/api/priority-move', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/priority-move')>('@/lib/api/priority-move');
  return {
    ...actual,
    moveProjectPriority: (...a: unknown[]) => api.moveProjectPriority(...a),
    fetchScheduleRunChanges: (...a: unknown[]) => api.fetchScheduleRunChanges(...a),
  };
});
const sse = { streamSolverProgress: vi.fn() };
vi.mock('@/lib/api/sse', () => ({
  streamSolverProgress: (...a: unknown[]) => sse.streamSolverProgress(...a),
}));

// ADR 0023: `deferred` starts the shared follow-up watcher (tested on its own
// in lib/use-follow-up-run.test.tsx); here only that it is started.
const followUp = { start: vi.fn() };
vi.mock('@/lib/use-follow-up-run', () => ({
  useFollowUpRunWatcher: () => ({ start: followUp.start, watching: followUp.start.mock.calls.length > 0 }),
}));

import { PriorityMoveControl } from './priority-move-control';
import { usePriorityMoveHost } from './priority-move-context';
import { PriorityMoveProvider } from './priority-move-provider';

function response(overrides: Partial<PriorityMoveResponse> = {}): PriorityMoveResponse {
  return {
    project_id: 'p1',
    priority_before: 'P1',
    priority_after: 'P2',
    recalc_status: 'queued',
    schedule_run_id: 'run-43',
    baseline_run_id: 'run-42',
    task_id: 'task-1',
    ...overrides,
  };
}

const changes: ScheduleRunChanges = {
  run_id: 'run-43',
  run_version: 43,
  against_run_id: 'run-42',
  against_run_version: 42,
  hidden_count: 3,
  rows: [
    {
      project_id: 'p1', project_name: 'Cooler One', hub: 'PD-India', priority: 'P2',
      before_projected_end_week: 40, after_projected_end_week: 46, delta_weeks: 6,
      before_within_year: true, after_within_year: true, before_left_out: false, after_left_out: false,
      before_blocked: false, after_blocked: false, is_new: false, is_removed: false,
    },
    {
      project_id: 'p2', project_name: 'Freezer Two', hub: 'R&D-India', priority: 'P1',
      before_projected_end_week: 55, after_projected_end_week: 50, delta_weeks: -5,
      before_within_year: false, after_within_year: true, before_left_out: false, after_left_out: false,
      before_blocked: false, after_blocked: false, is_new: false, is_removed: false,
    },
  ],
};

function renderControl(options?: Parameters<typeof renderWithProviders>[1], status?: string) {
  return renderWithProviders(
    <PriorityMoveProvider>
      <PriorityMoveControl projectId="p1" projectName="Cooler One" priority="P1" status={status} />
    </PriorityMoveProvider>,
    options,
  );
}

async function chooseP2(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /Priority P1 for Cooler One\. Change priority/ }));
  await user.click(await screen.findByRole('menuitemradio', { name: /Priority band P2/ }));
  const dialog = await screen.findByRole('dialog', { name: 'Move to P2?' });
  expect(within(dialog).getByText(/The timeline will be recalculated/)).toBeInTheDocument();
  await user.click(within(dialog).getByRole('button', { name: 'Move to P2' }));
}

beforeEach(() => {
  vi.clearAllMocks();
  sse.streamSolverProgress.mockImplementation(async (id: string, onEvent: (e: unknown) => void) => {
    onEvent({ schedule_run_id: id, status: 'running', percent: 50 });
    return { schedule_run_id: id, status: 'completed' };
  });
  api.fetchScheduleRunChanges.mockResolvedValue(changes);
});

describe('PriorityMoveControl — gating', () => {
  it('without project_registration.write it is the read-only pill (no dropdown)', () => {
    renderControl({ session: { permissions: ROLE_MATRIX['Executive Viewer'] } });
    expect(screen.queryByTestId('priority-move-trigger')).not.toBeInTheDocument();
    expect(screen.getByText('P1')).toBeInTheDocument();
  });

  it('a Gantt-write-only role (Engineer) also gets the read-only pill', () => {
    renderControl({ session: { permissions: ROLE_MATRIX.Engineer } });
    expect(screen.queryByTestId('priority-move-trigger')).not.toBeInTheDocument();
  });

  it('outside a provider it falls back to the read-only pill', () => {
    renderWithProviders(<PriorityMoveControl projectId="p1" projectName="Cooler One" priority="P3" />);
    expect(screen.queryByTestId('priority-move-trigger')).not.toBeInTheDocument();
    expect(screen.getByText('P3')).toBeInTheDocument();
  });

  it('with Registration write (Hub Planner) it is a dropdown', () => {
    renderControl({ session: { permissions: ROLE_MATRIX['Hub Planner'] } });
    expect(screen.getByTestId('priority-move-trigger')).toBeInTheDocument();
  });
});

describe('PriorityMoveControl — recalc_status outcomes', () => {
  it('queued: POSTs, follows the SSE run, then shows "Timeline updated" from the served changes', async () => {
    api.moveProjectPriority.mockResolvedValue(response());
    const user = userEvent.setup();
    renderControl();
    await chooseP2(user);

    expect(api.moveProjectPriority).toHaveBeenCalledWith('p1', 'P2');
    await waitFor(() => expect(sse.streamSolverProgress).toHaveBeenCalledWith('run-43', expect.any(Function), expect.any(AbortSignal)));
    const panel = await screen.findByTestId('priority-move-panel');
    expect(await within(panel).findByRole('heading', { name: 'Timeline updated' })).toBeInTheDocument();
    await waitFor(() => expect(api.fetchScheduleRunChanges).toHaveBeenCalledWith('run-43', 'run-42', expect.anything()));

    const own = await within(panel).findByTestId('timeline-own-change');
    expect(own).toHaveTextContent('W40');
    expect(own).toHaveTextContent('W46');
    expect(own).toHaveTextContent('+6 wk');
    const rows = within(panel).getAllByTestId('timeline-change-row');
    // The moved project is shown on its own, not repeated in "other projects".
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('Freezer Two');
    expect(within(panel).getByTestId('timeline-hidden-count')).toHaveTextContent('+3 more in hubs outside your scope');
  });

  it('deferred: says the timeline updates automatically and watches for the follow-up run (ADR 0023)', async () => {
    followUp.start.mockClear();
    api.moveProjectPriority.mockResolvedValue(response({ recalc_status: 'deferred', schedule_run_id: null, baseline_run_id: null, task_id: null }));
    const user = userEvent.setup();
    renderControl();
    await chooseP2(user);
    expect(await screen.findByTestId('priority-move-notice')).toHaveTextContent(
      'Saved — the timeline updates automatically after the current recalculation',
    );
    expect(followUp.start).toHaveBeenCalledTimes(1);
    expect(sse.streamSolverProgress).not.toHaveBeenCalled();
  });

  it('not_needed: says the project is not in the plan, naming its status', async () => {
    api.moveProjectPriority.mockResolvedValue(response({ recalc_status: 'not_needed', schedule_run_id: null, baseline_run_id: null, task_id: null }));
    const user = userEvent.setup();
    renderControl(undefined, 'On Hold');
    await chooseP2(user);
    expect(await screen.findByTestId('priority-move-notice')).toHaveTextContent(
      "Saved. This project isn't in the plan (status On Hold), so no timeline change.",
    );
    expect(sse.streamSolverProgress).not.toHaveBeenCalled();
  });

  it('unchanged: no panel, no stream', async () => {
    api.moveProjectPriority.mockResolvedValue(response({ recalc_status: 'unchanged', schedule_run_id: null, baseline_run_id: null, task_id: null }));
    const user = userEvent.setup();
    renderControl();
    await chooseP2(user);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Move to P2?' })).not.toBeInTheDocument());
    expect(screen.queryByTestId('priority-move-panel')).not.toBeInTheDocument();
    expect(sse.streamSolverProgress).not.toHaveBeenCalled();
  });

  it('409 HARD_GATE_FORCES_P1: explains the hard gate', async () => {
    api.moveProjectPriority.mockRejectedValue(new ApiError(409, 'conflict', 'hard gates', 'HARD_GATE_FORCES_P1'));
    const user = userEvent.setup();
    renderControl();
    await chooseP2(user);
    expect(await screen.findByTestId('priority-move-notice')).toHaveTextContent(
      'This project has a hard gate (regulatory / certification / safety), so it must stay P1.',
    );
    expect(screen.getByRole('heading', { name: 'Priority not changed' })).toBeInTheDocument();
  });

  it('SSE failure: shows it and says the timeline stays stale', async () => {
    api.moveProjectPriority.mockResolvedValue(response());
    sse.streamSolverProgress.mockRejectedValue(new ApiError(0, 'Network request failed — the API is unreachable.'));
    const user = userEvent.setup();
    renderControl();
    await chooseP2(user);
    const notice = await screen.findByTestId('priority-move-notice');
    expect(notice).toHaveTextContent(/marked stale/);
    expect(screen.getByRole('heading', { name: 'Priority saved — timeline not recalculated' })).toBeInTheDocument();
    expect(api.fetchScheduleRunChanges).not.toHaveBeenCalled();
  });

  it('cancel on the confirm step sends nothing', async () => {
    const user = userEvent.setup();
    renderControl();
    await user.click(screen.getByTestId('priority-move-trigger'));
    await user.click(await screen.findByRole('menuitemradio', { name: /Priority band P3/ }));
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(api.moveProjectPriority).not.toHaveBeenCalled();
  });

  it('the "Timeline updated" panel has no serious/critical axe violations', async () => {
    api.moveProjectPriority.mockResolvedValue(response());
    const user = userEvent.setup();
    renderControl();
    await chooseP2(user);
    const panel = await screen.findByTestId('priority-move-panel');
    await within(panel).findByTestId('timeline-own-change');
    expect(await seriousAxeViolations(panel)).toEqual([]);
  });
});

function PatchHarness({ signal }: { signal: Parameters<NonNullable<ReturnType<typeof usePriorityMoveHost>>['followPatch']>[1] }) {
  const host = usePriorityMoveHost();
  return (
    <button
      type="button"
      onClick={() => host?.followPatch({ projectId: 'p1', projectName: 'Cooler One', priority: 'P1', status: 'Draft' }, signal, 'P1', 'P2')}
    >
      Saved
    </button>
  );
}

describe('followPatch (Registration PATCH headers)', () => {
  it('queued from X-Schedule-* headers follows the same run and shows the same panel', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <PriorityMoveProvider>
        <PatchHarness signal={{ recalc_status: 'queued', schedule_run_id: 'run-43', baseline_run_id: 'run-42' }} />
      </PriorityMoveProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Saved' }));
    await waitFor(() => expect(sse.streamSolverProgress).toHaveBeenCalledWith('run-43', expect.any(Function), expect.any(AbortSignal)));
    expect(await screen.findByRole('heading', { name: 'Timeline updated' })).toBeInTheDocument();
    expect(await screen.findByTestId('timeline-hidden-count')).toBeInTheDocument();
  });

  it('not_needed from the headers uses the honest copy', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <PriorityMoveProvider>
        <PatchHarness signal={{ recalc_status: 'not_needed', schedule_run_id: null, baseline_run_id: null }} />
      </PriorityMoveProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Saved' }));
    expect(await screen.findByTestId('priority-move-notice')).toHaveTextContent('(status Draft)');
  });

  it('queued with no baseline run says there is nothing to compare against', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <PriorityMoveProvider>
        <PatchHarness signal={{ recalc_status: 'queued', schedule_run_id: 'run-1', baseline_run_id: null }} />
      </PriorityMoveProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Saved' }));
    expect(await screen.findByText(/no earlier schedule to compare against/)).toBeInTheDocument();
    expect(api.fetchScheduleRunChanges).not.toHaveBeenCalled();
  });
});


import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ApiError } from '@/lib/api/client';
import type { CheckInDueResponse, CheckInDueStage, CheckInSubmitResponse } from '@/lib/api/check-ins';
import { useHubFilterStore } from '@/stores/hub-filter';
import { seriousAxeViolations } from '@/test/axe';
import { renderWithProviders } from '@/test/render';

const client = { apiGet: vi.fn(), apiSend: vi.fn() };
vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return {
    ...actual,
    apiGet: (...a: unknown[]) => client.apiGet(...a),
    apiSend: (...a: unknown[]) => client.apiSend(...a),
  };
});
const move = { fetchScheduleRunChanges: vi.fn() };
vi.mock('@/lib/api/priority-move', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/priority-move')>('@/lib/api/priority-move');
  return { ...actual, fetchScheduleRunChanges: (...a: unknown[]) => move.fetchScheduleRunChanges(...a) };
});
const sse = { streamSolverProgress: vi.fn() };
vi.mock('@/lib/api/sse', () => ({
  streamSolverProgress: (...a: unknown[]) => sse.streamSolverProgress(...a),
}));
const watcher = { start: vi.fn(), watching: true };
vi.mock('@/lib/use-follow-up-run', () => ({
  useFollowUpRunWatcher: () => watcher,
}));

import CheckInPage from './CheckInPage';

function stage(overrides: Partial<CheckInDueStage> = {}): CheckInDueStage {
  return {
    step_id: 'PDD-E',
    step_name: 'Design Detailing',
    kind: 'design',
    status: 'In Progress',
    percent_complete: 40,
    blocked_reason: null,
    planned_start_week: 28,
    planned_end_week: 34,
    plan_percent: 50,
    checked_in_this_week: false,
    last_checkin_week: 30,
    can_check_in: true,
    ...overrides,
  };
}

function due(overrides: Partial<CheckInDueResponse> = {}): CheckInDueResponse {
  return {
    week: 31,
    summary: { due_stages: 3, checked_in_stages: 1, projects_live: 0, projects_due: 1, projects_overdue: 1, stale_projects: 0 },
    projects: [
      {
        project_id: 'p1',
        name: 'Cooler One',
        hub: 'R&D-Greece',
        hub_id: 'hub-gr',
        tracking_status: 'overdue',
        schedule_stale: false,
        stages: [
          stage({ step_id: 'PDD-E', step_name: 'Design Detailing' }),
          stage({ step_id: 'PDD-L', step_name: 'Lab Test', kind: 'lab', status: 'Not Started', percent_complete: 0, plan_percent: 10, last_checkin_week: null }),
        ],
      },
      {
        project_id: 'p2',
        name: 'Freezer Two',
        hub: 'PD-India',
        hub_id: 'hub-in',
        tracking_status: 'due',
        schedule_stale: false,
        stages: [stage({ step_id: 'OEM-A', step_name: 'Assembly', checked_in_this_week: true, last_checkin_week: 31 })],
      },
    ],
    ...overrides,
  };
}

function submitResponse(overrides: Partial<CheckInSubmitResponse> = {}): CheckInSubmitResponse {
  return {
    week: 31,
    accepted: 2,
    projects_marked_stale: ['p1'],
    recalc_status: 'not_needed',
    schedule_run_id: null,
    baseline_run_id: null,
    task_id: null,
    ...overrides,
  };
}

let dueBody: CheckInDueResponse = due();

function stageEl(stepName: string): HTMLElement {
  const heading = screen.getByRole('heading', { name: stepName, level: 4 });
  const el = heading.closest<HTMLElement>('[data-testid="check-in-stage"]');
  if (!el) throw new Error(`no stage ${stepName}`);
  return el;
}

async function renderPage() {
  const user = userEvent.setup();
  const view = renderWithProviders(<CheckInPage />);
  await screen.findByRole('heading', { name: 'Design Detailing', level: 4 });
  return { user, ...view };
}

beforeEach(() => {
  vi.clearAllMocks();
  watcher.watching = true;
  dueBody = due();
  useHubFilterStore.setState({ hubId: null, region: null });
  client.apiGet.mockImplementation((path: string) => {
    if (path === '/check-ins/due') return Promise.resolve(dueBody);
    if (path === '/check-ins/history') {
      return Promise.resolve([
        { week: 30, status: 'Blocked', percent_complete: 30, blocked_reason: 'Waiting for parts', note: 'Supplier late', by: 'Ana Engineer', created_at: '2026-10-01T09:00:00Z' },
      ]);
    }
    return Promise.reject(new Error(`unexpected GET ${path}`));
  });
  client.apiSend.mockResolvedValue(submitResponse());
  sse.streamSolverProgress.mockImplementation(async (id: string) => ({ schedule_run_id: id, status: 'completed' }));
  move.fetchScheduleRunChanges.mockResolvedValue({
    run_id: 'run-43', run_version: 43, against_run_id: 'run-42', against_run_version: 42, hidden_count: 2,
    rows: [
      {
        project_id: 'p1', project_name: 'Cooler One', hub: 'R&D-Greece', priority: 'P1',
        before_projected_end_week: 40, after_projected_end_week: 42, delta_weeks: 2,
        before_within_year: true, after_within_year: true, before_left_out: false, after_left_out: false,
        before_blocked: false, after_blocked: false, is_new: false, is_removed: false,
      },
    ],
  });
});

describe('CheckInPage — served display', () => {
  it('shows the served summary, per-plan %, last check-in, checked-in-this-week and tracking chips', async () => {
    await renderPage();
    expect(client.apiGet).toHaveBeenCalledWith('/check-ins/due', expect.objectContaining({ query: { hub_id: undefined } }));
    expect(screen.getByTestId('check-in-week')).toHaveTextContent('W31');
    expect(screen.getByTestId('summary-due-stages')).toHaveTextContent('3');
    expect(screen.getByTestId('summary-checked-in')).toHaveTextContent('1');
    expect(screen.getByTestId('summary-overdue')).toHaveTextContent('1');
    expect(within(stageEl('Design Detailing')).getByTestId('per-plan')).toHaveTextContent('per plan 50 %');
    expect(within(stageEl('Design Detailing')).getByTestId('last-check-in')).toHaveTextContent('Last check-in W30');
    expect(within(stageEl('Lab Test')).getByTestId('last-check-in')).toHaveTextContent('never');
    expect(within(stageEl('Assembly')).getByTestId('checked-in-this-week')).toBeInTheDocument();
    const chips = screen.getAllByTestId('tracking-status-chip').map((c) => c.getAttribute('data-tracking'));
    expect(chips).toEqual(['overdue', 'due']);
    // ADR 0017: the status select offers "On Hold", never "Blocked".
    const select = within(stageEl('Design Detailing')).getByLabelText('Status');
    expect(within(select).getByRole('option', { name: 'On Hold' })).toHaveValue('Blocked');
    expect(within(select).queryByRole('option', { name: 'Blocked' })).not.toBeInTheDocument();
  });

  it('passes the global hub filter as hub_id', async () => {
    useHubFilterStore.setState({ hubId: 'hub-in' });
    await renderPage();
    expect(client.apiGet).toHaveBeenCalledWith('/check-ins/due', expect.objectContaining({ query: { hub_id: 'hub-in' } }));
  });

  it('opens a stage history drawer from GET /check-ins/history', async () => {
    const { user } = await renderPage();
    await user.click(within(stageEl('Design Detailing')).getByRole('button', { name: /Check-in history for Design Detailing/ }));
    const list = await screen.findByTestId('check-in-history');
    expect(client.apiGet).toHaveBeenCalledWith('/check-ins/history', expect.objectContaining({ query: { project_id: 'p1', step_id: 'PDD-E' } }));
    expect(list).toHaveTextContent('W30 · On Hold · 30 %');
    expect(list).toHaveTextContent('Hold reason: Waiting for parts');
    expect(list).toHaveTextContent('By Ana Engineer');
  });

  it('has no serious/critical axe violations', async () => {
    const { container } = await renderPage();
    expect(await seriousAxeViolations(container)).toEqual([]);
  });
});

describe('CheckInPage — form validation and batch submit', () => {
  it('On Hold needs a hold reason: the submit is blocked with the error on that stage', async () => {
    const { user } = await renderPage();
    const row = stageEl('Design Detailing');
    await user.selectOptions(within(row).getByLabelText('Status'), 'Blocked');
    await user.click(screen.getByTestId('check-in-submit'));
    expect(within(row).getByTestId('check-in-stage-errors')).toHaveTextContent('A stage on hold needs a hold reason.');
    expect(screen.getByTestId('check-in-form-error')).toHaveTextContent('1 stage needs attention.');
    expect(client.apiSend).not.toHaveBeenCalled();

    await user.type(within(row).getByLabelText(/Hold reason/), 'Waiting for supplier');
    await user.click(screen.getByTestId('check-in-submit'));
    await waitFor(() =>
      expect(client.apiSend).toHaveBeenCalledWith('POST', '/check-ins', {
        entries: [
          { project_id: 'p1', step_id: 'PDD-E', status: 'Blocked', percent_complete: 40, blocked_reason: 'Waiting for supplier', note: null },
        ],
      }),
    );
  });

  it('submits edited and confirmed-unchanged stages as one batch; not_needed shows a success message', async () => {
    const { user } = await renderPage();
    const pct = within(stageEl('Design Detailing')).getByLabelText('% complete');
    await user.clear(pct);
    await user.type(pct, '60');
    await user.type(within(stageEl('Design Detailing')).getByLabelText(/Note/), 'Drawings sent');
    await user.click(within(stageEl('Assembly')).getByRole('button', { name: 'Confirm Assembly unchanged' }));
    expect(within(stageEl('Assembly')).getByTestId('confirm-unchanged')).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByTestId('check-in-submit'));

    await waitFor(() => expect(client.apiSend).toHaveBeenCalledTimes(1));
    expect(client.apiSend).toHaveBeenCalledWith('POST', '/check-ins', {
      entries: [
        { project_id: 'p1', step_id: 'PDD-E', status: 'In Progress', percent_complete: 60, blocked_reason: null, note: 'Drawings sent' },
        { project_id: 'p2', step_id: 'OEM-A', status: 'In Progress', percent_complete: 40, blocked_reason: null, note: null },
      ],
    });
    const panel = await screen.findByTestId('check-in-result');
    expect(panel).toHaveAttribute('data-kind', 'notice');
    expect(within(panel).getByRole('heading', { name: 'Check-in saved' })).toBeInTheDocument();
    expect(within(panel).getByTestId('check-in-result-body')).toHaveTextContent('2 stages checked in for week 31.');
    expect(sse.streamSolverProgress).not.toHaveBeenCalled();
  });

  it('maps 422 CHECKIN_INVALID per-entry errors onto the right rows; nothing is cleared', async () => {
    client.apiSend.mockRejectedValue(
      new ApiError(
        422,
        'Unprocessable',
        JSON.stringify({ message: 'Invalid batch', errors: [{ index: 1, code: 'NOT_DUE', message: 'Assembly is not due this week.' }] }),
        'CHECKIN_INVALID',
      ),
    );
    const { user } = await renderPage();
    await user.click(within(stageEl('Design Detailing')).getByRole('button', { name: 'Confirm Design Detailing unchanged' }));
    await user.click(within(stageEl('Assembly')).getByRole('button', { name: 'Confirm Assembly unchanged' }));
    await user.click(screen.getByTestId('check-in-submit'));

    expect(await within(stageEl('Assembly')).findByTestId('check-in-stage-errors')).toHaveTextContent('Assembly is not due this week.');
    expect(within(stageEl('Design Detailing')).queryByTestId('check-in-stage-errors')).not.toBeInTheDocument();
    expect(screen.getByTestId('check-in-form-error')).toHaveTextContent('1 of 2 stages were rejected. Nothing was saved');
    // the drafts are kept so the user can fix and resubmit
    expect(within(stageEl('Design Detailing')).getByTestId('confirm-unchanged')).toHaveAttribute('aria-pressed', 'true');
  });

  it('429 RATE_LIMITED (P12-R04): shows check-in copy, never the comment copy', async () => {
    client.apiSend.mockRejectedValue(new ApiError(429, 'Too Many Requests', 'slow down', 'RATE_LIMITED', 6));
    const { user } = await renderPage();
    await user.click(within(stageEl('Design Detailing')).getByRole('button', { name: 'Confirm Design Detailing unchanged' }));
    await user.click(screen.getByTestId('check-in-submit'));

    const panel = await screen.findByTestId('check-in-result');
    expect(within(panel).getByTestId('check-in-result-body')).toHaveTextContent(
      'Too many check-ins in a row — wait 6 s and submit again.',
    );
    expect(document.body).not.toHaveTextContent(/commenting/i);
  });

  it('deferred (ADR 0023): says the timeline updates automatically and starts the follow-up watcher', async () => {
    client.apiSend.mockResolvedValue(submitResponse({ recalc_status: 'deferred' }));
    const { user } = await renderPage();
    await user.click(within(stageEl('Design Detailing')).getByRole('button', { name: 'Confirm Design Detailing unchanged' }));
    await user.click(screen.getByTestId('check-in-submit'));
    const panel = await screen.findByTestId('check-in-result');
    expect(within(panel).getByTestId('check-in-result-body')).toHaveTextContent(
      'Saved — the timeline updates automatically after the current recalculation',
    );
    expect(watcher.start).toHaveBeenCalledTimes(1);
    expect(within(panel).getByTestId('check-in-follow-up')).toHaveTextContent('Waiting for the follow-up recalculation');
  });

  it('dispatch_failed (P14): saved, marked stale, tells the user to press Recalculate', async () => {
    client.apiSend.mockResolvedValue(submitResponse({ recalc_status: 'dispatch_failed' }));
    const { user } = await renderPage();
    await user.click(within(stageEl('Design Detailing')).getByRole('button', { name: 'Confirm Design Detailing unchanged' }));
    await user.click(screen.getByTestId('check-in-submit'));
    const panel = await screen.findByTestId('check-in-result');
    expect(within(panel).getByTestId('check-in-result-body')).toHaveTextContent('Press Recalculate on a project');
    expect(watcher.start).not.toHaveBeenCalled();
  });

  it('queued (ADR 0023): follows the run, then shows "Timeline updated" from the served changes', async () => {
    client.apiSend.mockResolvedValue(submitResponse({ recalc_status: 'queued', schedule_run_id: 'run-43', baseline_run_id: 'run-42', task_id: 't' }));
    const { user } = await renderPage();
    await user.click(within(stageEl('Design Detailing')).getByRole('button', { name: 'Confirm Design Detailing unchanged' }));
    await user.click(screen.getByTestId('check-in-submit'));
    await waitFor(() => expect(sse.streamSolverProgress).toHaveBeenCalledWith('run-43', expect.any(Function), expect.any(AbortSignal)));
    const panel = await screen.findByTestId('check-in-result');
    expect(await within(panel).findByRole('heading', { name: 'Timeline updated' })).toBeInTheDocument();
    await waitFor(() => expect(move.fetchScheduleRunChanges).toHaveBeenCalledWith('run-43', 'run-42', expect.anything()));
    expect(await within(panel).findByTestId('changed-projects-list')).toHaveTextContent('Cooler One');
    expect(within(panel).getByTestId('timeline-hidden-count')).toHaveTextContent('+2 more in hubs outside your scope');
  });
});

describe('CheckInPage — read-only', () => {
  it('renders served values without inputs or a submit when no stage can be checked in (Executive Viewer)', async () => {
    dueBody = due({
      projects: due().projects.map((p) => ({ ...p, stages: p.stages.map((s) => ({ ...s, can_check_in: false })) })),
    });
    await renderPage();
    expect(screen.getByTestId('check-in-read-only')).toBeInTheDocument();
    expect(screen.queryByTestId('check-in-submit')).not.toBeInTheDocument();
    expect(screen.queryAllByLabelText('Status')).toHaveLength(0);
    expect(screen.getAllByTestId('check-in-stage-readonly')).toHaveLength(3);
    expect(within(stageEl('Design Detailing')).getByTestId('check-in-stage-readonly')).toHaveTextContent('Per plan50 %');
  });

  it('shows the empty state when nothing is due', async () => {
    dueBody = due({ projects: [], summary: { due_stages: 0, checked_in_stages: 0, projects_live: 0, projects_due: 0, projects_overdue: 0, stale_projects: 0 } });
    renderWithProviders(<CheckInPage />);
    expect(await screen.findByText('Nothing due this week')).toBeInTheDocument();
  });
});

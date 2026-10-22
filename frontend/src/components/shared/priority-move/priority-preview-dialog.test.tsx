import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ApiError } from '@/lib/api/client';
import type { PriorityMoveResponse, PriorityPreviewChange, PriorityPreviewResponse } from '@/lib/api/priority-move';
import { renderWithProviders } from '@/test/render';
import { seriousAxeViolations } from '@/test/axe';

/**
 * P14 (ADR 0026): the preview → Yes / No dialog every move entry point opens.
 * The API module is mocked; every figure asserted here is a served field.
 */

const api = { moveProjectPriority: vi.fn(), previewProjectPriority: vi.fn(), fetchScheduleRunChanges: vi.fn() };
vi.mock('@/lib/api/priority-move', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/priority-move')>('@/lib/api/priority-move');
  return {
    ...actual,
    moveProjectPriority: (...a: unknown[]) => api.moveProjectPriority(...a),
    previewProjectPriority: (...a: unknown[]) => api.previewProjectPriority(...a),
    fetchScheduleRunChanges: (...a: unknown[]) => api.fetchScheduleRunChanges(...a),
  };
});
const invalidate = vi.fn();
vi.mock('@/lib/use-schedule-run-follow', async () => {
  const actual = await vi.importActual<typeof import('@/lib/use-schedule-run-follow')>('@/lib/use-schedule-run-follow');
  return { ...actual, invalidateRunDerivedQueries: (...a: unknown[]) => invalidate(...a) };
});
const followUp = { start: vi.fn() };
vi.mock('@/lib/use-follow-up-run', () => ({
  useFollowUpRunWatcher: () => ({ start: followUp.start, watching: false }),
}));

import { usePriorityMoveHost, type PriorityMoveOutcome } from './priority-move-context';
import { PriorityMoveProvider } from './priority-move-provider';

function change(overrides: Partial<PriorityPreviewChange>): PriorityPreviewChange {
  return {
    project_id: 'x',
    name: 'X',
    hub: 'PD-India',
    priority: 'P2',
    end_week_before: 30,
    end_week_after: 34,
    within_year_before: true,
    within_year_after: true,
    left_out_before: false,
    left_out_after: false,
    blocked_before: false,
    blocked_after: false,
    ...overrides,
  };
}

const CHANGES: PriorityPreviewChange[] = [
  change({ project_id: 'c1', name: 'Bar 250 R290', hub: 'PD-India', priority: 'P1', end_week_before: 50, end_week_after: 55, within_year_after: false }),
  change({ project_id: 'c2', name: 'Super-16 for Kazakhstan', hub: 'OEM-Seitek', priority: 'P3', end_week_before: 30, end_week_after: 34 }),
  change({ project_id: 'c3', name: 'IC3-450 B rating', hub: 'R&D-Greece', priority: 'P4', end_week_before: 60, end_week_after: 48, within_year_before: false, within_year_after: true }),
];

function preview(overrides: Partial<PriorityPreviewResponse> = {}): PriorityPreviewResponse {
  return {
    result: 'preview',
    project_id: 'p1',
    from_priority: 'P4',
    to_priority: 'P1',
    baseline_run_id: 'run-42',
    preview_token: 'tok-1',
    moved: { end_week_before: 70, end_week_after: 38, within_year_before: false, within_year_after: true, left_out_before: false, left_out_after: false },
    summary: { affected: 7, delayed: 5, earlier: 2, pushed_out_of_year: 2, pulled_into_year: 1 },
    changes: CHANGES,
    hidden_count: 4,
    elapsed_ms: 820,
    ...overrides,
  };
}

function applied(overrides: Partial<PriorityMoveResponse> = {}): PriorityMoveResponse {
  return {
    project_id: 'p1',
    priority_before: 'P4',
    priority_after: 'P1',
    recalc_status: 'applied',
    schedule_run_id: 'run-43',
    baseline_run_id: 'run-42',
    task_id: null,
    moved: preview().moved,
    summary: preview().summary,
    changes: CHANGES,
    hidden_count: 4,
    ...overrides,
  };
}

/** A minimal entry point, like a board drop: request the move, record how it settled. */
function Harness({ onSettled, status }: { onSettled: (o: PriorityMoveOutcome) => void; status?: string | undefined }) {
  const host = usePriorityMoveHost();
  return (
    <button
      type="button"
      onClick={() => host?.requestMove({ projectId: 'p1', projectName: 'Coffee Combo', priority: 'P4', status }, 'P1', { onSettled })}
    >
      Drop on P1
    </button>
  );
}

function renderHarness(status?: string) {
  const onSettled = vi.fn();
  renderWithProviders(
    <PriorityMoveProvider>
      <Harness onSettled={onSettled} status={status} />
    </PriorityMoveProvider>,
  );
  return { onSettled };
}

async function openPreview(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Drop on P1' }));
  const dialog = await screen.findByRole('dialog', { name: 'Move to P1?' });
  await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Yes, apply' })).toBeEnabled());
  return dialog;
}

beforeEach(() => {
  vi.clearAllMocks();
  api.previewProjectPriority.mockResolvedValue(preview());
  api.moveProjectPriority.mockResolvedValue(applied());
});

describe('Priority move preview dialog (ADR 0026)', () => {
  it('shows a loading state while the preview runs, with Yes disabled and focus on No', async () => {
    let resolve: (v: PriorityPreviewResponse) => void = () => undefined;
    api.previewProjectPriority.mockReturnValue(new Promise((r) => (resolve = r)));
    const user = userEvent.setup();
    renderHarness();
    await user.click(screen.getByRole('button', { name: 'Drop on P1' }));
    const dialog = await screen.findByRole('dialog', { name: 'Move to P1?' });
    expect(within(dialog).getByTestId('preview-loading')).toHaveTextContent('Calculating what this move would change');
    expect(within(dialog).getByRole('button', { name: 'Yes, apply' })).toBeDisabled();
    expect(within(dialog).getByRole('button', { name: 'No, cancel' })).toHaveFocus();
    resolve(preview());
    expect(await within(dialog).findByTestId('preview-summary')).toBeInTheDocument();
    expect(api.moveProjectPriority).not.toHaveBeenCalled();
  });

  it('summarises the served preview: own finish, counts, hidden count, affected table with pushed-out emphasis', async () => {
    const user = userEvent.setup();
    renderHarness();
    const dialog = await openPreview(user);
    expect(api.previewProjectPriority).toHaveBeenCalledWith('p1', 'P1', expect.objectContaining({ signal: expect.any(AbortSignal) }));

    const moved = within(dialog).getByTestId('preview-moved');
    expect(moved).toHaveTextContent('Coffee Combo');
    expect(moved).toHaveTextContent('W52'); // 70 → "After W52" (framed on the 52-week year)
    expect(moved).toHaveTextContent('W38');
    expect(moved).toHaveTextContent('Past W52');
    expect(moved).toHaveTextContent('Within year');

    expect(within(dialog).getByTestId('preview-count-affected')).toHaveTextContent('7');
    expect(within(dialog).getByTestId('preview-count-delayed')).toHaveTextContent('5');
    expect(within(dialog).getByTestId('preview-count-earlier')).toHaveTextContent('2');
    expect(within(dialog).getByTestId('preview-count-pushed_out_of_year')).toHaveTextContent('2');
    expect(within(dialog).getByTestId('preview-count-pulled_into_year')).toHaveTextContent('1');
    expect(within(dialog).getByTestId('preview-hidden-count')).toHaveTextContent('+4 more affected in hubs outside your scope');

    const region = within(dialog).getByRole('region', { name: 'Projects this move would change' });
    expect(region).toHaveAttribute('tabindex', '0');
    const rows = within(dialog).getAllByTestId('preview-change-row');
    expect(rows).toHaveLength(3);
    // Served order is kept (pushed out of year first).
    expect(rows[0]).toHaveTextContent('Bar 250 R290');
    expect(rows[0]).toHaveTextContent('PD-India');
    expect(rows[0]).toHaveTextContent('W50');
    expect(rows[0]).toHaveTextContent('W52');
    expect(rows[0]).toHaveAttribute('data-pushed-out', 'true');
    expect(within(rows[0]!).getByTestId('pushed-out-chip')).toHaveTextContent('Pushed out of year');
    expect(rows[1]).not.toHaveAttribute('data-pushed-out');
    expect(rows[2]).toHaveTextContent('Past W52');
    expect(rows[2]).toHaveTextContent('Within year');
  });

  it('hides the hidden-count line when it is zero', async () => {
    api.previewProjectPriority.mockResolvedValue(preview({ hidden_count: 0 }));
    const user = userEvent.setup();
    renderHarness();
    const dialog = await openPreview(user);
    expect(within(dialog).queryByTestId('preview-hidden-count')).not.toBeInTheDocument();
  });

  it('Yes confirms with the preview token, shows the applied result and invalidates the run-backed queries', async () => {
    const user = userEvent.setup();
    const { onSettled } = renderHarness();
    const dialog = await openPreview(user);
    await user.click(within(dialog).getByRole('button', { name: 'Yes, apply' }));
    expect(api.moveProjectPriority).toHaveBeenCalledWith('p1', 'P1', 'tok-1');
    const done = await screen.findByRole('dialog', { name: 'Moved to P1' });
    expect(within(done).getByTestId('preview-applied')).toHaveTextContent('Priority moved and the timeline recalculated.');
    expect(within(done).getAllByTestId('preview-change-row')).toHaveLength(3);
    expect(onSettled).toHaveBeenCalledWith('accepted');
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(within(done).getByRole('button', { name: 'Done' })).toHaveFocus();
    await user.click(within(done).getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('No cancels: nothing is written and the drop is reported cancelled (snap back)', async () => {
    const user = userEvent.setup();
    const { onSettled } = renderHarness();
    const dialog = await openPreview(user);
    await user.click(within(dialog).getByRole('button', { name: 'No, cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(api.moveProjectPriority).not.toHaveBeenCalled();
    expect(onSettled).toHaveBeenCalledWith('cancelled');
  });

  it('Escape also cancels', async () => {
    const user = userEvent.setup();
    const { onSettled } = renderHarness();
    await openPreview(user);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(onSettled).toHaveBeenCalledWith('cancelled'));
    expect(api.moveProjectPriority).not.toHaveBeenCalled();
  });

  it('PREVIEW_STALE re-previews automatically once, then Yes applies the fresh token', async () => {
    api.previewProjectPriority
      .mockResolvedValueOnce(preview())
      .mockResolvedValueOnce(preview({ preview_token: 'tok-2', summary: { affected: 8, delayed: 6, earlier: 2, pushed_out_of_year: 3, pulled_into_year: 1 } }));
    api.moveProjectPriority
      .mockRejectedValueOnce(new ApiError(409, 'conflict', 'stale', 'PREVIEW_STALE'))
      .mockResolvedValueOnce(applied());
    const user = userEvent.setup();
    const { onSettled } = renderHarness();
    const dialog = await openPreview(user);
    await user.click(within(dialog).getByRole('button', { name: 'Yes, apply' }));

    expect(await screen.findByTestId('preview-refreshed')).toHaveTextContent('The plan changed since the first preview');
    expect(api.previewProjectPriority).toHaveBeenCalledTimes(2);
    expect(screen.getByTestId('preview-count-affected')).toHaveTextContent('8');
    expect(onSettled).not.toHaveBeenCalled();

    const yes = screen.getByRole('button', { name: 'Yes, apply' });
    await waitFor(() => expect(yes).toBeEnabled());
    await user.click(yes);
    expect(api.moveProjectPriority).toHaveBeenLastCalledWith('p1', 'P1', 'tok-2');
    expect(await screen.findByRole('dialog', { name: 'Moved to P1' })).toBeInTheDocument();
    expect(onSettled).toHaveBeenCalledWith('accepted');
  });

  it('a second PREVIEW_STALE does not loop: it shows the error and rejects', async () => {
    api.moveProjectPriority.mockRejectedValue(new ApiError(409, 'conflict', 'stale', 'PREVIEW_STALE'));
    const user = userEvent.setup();
    const { onSettled } = renderHarness();
    await openPreview(user);
    await user.click(screen.getByRole('button', { name: 'Yes, apply' }));
    await screen.findByTestId('preview-refreshed');
    const yes = screen.getByRole('button', { name: 'Yes, apply' });
    await waitFor(() => expect(yes).toBeEnabled());
    await user.click(yes);
    expect(await screen.findByTestId('preview-error')).toHaveTextContent('The plan changed since this preview was calculated');
    expect(api.previewProjectPriority).toHaveBeenCalledTimes(2);
    expect(onSettled).toHaveBeenCalledWith('rejected');
  });

  it('deferred on confirm: closes the dialog and shows the existing deferred message', async () => {
    api.moveProjectPriority.mockResolvedValue(applied({ recalc_status: 'deferred', schedule_run_id: null }));
    const user = userEvent.setup();
    const { onSettled } = renderHarness();
    const dialog = await openPreview(user);
    await user.click(within(dialog).getByRole('button', { name: 'Yes, apply' }));
    expect(await screen.findByTestId('priority-move-notice')).toHaveTextContent(
      'Saved — the timeline updates automatically after the current recalculation',
    );
    expect(followUp.start).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(onSettled).toHaveBeenCalledWith('accepted');
  });

  it('not_needed preview: explains, Yes saves, and the existing not_needed message follows', async () => {
    api.previewProjectPriority.mockResolvedValue(
      preview({ result: 'not_needed', moved: null, changes: [], summary: { affected: 0, delayed: 0, earlier: 0, pushed_out_of_year: 0, pulled_into_year: 0 } }),
    );
    api.moveProjectPriority.mockResolvedValue(applied({ recalc_status: 'not_needed', schedule_run_id: null }));
    const user = userEvent.setup();
    renderHarness('On Hold');
    const dialog = await openPreview(user);
    expect(within(dialog).getByTestId('preview-not-needed')).toHaveTextContent("isn't in the plan (status On Hold)");
    expect(within(dialog).queryByTestId('preview-summary')).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Yes, apply' }));
    expect(await screen.findByTestId('priority-move-notice')).toHaveTextContent(
      "Saved. This project isn't in the plan (status On Hold), so no timeline change.",
    );
  });

  it('unchanged preview: no dialog stays, nothing is written', async () => {
    api.previewProjectPriority.mockResolvedValue(preview({ result: 'unchanged' }));
    const user = userEvent.setup();
    const { onSettled } = renderHarness();
    await user.click(screen.getByRole('button', { name: 'Drop on P1' }));
    await waitFor(() => expect(onSettled).toHaveBeenCalledWith('cancelled'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(api.moveProjectPriority).not.toHaveBeenCalled();
  });

  it('409 HARD_GATE_FORCES_P1 on the preview: the existing hard-gate copy, and the drop is rejected', async () => {
    api.previewProjectPriority.mockRejectedValue(new ApiError(409, 'conflict', 'hard gates', 'HARD_GATE_FORCES_P1'));
    const user = userEvent.setup();
    const { onSettled } = renderHarness();
    await user.click(screen.getByRole('button', { name: 'Drop on P1' }));
    const dialog = await screen.findByRole('dialog', { name: 'Priority not changed' });
    expect(within(dialog).getByTestId('preview-error')).toHaveTextContent(
      'This project has a hard gate (regulatory / certification / safety), so it must stay P1.',
    );
    expect(onSettled).toHaveBeenCalledWith('rejected');
    expect(api.moveProjectPriority).not.toHaveBeenCalled();
  });

  it('dispatch_failed on confirm: saved but not recalculated, tells the user to press Recalculate', async () => {
    api.moveProjectPriority.mockResolvedValue(applied({ recalc_status: 'dispatch_failed', schedule_run_id: null }));
    const user = userEvent.setup();
    renderHarness();
    const dialog = await openPreview(user);
    await user.click(within(dialog).getByRole('button', { name: 'Yes, apply' }));
    expect(await screen.findByTestId('priority-move-notice')).toHaveTextContent('Press Recalculate on the project');
    expect(screen.getByRole('heading', { name: 'Priority saved — timeline not recalculated' })).toBeInTheDocument();
  });

  it('429 on the preview: move-specific rate-limit copy; 503 PREVIEW_TIMEOUT: the timeout copy', async () => {
    api.previewProjectPriority.mockRejectedValueOnce(new ApiError(429, 'x', 'slow', 'RATE_LIMITED', 5));
    const user = userEvent.setup();
    renderHarness();
    await user.click(screen.getByRole('button', { name: 'Drop on P1' }));
    expect(await screen.findByTestId('preview-error')).toHaveTextContent('Too many previews in a row');
    await user.click(screen.getByRole('button', { name: 'Done' }));
    api.previewProjectPriority.mockRejectedValueOnce(new ApiError(503, 'x', 'slow', 'PREVIEW_TIMEOUT'));
    await user.click(screen.getByRole('button', { name: 'Drop on P1' }));
    expect(await screen.findByTestId('preview-error')).toHaveTextContent('took too long');
  });

  it('no active run: the served note is shown and null "before" weeks print as a dash', async () => {
    api.previewProjectPriority.mockResolvedValue(
      preview({
        baseline_run_id: null,
        note: 'No active schedule to compare against.',
        moved: { end_week_before: null, end_week_after: 38, within_year_before: null, within_year_after: true, left_out_before: null, left_out_after: false },
        changes: [],
      }),
    );
    const user = userEvent.setup();
    renderHarness();
    const dialog = await openPreview(user);
    expect(dialog).toHaveTextContent('No active schedule to compare against.');
    expect(within(dialog).getByTestId('preview-moved')).toHaveTextContent('—');
  });

  it('virtualizes the affected table over 100 rows', async () => {
    const many = Array.from({ length: 180 }, (_, i) => change({ project_id: `m${String(i)}`, name: `Project ${String(i)}` }));
    api.previewProjectPriority.mockResolvedValue(preview({ changes: many }));
    const user = userEvent.setup();
    renderHarness();
    const dialog = await openPreview(user);
    const rows = within(dialog).getAllByTestId('preview-change-row');
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.length).toBeLessThan(180);
    expect(dialog.querySelector('tbody[data-virtualized="true"]')).not.toBeNull();
  });

  it('has no serious/critical axe violations in the preview state', async () => {
    const user = userEvent.setup();
    renderHarness();
    const dialog = await openPreview(user);
    expect(await seriousAxeViolations(dialog)).toEqual([]);
  });
});

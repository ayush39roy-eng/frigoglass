import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import type { PriorityPreviewResponse, ScheduleRunChangeRow, ScheduleRunChanges } from '@/lib/api/priority-move';
import { renderWithProviders } from '@/test/render';
import { seriousAxeViolations } from '@/test/axe';
import type { ProjectPriority } from '@/types/enums';

/**
 * P42-T04 (ADR 0056, R42-8): what a priority move does to the moved project.
 * Into P4 → "leaves the plan"; into a queued P3 → "joins the queue — not
 * counted this year". The preview prints the SERVED `effect_label`; the
 * "Timeline updated" panel reads the run's stored before / after flags.
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
vi.mock('@/lib/use-schedule-run-follow', async () => {
  const actual = await vi.importActual<typeof import('@/lib/use-schedule-run-follow')>('@/lib/use-schedule-run-follow');
  return { ...actual, invalidateRunDerivedQueries: vi.fn() };
});
vi.mock('@/lib/use-follow-up-run', () => ({
  useFollowUpRunWatcher: () => ({ start: vi.fn(), watching: false }),
}));

import { usePriorityMoveHost } from './priority-move-context';
import { PriorityMoveProvider } from './priority-move-provider';
import { bandEffectOfChange } from './move-copy';
import { TimelineUpdatedPanel } from './timeline-updated-panel';

function preview(to: ProjectPriority, moved: PriorityPreviewResponse['moved']): PriorityPreviewResponse {
  return {
    result: 'preview',
    project_id: 'p1',
    from_priority: 'P2',
    to_priority: to,
    baseline_run_id: 'run-42',
    preview_token: 'tok-1',
    moved,
    summary: { affected: 0, delayed: 0, earlier: 0, pushed_out_of_year: 0, pulled_into_year: 0 },
    changes: [],
    hidden_count: 0,
    elapsed_ms: 12,
  };
}

function Harness({ to }: { to: ProjectPriority }) {
  const host = usePriorityMoveHost();
  return (
    <button
      type="button"
      onClick={() => host?.requestMove({ projectId: 'p1', projectName: 'Coffee Combo', priority: 'P2', status: 'In Queue' }, to)}
    >
      Move
    </button>
  );
}

async function openPreview(to: ProjectPriority) {
  const user = userEvent.setup();
  renderWithProviders(
    <PriorityMoveProvider>
      <Harness to={to} />
    </PriorityMoveProvider>,
  );
  await user.click(screen.getByRole('button', { name: 'Move' }));
  const dialog = await screen.findByRole('dialog', { name: `Move to ${to}?` });
  await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Yes, apply' })).toBeEnabled());
  return dialog;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('P42 priority-move preview copy (R42-8)', () => {
  it('a move into P4 says the project leaves the plan, not that it drops out of the year', async () => {
    api.previewProjectPriority.mockResolvedValue(
      preview('P4', {
        end_week_before: 30,
        end_week_after: null,
        within_year_before: true,
        within_year_after: false,
        left_out_before: false,
        left_out_after: false,
        counts_toward_year_before: true,
        counts_toward_year_after: false,
        not_scheduled_priority_before: false,
        not_scheduled_priority_after: true,
        effect: 'leaves_plan',
        effect_label: 'leaves the plan',
      }),
    );
    const dialog = await openPreview('P4');
    const effect = within(dialog).getByTestId('preview-moved-effect');
    expect(effect).toHaveTextContent('This project leaves the plan.');
    expect(effect).toHaveAttribute('data-effect', 'leaves_plan');
    // The within-year flip is not shown as a delivery loss.
    expect(within(within(dialog).getByTestId('preview-moved')).queryByText('Past W52')).toBeNull();
    expect(dialog.textContent).not.toMatch(/ of \d/);
    expect(await seriousAxeViolations(dialog)).toEqual([]);
  });

  it('a move into a queued P3 says it joins the queue and is not counted this year', async () => {
    api.previewProjectPriority.mockResolvedValue(
      preview('P3', {
        end_week_before: 30,
        end_week_after: 44,
        within_year_before: true,
        within_year_after: false,
        left_out_before: false,
        left_out_after: false,
        counts_toward_year_before: true,
        counts_toward_year_after: false,
        not_scheduled_priority_before: false,
        not_scheduled_priority_after: false,
        effect: 'joins_queue',
        effect_label: 'joins the queue — not counted this year',
      }),
    );
    const dialog = await openPreview('P3');
    expect(within(dialog).getByTestId('preview-moved-effect')).toHaveTextContent(
      'This project joins the queue — not counted this year.',
    );
  });

  it('a counting move keeps the within-year chips and shows no effect line', async () => {
    api.previewProjectPriority.mockResolvedValue(
      preview('P1', {
        end_week_before: 60,
        end_week_after: 38,
        within_year_before: false,
        within_year_after: true,
        left_out_before: false,
        left_out_after: false,
        effect: null,
        effect_label: null,
      }),
    );
    const dialog = await openPreview('P1');
    expect(within(dialog).queryByTestId('preview-moved-effect')).toBeNull();
    expect(within(dialog).getByTestId('preview-moved')).toHaveTextContent('Within year');
  });
});

function changeRow(overrides: Partial<ScheduleRunChangeRow>): ScheduleRunChangeRow {
  return {
    priority_applicable: true,
    project_id: 'p1',
    project_name: 'Coffee Combo',
    hub: 'PD-India',
    priority: 'P4',
    before_projected_end_week: 30,
    after_projected_end_week: null,
    delta_weeks: null,
    before_within_year: true,
    after_within_year: false,
    before_left_out: false,
    after_left_out: false,
    before_blocked: false,
    after_blocked: false,
    is_new: false,
    is_removed: false,
    before_counts_toward_year: true,
    after_counts_toward_year: false,
    before_not_scheduled_priority: false,
    after_not_scheduled_priority: true,
    priority_label: 'Miscellaneous',
    ...overrides,
  };
}

function changes(rows: ScheduleRunChangeRow[]): ScheduleRunChanges {
  return { run_id: 'r2', run_version: 8, against_run_id: 'r1', against_run_version: 7, baseline_week: 31, run_week: 31, hidden_count: 0, rows };
}

describe('P42 "Timeline updated" copy (R42-8)', () => {
  it('into P4: "Leaves the plan", with no within-year loss chip', () => {
    render(
      <TimelineUpdatedPanel changes={changes([changeRow({})])} projectId="p1" projectName="Coffee Combo" priorityBefore="P2" priorityAfter="P4" />,
    );
    const own = screen.getByTestId('timeline-own-change');
    expect(within(own).getByTestId('timeline-band-effect')).toHaveTextContent('Leaves the plan');
    expect(within(own).queryByText(/Past W52/)).toBeNull();
  });

  it('into a queued P3: "Joins the queue — not counted this year"', () => {
    render(
      <TimelineUpdatedPanel
        changes={changes([
          changeRow({ priority: 'P3', priority_label: 'In queue', after_projected_end_week: 44, after_not_scheduled_priority: false }),
        ])}
        projectId="p1"
        projectName="Coffee Combo"
        priorityBefore="P2"
        priorityAfter="P3"
      />,
    );
    expect(within(screen.getByTestId('timeline-own-change')).getByTestId('timeline-band-effect')).toHaveTextContent(
      'Joins the queue — not counted this year',
    );
  });

  it('reads the class change from the stored flags only', () => {
    const base = changeRow({});
    expect(bandEffectOfChange(base)).toBe('leaves_plan');
    // P4 (never planned) → P3 while In Queue: joins the queue.
    expect(
      bandEffectOfChange({ ...base, before_counts_toward_year: false, before_not_scheduled_priority: true, after_not_scheduled_priority: false }),
    ).toBe('joins_queue');
    // P4 → P1: back in the plan.
    expect(
      bandEffectOfChange({
        ...base,
        before_counts_toward_year: false,
        before_not_scheduled_priority: true,
        after_counts_toward_year: true,
        after_not_scheduled_priority: false,
      }),
    ).toBe('enters_plan');
    // No class change.
    expect(bandEffectOfChange({ ...base, after_counts_toward_year: true, after_not_scheduled_priority: false })).toBeNull();
    // A side with no outcome row reads every flag false: never a class change.
    expect(bandEffectOfChange({ ...base, is_new: true })).toBeNull();
  });
});

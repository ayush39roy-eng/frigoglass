import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import { fullPermissions } from '@/test/session';
import { ApiError } from '@/lib/api/client';
import { useHubFilterStore } from '@/stores/hub-filter';
import { seriousAxeViolations } from '@/test/axe';
import type { GanttProjectRow, GanttStepRow } from './api/types';

// Deterministic virtualization: render every visual row.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 44,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        key: index,
        index,
        start: index * 44,
        size: 44,
      })),
    measureElement: () => undefined,
    measure: () => undefined,
  }),
}));

const hooks = {
  useGantt: vi.fn(),
  useActiveScheduleRun: vi.fn(),
  useToggleFreeze: vi.fn(),
  useGanttFacets: vi.fn(),
};
vi.mock('./hooks/use-gantt', () => ({
  useGantt: (args: unknown) => hooks.useGantt(args),
  useActiveScheduleRun: (enabled: boolean) => hooks.useActiveScheduleRun(enabled),
  useToggleFreeze: () => hooks.useToggleFreeze(),
  useGanttFacets: (...args: unknown[]) => hooks.useGanttFacets(...args),
}));
vi.mock('@/lib/api/reference', () => ({
  useHubs: () => ({
    data: [
      { id: 'hub-greece', name: 'R&D-Greece', lab_region: 'Greece', is_oem: false, capacity_hub_id: null, capacity_hub_name: null },
      { id: 'hub-india', name: 'R&D-India', lab_region: 'India', is_oem: false, capacity_hub_id: null, capacity_hub_name: null },
    ],
  }),
}));

import GanttPage from './GanttPage';
import { P13_GANTT_ROW_DEFAULTS, P40_GANTT_STEP_PIN_DEFAULTS } from './test-fixtures';

function step(seq: number, start: number, end: number, over: Partial<GanttStepRow> = {}): GanttStepRow {
  return {
    step_id: `PDD-${String.fromCharCode(64 + seq)}`,
    step_name: `Step ${String(seq)}`,
    kind: seq % 2 === 0 ? 'lab' : 'design',
    sequence_order: seq,
    skipped: false,
    status: 'Not Started',
    percent_complete: 0,
    duration_weeks: end - start + 1,
    planned_start_week: start,
    planned_end_week: end,
    actual_start_week: null,
    actual_end_week: null,
    assigned_engineer_name: null,
    assigned_chamber_code: null,
    eng_conflict: false,
    chamber_overlap: false,
    lead_time_weeks: 2,
    span_fte: null,
    effort_weeks: null,
    plan_weeks: 2,
    gap_weeks: 0,
    own_effort: false,
    predecessor_ids: [],
    ...P40_GANTT_STEP_PIN_DEFAULTS,
    ...over,
  };
}

function project(over: Partial<GanttProjectRow> = {}): GanttProjectRow {
  const steps = Array.from({ length: 14 }, (_, i) => step(i + 1, i * 2 + 1, i * 2 + 2));
  return {
    project_id: 'p1',
    project_name: 'Cooler Alpha',
    hub: 'R&D-Greece',
    category: 'A',
    priority: 'P1',
    frozen: false,
    delay_weeks: 0,
    left_out: false,
    spillover: false,
    cat_not_allowed: false,
    target_end_week: null,
    expected_end_week: null,
    projected_end_week: null,
    unconstrained_end_week: null,
    slip_weeks: null,
    blocked: false,
    schedule_stale: false,
    workflow_id: 'PDD',
    is_vip: false,
    tracking_status: 'idle',
    ...P13_GANTT_ROW_DEFAULTS,
    steps,
    ...over,
  };
}

function ganttData(over: Record<string, unknown> = {}) {
  return {
    data: {
      has_active_schedule_run: true,
      schedule_run_version: 5,
      total_count: 1,
      rows: [project()],
      weekly_active_counts: Array.from({ length: 52 }, (_, i) => ({ week: i + 1, pdd: i === 11 ? 3 : 0, oem: i === 11 ? 1 : 0, by_step: {} })),
      // P53 (API_CONTRACT_P53 §7): the run's plan-year window and last finish
      // (W78 → the axis runs to the end of 2027, W104).
      plan_year_start_week: 1,
      plan_year_end_week: 52,
      last_finish_week: 78,
      ...over,
    },
    isPending: false,
    isError: false,
    error: null,
    refetch: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.removeItem('rpd.gantt.showDetails');
  useHubFilterStore.getState().setSelection([], []);
  hooks.useActiveScheduleRun.mockReturnValue({ data: null });
  hooks.useToggleFreeze.mockReturnValue({ mutateAsync: vi.fn().mockResolvedValue({}) });
  hooks.useGantt.mockReturnValue(ganttData());
  hooks.useGanttFacets.mockReturnValue({
    data: {
      leaders: [
        { id: 'eng-0001', name: null },
        { id: 'eng-0002', name: 'Sam Super' },
      ],
      steps: [{ code: 'PDD-E', name: 'Design Detailing' }],
    },
    isError: false,
  });
});

describe('GanttPage', () => {
  it('always renders the heading and the zoom control', () => {
    renderWithProviders(<GanttPage />);
    expect(
      screen.getByRole('heading', { name: 'Project Execution Timeline' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'Zoom' })).toBeInTheDocument();
  });

  it('shows the no-schedule empty state (not an error) when has_active_schedule_run is false', () => {
    hooks.useGantt.mockReturnValue(
      ganttData({ has_active_schedule_run: false, schedule_run_version: null, rows: [], total_count: 0 }),
    );
    renderWithProviders(<GanttPage />);
    expect(screen.getByText('No schedule computed yet')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('expanding a project row reveals its 14 workflow step rows', async () => {
    const user = userEvent.setup();
    renderWithProviders(<GanttPage />);
    expect(screen.queryAllByTestId('gantt-step-row')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Expand steps for Cooler Alpha' }));
    expect(screen.getAllByTestId('gantt-step-row')).toHaveLength(14);
  });

  it('P33-T15 (ADR 0048): read-only for every role — no drag, resize, Edit timing or edited marker, even with GANTT write', async () => {
    const user = userEvent.setup();
    // `fullPermissions` (the default session) includes GANTT write.
    const withGaps = project({
      steps: Array.from({ length: 14 }, (_, i) =>
        step(i + 1, i * 2 + 1, i * 2 + 2, { gap_weeks: i === 3 ? -2 : i === 5 ? 3 : 0, own_effort: i === 4 }),
      ),
    });
    hooks.useGantt.mockReturnValue(ganttData({ rows: [withGaps] }));
    renderWithProviders(<GanttPage />);
    await user.click(screen.getByRole('button', { name: 'Expand steps for Cooler Alpha' }));
    expect(screen.getAllByTestId('gantt-step-row')).toHaveLength(14);
    expect(screen.queryByTestId('step-drag-overlay')).not.toBeInTheDocument();
    expect(screen.queryByTestId('step-drag-body')).not.toBeInTheDocument();
    expect(screen.queryByTestId('step-drag-handle')).not.toBeInTheDocument();
    expect(screen.queryByTestId('step-timing-edited')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Edit timing|Reset timing/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByText(/drag a step bar/i)).not.toBeInTheDocument();

    // The served signed gap becomes a read-only chip: negative = parallel, positive = wait.
    const chips = screen.getAllByTestId('step-gap-chip');
    expect(chips.map((c) => c.dataset.gapWeeks)).toEqual(['-2', '3']);
    expect(chips[0]).toHaveTextContent(/^parallel 2 wk/);
    expect(chips[1]).toHaveTextContent(/^wait 3 wk/);
    expect(chips.every((c) => c.tagName === 'SPAN')).toBe(true);
  });

  it('degrades to an access notice on a 403 (Auditor)', () => {
    hooks.useGantt.mockReturnValue({
      data: undefined,
      isPending: false,
      isError: true,
      error: new ApiError(403, 'forbidden'),
      refetch: vi.fn(),
    });
    renderWithProviders(<GanttPage />);
    expect(
      screen.getByText(/does not have access to the Project Execution Timeline/i),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Project Execution Timeline' })).toBeInTheDocument(); // header stays
    // P40-T01: the zoom lives on the timeline card, which is not drawn without access.
    expect(screen.queryByRole('slider', { name: 'Zoom' })).not.toBeInTheDocument();
    expect(screen.queryByText('Execution timeline')).not.toBeInTheDocument();
  });

  it('follows the global hub filter (P12, ADR 0020): the toolbar Hub dropdown is that filter, hub id passed, chip clears it', async () => {
    const user = userEvent.setup();
    renderWithProviders(<GanttPage />);
    expect(hooks.useGantt).toHaveBeenLastCalledWith({ includeUnplaced: true, hubIds: undefined, sort: 'priority' });
    // P40-T01: the toolbar's Hub dropdown edits the GLOBAL hub store (no page-local hub state).
    // Compact trigger: the field name while nothing is picked.
    expect(screen.getByRole('button', { name: 'Hub' })).toHaveAccessibleDescription('Hub');
    expect(screen.queryByTestId('hub-filter-chip')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Hub' }));
    await user.click(await screen.findByRole('option', { name: 'R&D-Greece' }));
    await user.keyboard('{Escape}');
    expect(useHubFilterStore.getState().hubIds).toEqual(['hub-greece']);
    expect(hooks.useGantt).toHaveBeenLastCalledWith({ includeUnplaced: true, hubIds: ['hub-greece'], sort: 'priority' });
    act(() => useHubFilterStore.getState().clear());

    act(() => useHubFilterStore.getState().setHubId('hub-india'));
    expect(hooks.useGantt).toHaveBeenLastCalledWith({ includeUnplaced: true, hubIds: ['hub-india'], sort: 'priority' });
    expect(screen.getByTestId('hub-filter-chip')).toHaveTextContent('Hub: R&D-India');
    // Multi-select: a country beside the hub is sent too (the server unions them).
    // (A country with no hub in scope would be pruned by the Hub dropdown, so use Greece.)
    act(() => useHubFilterStore.getState().toggleRegion('Greece'));
    expect(hooks.useGantt).toHaveBeenLastCalledWith({ includeUnplaced: true, hubIds: ['hub-india'], regions: ['Greece'], sort: 'priority' });

    await user.click(screen.getByRole('button', { name: /^Clear hubs filter/ }));
    expect(useHubFilterStore.getState().hubIds).toEqual([]);
    expect(hooks.useGantt).toHaveBeenLastCalledWith({ includeUnplaced: true, hubIds: undefined, sort: 'priority' });
  });

  it('renders the outcome badges from the server flags', () => {
    hooks.useGantt.mockReturnValue(
      ganttData({ rows: [project({ spillover: true, frozen: true, delay_weeks: 3 })] }),
    );
    renderWithProviders(<GanttPage />);
    expect(screen.getByText('Spillover')).toBeInTheDocument();
    expect(screen.getByText('Frozen')).toBeInTheDocument();
    expect(screen.getByText('+3w')).toBeInTheDocument();
  });

  describe('freeze toggle', () => {
    it('requires actual_start_week before it will submit a freeze', async () => {
      const user = userEvent.setup();
      const mutateAsync = vi.fn().mockResolvedValue({});
      hooks.useToggleFreeze.mockReturnValue({ mutateAsync });
      renderWithProviders(<GanttPage />);

      await user.click(screen.getByRole('button', { name: 'Freeze Cooler Alpha' }));
      const dialog = screen.getByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: /freeze project/i }));

      expect(within(dialog).getByRole('alert')).toHaveTextContent(/actual start week/i);
      expect(mutateAsync).not.toHaveBeenCalled();
    });

    it('submits { frozen: true, actual_start_week } and then surfaces the "recalc needed" notice', async () => {
      const user = userEvent.setup();
      const mutateAsync = vi.fn().mockResolvedValue({});
      hooks.useToggleFreeze.mockReturnValue({ mutateAsync });
      renderWithProviders(<GanttPage />);

      await user.click(screen.getByRole('button', { name: 'Freeze Cooler Alpha' }));
      const dialog = screen.getByRole('dialog');
      await user.type(within(dialog).getByLabelText(/actual start week/i), '18');
      await user.click(within(dialog).getByRole('button', { name: /freeze project/i }));

      expect(mutateAsync).toHaveBeenCalledWith({
        projectId: 'p1',
        body: { frozen: true, actual_start_week: 18 },
      });
      expect(await screen.findByText(/schedule was not recalculated/i)).toBeInTheDocument();
    });

    it('an already-frozen project only offers to unfreeze — never presented as changing locked dates', async () => {
      const user = userEvent.setup();
      const mutateAsync = vi.fn().mockResolvedValue({});
      hooks.useToggleFreeze.mockReturnValue({ mutateAsync });
      hooks.useGantt.mockReturnValue(ganttData({ rows: [project({ frozen: true })] }));
      renderWithProviders(<GanttPage />);

      await user.click(screen.getByRole('button', { name: 'Unfreeze Cooler Alpha' }));
      const dialog = screen.getByRole('dialog');
      await user.click(within(dialog).getByRole('button', { name: /unfreeze project/i }));
      expect(mutateAsync).toHaveBeenCalledWith({ projectId: 'p1', body: { frozen: false } });
    });

    it('downgrades to read-only after a 403 on the freeze mutation', async () => {
      const user = userEvent.setup();
      const mutateAsync = vi.fn().mockRejectedValue(new ApiError(403, 'forbidden'));
      hooks.useToggleFreeze.mockReturnValue({ mutateAsync });
      renderWithProviders(<GanttPage />);

      await user.click(screen.getByRole('button', { name: 'Freeze Cooler Alpha' }));
      const dialog = screen.getByRole('dialog');
      await user.type(within(dialog).getByLabelText(/actual start week/i), '18');
      await user.click(within(dialog).getByRole('button', { name: /freeze project/i }));

      expect(await screen.findByText(/read-only access to the timeline/i)).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: 'Freeze Cooler Alpha' }),
      ).not.toBeInTheDocument();
    });
  });

  describe('ADR 0062 / P53 R53-6 — the Timeline runs to the last finish under a year header row', () => {
    // 16 px per week at the default zoom (P13-T13 slider minimum); the axis is W1..W104
    // (the served last finish W78, rounded up to the end of 2027).
    const W = 16;

    /** A tick's printed label (its last text node; the first child is the <title>). */
    function tickLabel(tick: Element): string {
      return tick.lastChild?.textContent ?? '';
    }

    it('the week axis runs W1..W104 (end of 2027); tick labels restart at 1 and never print ≥ 53', () => {
      renderWithProviders(<GanttPage />);
      const axis = screen.getByRole('img', { name: 'Week axis, Week 1 of 2026 to Week 52 of 2027' });
      expect(axis).toHaveAttribute('width', String(104 * W));
      expect(within(axis).getByText('W52 year-end')).toBeInTheDocument();
      const ticks = within(axis).getAllByTestId('gantt-week-tick');
      // Stride 4 at 16 px: absolute 1, 5, …, 49, 53, 57, …, 77.
      expect(ticks.map((t) => t.getAttribute('data-week'))).toContain('53');
      for (const t of ticks) {
        const n = Number(tickLabel(t));
        expect(n).toBeGreaterThanOrEqual(1);
        expect(n).toBeLessThanOrEqual(52);
      }
      const w53 = ticks.find((t) => t.getAttribute('data-week') === '53');
      const w57 = ticks.find((t) => t.getAttribute('data-week') === '57');
      expect(w53 && tickLabel(w53)).toBe('1');
      expect(w57 && tickLabel(w57)).toBe('5');
      expect(w57?.querySelector('title')).toHaveTextContent('Week 5 of 2027');
      expect(axis.textContent).not.toMatch(/\b(5[3-9]|[6-9]\d|1\d\d)\b/);
    });

    it('a year header row spans 2026 (W1–W52) and 2027 (W53–W104), generated from the range', () => {
      renderWithProviders(<GanttPage />);
      const row = screen.getByTestId('gantt-year-row');
      expect(row).toHaveStyle({ width: `${String(104 * W)}px` });
      const bands = within(row).getAllByTestId('gantt-year-band');
      expect(bands.map((b) => b.textContent)).toEqual(['2026', '2027']);
      expect(bands[0]).toHaveAttribute('data-start-week', '1');
      expect(bands[0]).toHaveAttribute('data-end-week', '52');
      expect(bands[0]).toHaveStyle({ width: `${String(52 * W)}px` });
      expect(bands[1]).toHaveAttribute('data-end-week', '104');
      expect(bands[1]).toHaveStyle({ width: `${String(52 * W)}px` });
      expect(bands[1]).toHaveAttribute('title', '2027: week 1 to week 52');
    });

    it('draws a project and steps past W52 in full; spillover is the Status badge, not a pill over the bars', async () => {
      const steps = Array.from({ length: 14 }, (_, i) => step(i + 1, 30 + i * 2, 31 + i * 2));
      // Step 14 runs W56–W57 (wholly in 2027); step 12 runs W52–W53 (straddles).
      hooks.useGantt.mockReturnValue(
        ganttData({
          rows: [
            project({ spillover: true, projected_end_week: 57, expected_end_week: 50, slip_weeks: 7, steps }),
          ],
        }),
      );
      const user = userEvent.setup();
      renderWithProviders(<GanttPage />);

      const row = screen.getByTestId('gantt-project-row');
      const segs = [...row.querySelectorAll('rect[data-bar="planned"], rect[data-bar="elapsed"]')];
      expect(segs).toHaveLength(14);
      const xs = segs.map((r) => Number(r.getAttribute('x')));
      const ends = segs.map((r) => Number(r.getAttribute('x')) + Number(r.getAttribute('width')));
      expect(Math.min(...xs)).toBe(29 * W);
      expect(Math.max(...ends)).toBe(57 * W);
      expect(row.querySelector('rect[data-step="PDD-L"]')).toHaveAttribute('width', String(2 * W));
      // No right-edge pill; the projected line (W57) is drawn on the 2027 weeks.
      expect(within(row).queryByTestId('gantt-spillover-marker')).not.toBeInTheDocument();
      expect(within(row).getByTestId('gantt-marker-projected')).toHaveAttribute('data-week', '57');
      expect(within(row).getByTestId('gantt-status-cell')).toHaveTextContent('Spillover');
      // No title or label on the row prints a W53+ week.
      expect(row.textContent).not.toMatch(/W5[3-9]/);
      expect(within(row).getByRole('img', { name: /will be completed W5 '27/ })).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Expand steps for Cooler Alpha' }));
      const stepRows = screen.getAllByTestId('gantt-step-row');
      // Step 12 (W52–W53) and step 14 (W56–W57) are drawn in full, with no clip cue.
      expect(stepRows[11].querySelector('rect[data-bar]')).toHaveAttribute('width', String(2 * W));
      expect(stepRows[13].querySelector('rect[data-bar]')).toHaveAttribute('x', String(55 * W));
      expect(within(stepRows[11]).queryByTestId('gantt-step-spillover')).not.toBeInTheDocument();
      expect(within(stepRows[13]).queryByTestId('gantt-step-spillover')).not.toBeInTheDocument();
    });

    it('P53: a served last finish in 2029 extends the axis to the end of 2029 (never to the search limit)', () => {
      const steps = [step(1, 70, 150)];
      hooks.useGantt.mockReturnValue(ganttData({ rows: [project({ spillover: true, steps })], last_finish_week: 150 }));
      renderWithProviders(<GanttPage />);
      const bands = within(screen.getByTestId('gantt-year-row')).getAllByTestId('gantt-year-band');
      expect(bands.map((b) => b.textContent)).toEqual(['2026', '2027', '2028']);
      expect(screen.getByRole('img', { name: 'Week axis, Week 1 of 2026 to Week 52 of 2028' })).toHaveAttribute('width', String(156 * W));
      const row = screen.getByTestId('gantt-project-row');
      const seg = row.querySelector('rect[data-bar="planned"]');
      expect(Number(seg?.getAttribute('x')) + Number(seg?.getAttribute('width'))).toBe(150 * W);
      expect(within(row).queryByTestId('gantt-spillover-marker')).not.toBeInTheDocument();
    });

    it('without a served last finish (older server) work past the plan year is clipped there with the right-edge cue', () => {
      const steps = [step(1, 40, 60)];
      hooks.useGantt.mockReturnValue(
        ganttData({ rows: [project({ spillover: true, steps })], last_finish_week: undefined }),
      );
      renderWithProviders(<GanttPage />);
      const row = screen.getByTestId('gantt-project-row');
      const seg = row.querySelector('rect[data-bar="planned"]');
      expect(Number(seg?.getAttribute('x')) + Number(seg?.getAttribute('width'))).toBe(52 * W);
      expect(within(row).getByTestId('gantt-spillover-marker')).toHaveTextContent('Spillover → 2027');
    });

    it('a server left-out project keeps its Status badge and gets no pill', () => {
      hooks.useGantt.mockReturnValue(ganttData({ rows: [project({ left_out: true, steps: [] })] }));
      renderWithProviders(<GanttPage />);
      const row = screen.getByTestId('gantt-project-row');
      expect(within(row).queryByTestId('gantt-spillover-marker')).not.toBeInTheDocument();
      expect(within(row).getByText('Spillover · unplaced')).toBeInTheDocument();
    });

    it('a project finishing inside the year carries no spillover marker', () => {
      renderWithProviders(<GanttPage />);
      expect(within(screen.getByTestId('gantt-project-row')).queryByTestId('gantt-spillover-marker')).not.toBeInTheDocument();
    });
  });

  describe('P9 — completion lines, step kinds, badges, gating', () => {
    it('draws the expected and projected completion lines from the server weeks, with the slip label verbatim', () => {
      hooks.useGantt.mockReturnValue(
        ganttData({
          rows: [
            project({
              target_end_week: 40,
              expected_end_week: 40,
              projected_end_week: 44,
              unconstrained_end_week: 38,
              slip_weeks: 4,
            }),
          ],
        }),
      );
      renderWithProviders(<GanttPage />);
      const expected = screen.getByTestId('gantt-marker-expected');
      const projected = screen.getByTestId('gantt-marker-projected');
      expect(expected).toHaveAttribute('data-week', '40');
      expect(projected).toHaveAttribute('data-week', '44');
      expect(screen.getByTestId('gantt-slip-bracket')).toHaveTextContent('+4 wk');
      expect(screen.getByRole('img', { name: /Expected \(target\) W40 · will be completed W44 · slip \+4 wk/ })).toBeInTheDocument();
    });

    it('labels the expected line "process-derived" when the project has no target week', () => {
      hooks.useGantt.mockReturnValue(
        ganttData({
          rows: [project({ target_end_week: null, expected_end_week: 38, projected_end_week: 36, slip_weeks: -2 })],
        }),
      );
      renderWithProviders(<GanttPage />);
      expect(screen.getByRole('img', { name: /Expected \(process-derived\) W38/ })).toBeInTheDocument();
      expect(screen.getByTestId('gantt-slip-bracket')).toHaveTextContent('−2 wk');
    });

    it('omits the bar for a skipped step and shows the n/a chip; elapsed steps render hollow', async () => {
      const user = userEvent.setup();
      const steps = [
        step(1, 1, 2, { kind: 'design' }),
        step(2, 3, 3, { kind: 'lab', skipped: true, planned_start_week: 2, planned_end_week: 2 }),
        step(3, 3, 6, { kind: 'elapsed' }),
      ];
      hooks.useGantt.mockReturnValue(ganttData({ rows: [project({ steps })] }));
      renderWithProviders(<GanttPage />);
      await user.click(screen.getByRole('button', { name: 'Expand steps for Cooler Alpha' }));
      expect(screen.getByTestId('skipped-chip')).toHaveTextContent('n/a');
      const stepRows = screen.getAllByTestId('gantt-step-row');
      expect(stepRows).toHaveLength(3);
      // skipped row: no bar rect at all
      expect(stepRows[1]?.querySelectorAll('rect[data-bar]')).toHaveLength(0);
      // elapsed row: hollow bar
      expect(stepRows[2]?.querySelector('rect[data-bar="elapsed"]')).toBeTruthy();
      expect(screen.getAllByText('Elp').length).toBeGreaterThan(0);
    });

    it('shows the blocked and stale chips from the server flags', () => {
      hooks.useGantt.mockReturnValue(
        ganttData({ rows: [project({ blocked: true, schedule_stale: true })] }),
      );
      renderWithProviders(<GanttPage />);
      // ADR 0017: `row.blocked` is shown as "On Hold".
      expect(screen.getByText('On Hold')).toBeInTheDocument();
      expect(screen.getByTestId('stale-chip')).toHaveAttribute(
        'title',
        'Progress or settings changed since this run',
      );
    });

    it('links every project row to its Project Workspace', () => {
      renderWithProviders(<GanttPage />);
      expect(
        screen.getByRole('link', { name: 'Open Cooler Alpha in the Project Workspace' }),
      ).toHaveAttribute('href', '/projects/p1');
    });

    it('P11: with Registration write the project row priority is a move dropdown (ADR 0015)', () => {
      renderWithProviders(<GanttPage />);
      expect(
        screen.getByRole('button', { name: 'Priority P1 for Cooler Alpha. Change priority' }),
      ).toBeInTheDocument();
    });

    it('P11: without Registration write the row keeps the read-only priority pill', () => {
      renderWithProviders(<GanttPage />, {
        session: { permissions: { ...fullPermissions(), project_registration: { read: true, write: false } } },
      });
      expect(screen.queryByTestId('priority-move-trigger')).not.toBeInTheDocument();
      expect(screen.getByTitle('Priority band P1 — Must do this year')).toHaveTextContent('P1');
    });

    it('a read-only role (gantt: read, no write) sees the timeline with no freeze control and a read-only notice', () => {
      renderWithProviders(<GanttPage />, {
        session: {
          roles: ['Executive Viewer'],
          permissions: {
            ...fullPermissions(),
            gantt: { read: true, write: false },
          },
        },
      });
      expect(screen.getByRole('button', { name: 'Expand steps for Cooler Alpha' })).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Freeze Cooler Alpha' })).not.toBeInTheDocument();
      expect(screen.getByTestId('read-only-notice')).toHaveTextContent(/Read-only for your role/);
    });
  });

  describe('reduced motion', () => {
    const realMatchMedia = window.matchMedia;
    afterEach(() => {
      window.matchMedia = realMatchMedia;
    });

    it('disables the layout animation on the focus accent when prefers-reduced-motion is set', async () => {
      window.matchMedia = ((query: string) =>
        ({
          matches: query.includes('reduce'),
          media: query,
          onchange: null,
          addListener: vi.fn(),
          removeListener: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
          dispatchEvent: vi.fn(),
        }) as unknown as MediaQueryList) as typeof window.matchMedia;

      const user = userEvent.setup();
      renderWithProviders(<GanttPage />);
      await user.click(screen.getByRole('button', { name: 'Expand steps for Cooler Alpha' }));
      const accent = await screen.findByTestId('gantt-focus-accent');
      expect(accent).toHaveAttribute('data-motion', 'false');
    });

    it('animates the focus accent by default (no reduced-motion preference)', async () => {
      const user = userEvent.setup();
      renderWithProviders(<GanttPage />);
      await user.click(screen.getByRole('button', { name: 'Expand steps for Cooler Alpha' }));
      const accent = await screen.findByTestId('gantt-focus-accent');
      expect(accent).toHaveAttribute('data-motion', 'true');
    });
  });

  describe('P13-T13 toolbar (API_CONTRACT_P13 §7)', () => {
    it('sends Type, Status, Leader, Step, Category, sort and the priority toggles to the server (two values each)', async () => {
      const user = userEvent.setup();
      renderWithProviders(<GanttPage />);
      // P40-T01: every filter is a compact multi-select dropdown.
      await user.click(screen.getByRole('button', { name: 'Type' }));
      await user.click(await screen.findByRole('option', { name: 'Cost Optimization' }));
      await user.click(screen.getByRole('option', { name: 'New Model' }));
      await user.keyboard('{Escape}');
      expect(screen.getByRole('button', { name: 'Type' })).toHaveAccessibleDescription('2 types');
      await user.click(screen.getByRole('button', { name: 'Status' }));
      await user.click(await screen.findByRole('option', { name: 'On Hold' }));
      await user.click(screen.getByRole('option', { name: 'In Queue' }));
      await user.keyboard('{Escape}');
      expect(screen.getByRole('button', { name: 'Status' })).toHaveAccessibleDescription('2 statuses');
      await user.click(screen.getByRole('button', { name: 'Leader' }));
      await user.click(await screen.findByRole('option', { name: 'Sam Super' }));
      await user.click(screen.getByRole('option', { name: 'Leader (name unavailable) · 0001' }));
      await user.keyboard('{Escape}');
      await user.click(screen.getByRole('button', { name: 'Current step' }));
      await user.click(await screen.findByRole('option', { name: 'PDD-E · Design Detailing' }));
      await user.keyboard('{Escape}');
      await user.click(screen.getByRole('button', { name: 'Category' }));
      await user.click(await screen.findByRole('option', { name: 'B' }));
      await user.click(screen.getByRole('option', { name: 'A+' }));
      await user.keyboard('{Escape}');
      await user.click(screen.getByRole('combobox', { name: 'Sort' }));
      await user.click(await screen.findByRole('option', { name: 'End week' }));
      await user.click(screen.getByRole('button', { name: 'Priority' }));
      await user.click(await screen.findByRole('option', { name: 'Q' }));
      await user.click(screen.getByRole('option', { name: 'P1' }));
      expect(screen.getByRole('option', { name: 'All priorities' })).toHaveAttribute('aria-selected', 'false');
      await user.keyboard('{Escape}');
      expect(screen.getByRole('button', { name: 'Priority' })).toHaveAccessibleDescription('P1, Q');
      expect(hooks.useGantt).toHaveBeenLastCalledWith({
        includeUnplaced: true, // P40-T03c
        // Option order, whatever the press order.
        type: ['NM', 'CO'],
        status: ['In Queue', 'On Hold'],
        leaderEngineerId: expect.arrayContaining(['eng-0002']) as unknown,
        currentStep: ['PDD-E'],
        category: ['A+', 'B'],
        sort: 'end',
        priority: ['P1', 'Q'],
      });
      expect((hooks.useGantt.mock.lastCall?.[0] as { leaderEngineerId?: string[] }).leaderEngineerId).toHaveLength(2);
      // "Clear filters" resets every filter but keeps the chosen sort.
      await user.click(screen.getByRole('button', { name: 'Clear filters' }));
      expect(hooks.useGantt).toHaveBeenLastCalledWith({ includeUnplaced: true, sort: 'end' });
    });

    it('P31 / P40-T01: legacy single-value links and repeated params both parse from the URL, for every filter', () => {
      renderWithProviders(<GanttPage />, {
        route:
          '/timeline?category=A&type=NM&type=SER&type=bogus&status=On%20Hold&priority=Q&priority=P2&priority=P9&step=PDD-E&step=XX&leader=eng-0002',
      });
      expect(hooks.useGantt).toHaveBeenLastCalledWith({
        includeUnplaced: true, // P40-T03c
        category: ['A'],
        type: ['NM', 'SER'],
        status: ['On Hold'],
        priority: ['P2', 'Q'],
        currentStep: ['PDD-E'],
        leaderEngineerId: ['eng-0002'],
        sort: 'priority',
      });
      expect(screen.getByRole('button', { name: 'Type' })).toHaveAccessibleDescription('2 types');
      expect(screen.getByRole('button', { name: 'Status' })).toHaveAccessibleDescription('On Hold');
      expect(screen.getByRole('button', { name: 'Current step' })).toHaveAccessibleDescription('PDD-E');
      expect(screen.getByRole('button', { name: 'Leader' })).toHaveAccessibleDescription('Sam Super');
    });

    it('P40-T01: Clear filters also clears the hub selection and keeps the sort', async () => {
      const user = userEvent.setup();
      act(() => useHubFilterStore.getState().setHubId('hub-india'));
      renderWithProviders(<GanttPage />, { route: '/timeline?status=On%20Hold' });
      expect(hooks.useGantt).toHaveBeenLastCalledWith({ includeUnplaced: true, hubIds: ['hub-india'], status: ['On Hold'], sort: 'priority' });
      await user.click(screen.getByRole('button', { name: 'Clear filters' }));
      expect(useHubFilterStore.getState().hubIds).toEqual([]);
      expect(hooks.useGantt).toHaveBeenLastCalledWith({ includeUnplaced: true, hubIds: undefined, sort: 'priority' });
      expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();
    });

    it('P40-T01: toolbar, legend & stats and Forest view have no serious axe violation', async () => {
      const user = userEvent.setup();
      const { container } = renderWithProviders(<GanttPage />);
      // Owner 2026-11-18: the charts are on by default.
      expect(screen.getByRole('button', { name: 'Hide charts' })).toBeInTheDocument();
      expect(await seriousAxeViolations(container)).toEqual([]);
      await user.click(screen.getByRole('button', { name: 'Forest view' }));
      expect(await seriousAxeViolations(container)).toEqual([]);
      // P40-T04 (qa): two full-page axe scans; ~4 s at load 20 on 10 cores, so the
      // 10 s default timed out under heavier parallel load. Slow, not failing.
    }, 90_000);

    it('P40-T01: the toolbar is one compact row with every control in it', () => {
      renderWithProviders(<GanttPage />);
      const bar = screen.getByTestId('gantt-toolbar');
      for (const name of ['Hub', 'Category', 'Type', 'Status', 'Leader', 'Current step', 'Priority']) {
        expect(within(bar).getByRole('button', { name })).toBeInTheDocument();
      }
      expect(within(bar).getByRole('searchbox', { name: 'Search' })).toBeInTheDocument();
      expect(within(bar).getByRole('combobox', { name: 'Sort' })).toBeInTheDocument();
      expect(within(bar).getByRole('button', { name: 'Forest view' })).toBeInTheDocument();
      expect(within(bar).getByRole('button', { name: 'Expand all' })).toBeInTheDocument();
      expect(within(bar).getByRole('button', { name: 'Collapse all' })).toBeInTheDocument();
      expect(within(bar).getByRole('button', { name: 'Hide charts' })).toBeInTheDocument();
      expect(within(bar).getByRole('button', { name: /Download/ })).toBeInTheDocument();
      // No chip rows and no label line any more.
      expect(screen.queryByRole('group', { name: 'Type' })).not.toBeInTheDocument();
      expect(screen.queryByRole('group', { name: 'Category' })).not.toBeInTheDocument();
      // The country segmented control left the page header (Hub covers countries).
      expect(screen.queryByRole('radiogroup', { name: /country/i })).not.toBeInTheDocument();
    });

    it('debounces the search and sends it as q (max 100 chars)', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
        renderWithProviders(<GanttPage />);
        const box = screen.getByRole('searchbox', { name: 'Search' });
        expect(box).toHaveAttribute('maxLength', '100');
        await user.type(box, '24-002');
        expect(hooks.useGantt).not.toHaveBeenCalledWith(expect.objectContaining({ q: '24-0' }));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(400);
        });
        expect(hooks.useGantt).toHaveBeenLastCalledWith({ includeUnplaced: true, q: '24-002', sort: 'priority' });
      } finally {
        vi.useRealTimers();
      }
    });

    it('labels a leader with no name, and hides Leader / Step without dashboard read', async () => {
      const user = userEvent.setup();
      const { unmount } = renderWithProviders(<GanttPage />);
      await user.click(screen.getByRole('button', { name: 'Leader' }));
      expect(await screen.findByRole('option', { name: 'Leader (name unavailable) · 0001' })).toBeInTheDocument();
      await user.keyboard('{Escape}');
      unmount();

      renderWithProviders(<GanttPage />, { session: { permissions: { ...fullPermissions(), dashboard: { read: false, write: false } } } });
      expect(hooks.useGanttFacets).toHaveBeenLastCalledWith({ hubIds: [], regions: [] }, false);
      expect(screen.queryByRole('button', { name: 'Leader' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Current step' })).not.toBeInTheDocument();
    });

    it('renders the row meta: leader or "Name unavailable", code, type and the served weeks', () => {
      hooks.useGantt.mockReturnValue(
        ganttData({
          rows: [
            project({ leader_name: 'Rishi', leader_engineer_id: 'eng-1', external_code: '24-00221_1', type: 'CO', total_weeks: 17, design_weeks: 5, lab_weeks: 0 }),
            project({ project_id: 'p2', project_name: 'Cooler Beta', leader_engineer_id: 'eng-2' }),
            project({ project_id: 'p3', project_name: 'Cooler Gamma' }),
            project({ project_id: 'p4', project_name: 'Cooler Delta', left_out: true }),
          ],
        }),
      );
      renderWithProviders(<GanttPage />);
      const [a, b, c, d] = screen.getAllByTestId('gantt-project-row');
      expect(within(a).getByTestId('gantt-row-meta')).toHaveTextContent('Rishi·24-00221_1·CO·R&D-Greece');
      expect(within(a).getByTestId('gantt-row-weeks')).toHaveTextContent('Total 17W · 5 DW / 0 LW');
      expect(within(b).getByTestId('gantt-row-meta')).toHaveTextContent('Name unavailable');
      expect(within(b).getByTestId('gantt-row-weeks')).toHaveTextContent('Not in the active run');
      // P24-T02: a null leader reads "No leader" (accessible "No leader assigned"), not a dash.
      const noLeader = within(c).getByTestId('no-leader');
      expect(noLeader).toHaveTextContent(/^No leaderNo leader assigned$/);
      expect(within(noLeader).getByText('No leader assigned')).toHaveClass('sr-only');
      expect(within(c).getByTestId('gantt-row-meta')).not.toHaveTextContent('—');
      // Left Out (served `left_out`) + no leader adds the hint; nothing else is inferred.
      expect(within(c).queryByTestId('no-leader-left-out')).not.toBeInTheDocument();
      expect(within(d).getByTestId('no-leader-left-out')).toHaveTextContent('Left out: no leader assigned');
    });

    it('charts are shown by default (owner 2026-11-18): summary, step legend and the served weekly PDD / OEM counts; Hide charts hides them', async () => {
      const user = userEvent.setup();
      renderWithProviders(<GanttPage />);
      expect(screen.getByRole('button', { name: 'Hide charts' })).toBeInTheDocument();
      // The step legend names each step's colour from the served step names.
      const legend = screen.getByTestId('gantt-step-legend-pdd');
      expect(within(legend).getAllByRole('listitem')).toHaveLength(14);
      expect(within(legend).getByTitle('PDD-E · Step 5')).toHaveAttribute('data-step-slot', '5');
      const pdd = screen.getByTestId('gantt-count-row-pdd');
      const w12 = pdd.querySelector('[data-week="12"]');
      expect(w12).toHaveTextContent('3');
      expect(screen.getByTestId('gantt-count-row-oem').querySelector('[data-week="12"]')).toHaveTextContent('1');
      expect(screen.getByRole('group', { name: 'Timeline summary' })).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Hide charts' }));
      expect(screen.getByRole('button', { name: 'Show charts' })).toBeInTheDocument();
      expect(screen.queryByTestId('gantt-weekly-stats')).not.toBeInTheDocument();
      expect(screen.queryByRole('group', { name: 'Timeline summary' })).not.toBeInTheDocument();
      expect(screen.queryByTestId('gantt-legend')).not.toBeInTheDocument();
    });

    it('remembers the charts toggle in localStorage across mounts (owner 2026-11-18)', async () => {
      const user = userEvent.setup();
      const first = renderWithProviders(<GanttPage />);
      await user.click(screen.getByRole('button', { name: 'Hide charts' }));
      expect(window.localStorage.getItem('rpd.gantt.showDetails')).toBe('false');
      first.unmount();

      renderWithProviders(<GanttPage />);
      expect(screen.getByRole('button', { name: 'Show charts' })).toBeInTheDocument();
      expect(screen.queryByTestId('gantt-weekly-stats')).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Show charts' }));
      expect(window.localStorage.getItem('rpd.gantt.showDetails')).toBe('true');
      expect(screen.getByTestId('gantt-weekly-stats')).toBeInTheDocument();
    });

    it('Forest view is the name and one line per project only; the px zoom resizes the axis only', async () => {
      const user = userEvent.setup();
      renderWithProviders(<GanttPage />);
      expect(screen.getByTestId('gantt-row-meta')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Expand steps for Cooler Alpha' }));
      expect(screen.getAllByTestId('gantt-step-row')).toHaveLength(14);
      await user.click(screen.getByRole('button', { name: 'Forest view' }));
      expect(screen.queryByTestId('gantt-row-meta')).not.toBeInTheDocument();
      const row = screen.getByTestId('gantt-project-row');
      // Name only: no expand control, priority pill, links, chips, status column or step rows.
      expect(within(row).getByTestId('gantt-forest-name')).toHaveTextContent('Cooler Alpha');
      expect(within(row).queryAllByRole('button')).toHaveLength(0);
      expect(within(row).queryAllByRole('link')).toHaveLength(0);
      expect(within(row).queryByTestId('gantt-status-cell')).not.toBeInTheDocument();
      expect(screen.queryByTestId('gantt-status-header')).not.toBeInTheDocument();
      expect(screen.queryAllByTestId('gantt-step-row')).toHaveLength(0);
      expect(screen.getByRole('button', { name: 'Expand all' })).toBeDisabled();
      // One execution line, a segment per step, no letters and no completion markers.
      expect(within(row).getAllByTestId('gantt-project-line')).toHaveLength(1);
      expect(row.querySelectorAll('rect[data-bar="planned"], rect[data-bar="elapsed"]')).toHaveLength(14);
      expect(within(row).queryByTestId('gantt-step-letter')).not.toBeInTheDocument();
      expect(within(row).queryByTestId('gantt-marker-expected')).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Zoom in' }));
      expect(screen.getByRole('img', { name: 'Week axis, Week 1 of 2026 to Week 52 of 2027' })).toHaveAttribute('width', String(104 * 20));
      expect(screen.getByRole('slider', { name: 'Zoom' })).toHaveValue('20');
      // Zoom is a rendering concern: the query params are unchanged.
      expect(hooks.useGantt).toHaveBeenLastCalledWith({ includeUnplaced: true, sort: 'priority' });
    });
  });
});

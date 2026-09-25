import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import { ApiError } from '@/lib/api/client';
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
  }),
}));

const hooks = {
  useGantt: vi.fn(),
  useActiveScheduleRun: vi.fn(),
  useToggleFreeze: vi.fn(),
};
vi.mock('./hooks/use-gantt', () => ({
  useGantt: (args: unknown) => hooks.useGantt(args),
  useActiveScheduleRun: (enabled: boolean) => hooks.useActiveScheduleRun(enabled),
  useToggleFreeze: () => hooks.useToggleFreeze(),
}));
vi.mock('@/lib/api/reference', () => ({
  useHubs: () => ({
    data: [
      { id: 'hub-greece', name: 'R&D-Greece', lab_region: 'Greece', is_oem: false },
      { id: 'hub-india', name: 'R&D-India', lab_region: 'India', is_oem: false },
    ],
  }),
}));

import GanttPage from './GanttPage';

function step(seq: number, start: number, end: number, over: Partial<GanttStepRow> = {}): GanttStepRow {
  return {
    step_id: `PDD-${String.fromCharCode(64 + seq)}`,
    step_name: `Step ${String(seq)}`,
    kind: seq % 2 === 0 ? 'lab' : 'design',
    sequence_order: seq,
    duration_weeks: end - start + 1,
    planned_start_week: start,
    planned_end_week: end,
    actual_start_week: null,
    actual_end_week: null,
    assigned_engineer_name: null,
    assigned_chamber_code: null,
    eng_conflict: false,
    chamber_overlap: false,
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
  hooks.useActiveScheduleRun.mockReturnValue({ data: null });
  hooks.useToggleFreeze.mockReturnValue({ mutateAsync: vi.fn().mockResolvedValue({}) });
  hooks.useGantt.mockReturnValue(ganttData());
});

describe('GanttPage', () => {
  it('always renders the heading and the zoom control', () => {
    renderWithProviders(<GanttPage />);
    expect(
      screen.getByRole('heading', { name: 'Project Execution Timeline' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'Weeks zoom' })).toBeInTheDocument();
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
    expect(screen.queryByRole('radio', { name: 'Weeks zoom' })).toBeInTheDocument(); // header stays
    expect(screen.queryByText('Execution timeline')).not.toBeInTheDocument();
  });

  it('changing the hub filter re-requests the Gantt with the new hub id (query key input)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<GanttPage />);
    expect(hooks.useGantt).toHaveBeenLastCalledWith({ hubId: undefined });
    await user.click(screen.getByRole('combobox', { name: 'Hub' }));
    await user.click(screen.getByRole('option', { name: 'R&D-India' }));
    expect(hooks.useGantt).toHaveBeenLastCalledWith({ hubId: 'hub-india' });
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
});

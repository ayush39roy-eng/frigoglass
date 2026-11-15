import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UseQueryResult } from '@tanstack/react-query';

import { renderWithProviders } from '@/test/render';
import { seriousAxeViolations } from '@/test/axe';
import { ROLE_MATRIX } from '@/test/roles';
import type { ProjectFilterParams, ProjectFilterResult, ProjectFilterRow } from '@/surfaces/dashboard/api/types';
import { P13_ROW_DEFAULTS } from '@/surfaces/dashboard/test-fixtures';

/**
 * P35-T02 / P35-T08: the Projects register's Edit mode, bulk bar, unassigned
 * flag and per-user columns. The list hook is mocked at the hook; the batch
 * save and the engineer list at the HTTP client, so these tests pin the ONE
 * `POST /projects/register-edits` body the grid sends.
 */

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 60,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ key: index, index, start: index * 60, size: 60 })),
    measureElement: () => undefined,
    measure: () => undefined,
    scrollToIndex: () => undefined,
  }),
}));

const useDashboardProjects = vi.fn();
vi.mock('@/surfaces/dashboard/hooks/use-dashboard', () => ({
  useDashboardProjects: (params: ProjectFilterParams) => useDashboardProjects(params),
  useProjectFacets: () => ({ data: { leaders: [], steps: [] } }),
}));
vi.mock('@/lib/api/reference', () => ({
  useHubs: () => ({
    data: [
      { id: 'hub-1', name: 'R&D-Greece', lab_region: 'Greece', is_oem: false, capacity_hub_id: null, capacity_hub_name: null },
      { id: 'hub-2', name: 'PD-India', lab_region: 'India', is_oem: false, capacity_hub_id: null, capacity_hub_name: null },
    ],
  }),
  useCategoriesForHub: () => ({ data: undefined, options: ['A+', 'A', 'B', 'C'] }),
}));
vi.mock('@/surfaces/project-workspace/api/workspace-api', () => ({ askAgent: vi.fn() }));
vi.mock('@/lib/download', () => ({ saveBlob: vi.fn() }));
const sse = vi.hoisted(() => ({ stream: vi.fn() }));
vi.mock('@/lib/api/sse', () => ({ streamSolverProgress: (...a: unknown[]) => sse.stream(...a) }));

const http = vi.hoisted(() => ({ get: vi.fn(), send: vi.fn(), sendWithHeaders: vi.fn(), download: vi.fn() }));
vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return {
    ...actual,
    apiGet: (path: string, opts?: unknown) => http.get(path, opts),
    apiSend: (method: string, path: string, body?: unknown) => http.send(method, path, body),
    apiSendWithHeaders: (method: string, path: string, body?: unknown) => http.sendWithHeaders(method, path, body),
    apiDownload: (path: string, opts: unknown) => http.download(path, opts),
  };
});

import { ApiError } from '@/lib/api/client';
import { columnPrefsKey } from './lib/column-prefs';
import ProjectsPage from './ProjectsPage';

vi.setConfig({ testTimeout: 30_000 });

function ok(rows: ProjectFilterRow[]): UseQueryResult<ProjectFilterResult> {
  return {
    data: { total_count: rows.length, rows },
    isPending: false,
    isError: false,
    refetch: vi.fn(),
  } as unknown as UseQueryResult<ProjectFilterResult>;
}

function row(id: string, overrides: Partial<ProjectFilterRow> = {}): ProjectFilterRow {
  return {
    project_id: id,
    project_name: `Project ${id}`,
    hub: 'R&D-Greece',
    category: 'B',
    status: 'In Development',
    priority: 'P2',
    is_vip: false,
    tracking_status: 'idle',
    ...P13_ROW_DEFAULTS,
    leader_engineer_id: 'eng-1',
    leader_name: null,
    design_weeks_calculated: 10,
    lab_weeks_calculated: 6,
    ...overrides,
  };
}

const ENGINEERS = [
  { id: 'eng-1', name: 'Nikos Papas', hub_id: 'hub-1' },
  { id: 'eng-2', name: 'Maria Kosta', hub_id: 'hub-1' },
];

function rowEl(name: string): HTMLElement {
  const link = screen.getByRole('link', { name });
  const el = link.closest<HTMLElement>('[role="row"]');
  if (!el) throw new Error(`no row for ${name}`);
  return el;
}

const saveBody = () => {
  const call = http.send.mock.calls.find((c) => c[1] === '/projects/register-edits');
  return call?.[2] as { edits: Record<string, unknown>[] } | undefined;
};

const NOT_NEEDED = {
  project_ids: ['a'],
  projects_marked_stale: [],
  recalc_status: 'not_needed',
  schedule_run_id: null,
  baseline_run_id: null,
  task_id: null,
};

async function startEdit(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByTestId('register-edit-start'));
  expect(screen.getByTestId('register-edit-mode')).toBeInTheDocument();
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  http.get.mockImplementation((path: string) => {
    if (path === '/engineers') return Promise.resolve(ENGINEERS);
    return Promise.reject(new ApiError(404, 'not found'));
  });
  http.send.mockResolvedValue(NOT_NEEDED);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Projects register — design / lab time (D35-1)', () => {
  it('shows the calculated weeks in green with no figure and a typed figure in orange', () => {
    useDashboardProjects.mockReturnValue(
      ok([row('a', { project_name: 'Alpha' }), row('b', { project_name: 'Beta', design_effort_weeks: 4 })]),
    );
    renderWithProviders(<ProjectsPage />);

    const [autoDesign, autoLab] = within(rowEl('Alpha')).getAllByTestId('effort-value');
    expect(autoDesign).toHaveAttribute('data-source', 'calculated');
    expect(autoDesign).toHaveAttribute('title', 'Calculated: 10 wk');
    expect(autoDesign).toHaveClass('text-success-subtle-fg');
    expect(autoDesign).toHaveTextContent('10 wk');
    expect(autoLab).toHaveAttribute('title', 'Calculated: 6 wk');

    const [manual] = within(rowEl('Beta')).getAllByTestId('effort-value');
    expect(manual).toHaveAttribute('data-source', 'manual');
    expect(manual).toHaveAttribute('title', 'Manual (calculated: 10 wk)');
    expect(manual).toHaveClass('text-warning-subtle-fg');
    expect(manual).toHaveTextContent('4 wk');
  });

  it('in Edit mode a typed figure turns orange; "↺ reset" clears it and Save sends null', async () => {
    const user = userEvent.setup();
    useDashboardProjects.mockReturnValue(
      ok([row('a', { project_name: 'Alpha' }), row('b', { project_name: 'Beta', design_effort_weeks: 4 })]),
    );
    renderWithProviders(<ProjectsPage />);
    await startEdit(user);

    const [alphaDesign] = within(rowEl('Alpha')).getAllByTestId('effort-input');
    expect(alphaDesign).toHaveAttribute('data-source', 'calculated');
    expect(alphaDesign).toHaveAttribute('placeholder', '10');
    expect(alphaDesign).toHaveAttribute('title', 'Calculated: 10 wk');
    await user.type(alphaDesign!, '7');
    expect(alphaDesign).toHaveAttribute('data-source', 'manual');
    expect(alphaDesign).toHaveAttribute('title', 'Manual (calculated: 10 wk)');

    const beta = rowEl('Beta');
    await user.click(within(beta).getByRole('button', { name: 'Reset Design time of Beta to the calculated 10 wk' }));
    expect(within(beta).getAllByTestId('effort-input')[0]).toHaveAttribute('data-source', 'calculated');

    await user.click(screen.getByTestId('register-edit-save'));
    await waitFor(() => expect(saveBody()).toBeDefined());
    expect(http.send.mock.calls.filter((c) => c[1] === '/projects/register-edits')).toHaveLength(1);
    expect(saveBody()).toEqual({
      edits: [
        { project_id: 'a', design_effort_weeks: 7 },
        { project_id: 'b', design_effort_weeks: null },
      ],
    });
    expect(await screen.findByTestId('register-save-panel')).toHaveTextContent('Edits saved');
    expect(screen.queryByTestId('register-edit-bar')).not.toBeInTheDocument();
  });
});

describe('Projects register — Edit mode (D35-2)', () => {
  it('sends ONE batch with only the changed fields: status, leader and actual dates', async () => {
    const user = userEvent.setup();
    useDashboardProjects.mockReturnValue(
      ok([row('a', { project_name: 'Alpha' }), row('b', { project_name: 'Beta', actual_start_week: 10 }), row('c', { project_name: 'Gamma' })]),
    );
    renderWithProviders(<ProjectsPage />);
    await startEdit(user);

    await user.selectOptions(screen.getByRole('combobox', { name: 'Status of Alpha' }), 'On Hold');
    const leader = screen.getByRole('combobox', { name: 'Design resource (leader) of Alpha' });
    await within(leader).findByRole('option', { name: 'Maria Kosta' });
    await user.selectOptions(leader, 'eng-2');
    fireEvent.change(screen.getByLabelText(/^Actual end of Beta/), { target: { value: '2026-03-02' } });
    expect(screen.getByTestId('register-edit-count')).toHaveTextContent('2 projects changed');

    await user.click(screen.getByTestId('register-edit-save'));
    await waitFor(() => expect(saveBody()).toBeDefined());
    expect(saveBody()).toEqual({
      edits: [
        { project_id: 'a', status: 'On Hold', leader_engineer_id: 'eng-2' },
        { project_id: 'b', actual_end_week: 10 },
      ],
    });
  });

  it('warns inline when the actual end is before the actual start', async () => {
    const user = userEvent.setup();
    useDashboardProjects.mockReturnValue(ok([row('a', { project_name: 'Alpha', actual_start_week: 10 })]));
    renderWithProviders(<ProjectsPage />);
    await startEdit(user);
    const end = screen.getByLabelText(/^Actual end of Alpha/);
    fireEvent.change(end, { target: { value: '2026-02-02' } }); // W6
    expect(within(rowEl('Alpha')).getByTestId('week-warning')).toHaveTextContent('End is before start');
    expect(end).toHaveAttribute('aria-invalid', 'true');
    fireEvent.change(end, { target: { value: '2026-04-06' } }); // W15
    expect(within(rowEl('Alpha')).queryByTestId('week-warning')).not.toBeInTheDocument();
  });

  it('shows 422 REGISTER_EDITS_INVALID errors on their rows and cells, and keeps the edits', async () => {
    const user = userEvent.setup();
    useDashboardProjects.mockReturnValue(
      ok([row('a', { project_name: 'Alpha', actual_start_week: 10 }), row('b', { project_name: 'Beta' })]),
    );
    http.send.mockRejectedValue(
      new ApiError(
        422,
        'invalid',
        JSON.stringify({
          code: 'REGISTER_EDITS_INVALID',
          message: 'One or more rows are invalid.',
          errors: [{ project_id: 'a', code: 'ACTUAL_END_BEFORE_START', message: 'actual_end_week 6 is before actual_start_week 10' }],
        }),
        'REGISTER_EDITS_INVALID',
      ),
    );
    renderWithProviders(<ProjectsPage />);
    await startEdit(user);
    fireEvent.change(screen.getByLabelText(/^Actual end of Alpha/), { target: { value: '2026-02-02' } });
    await user.selectOptions(screen.getByRole('combobox', { name: 'Status of Beta' }), 'On Hold');
    await user.click(screen.getByTestId('register-edit-save'));

    const alpha = rowEl('Alpha');
    expect(await within(alpha).findByTestId('row-error')).toHaveTextContent('Actual end is before actual start.');
    expect(alpha).toHaveAttribute('data-row-error');
    expect(rowEl('Beta')).not.toHaveAttribute('data-row-error');
    expect(screen.getByTestId('register-edit-error')).toHaveTextContent('Nothing was saved. Fix the highlighted rows');
    // Still editing, with both edits kept.
    expect(screen.getByTestId('register-edit-count')).toHaveTextContent('2 projects changed');
    expect(screen.queryByTestId('register-save-panel')).not.toBeInTheDocument();
  });

  it('a 429 says to wait and saves nothing', async () => {
    const user = userEvent.setup();
    useDashboardProjects.mockReturnValue(ok([row('a', { project_name: 'Alpha' })]));
    http.send.mockRejectedValue(new ApiError(429, 'slow down', 'Too many', 'RATE_LIMITED', 4));
    renderWithProviders(<ProjectsPage />);
    await startEdit(user);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Status of Alpha' }), 'On Hold');
    await user.click(screen.getByTestId('register-edit-save'));
    expect(await screen.findByTestId('register-edit-error')).toHaveTextContent('wait 4 s and save again');
  });

  it('P36-R03: a 503 BAND_RANK_BUSY shows the contract copy, keeps the edits and does not retry', async () => {
    const user = userEvent.setup();
    useDashboardProjects.mockReturnValue(ok([row('a', { project_name: 'Alpha' })]));
    http.send.mockRejectedValue(new ApiError(503, 'Service Unavailable', 'busy', 'BAND_RANK_BUSY', 5));
    renderWithProviders(<ProjectsPage />);
    await startEdit(user);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Status of Alpha' }), 'On Hold');
    await user.click(screen.getByTestId('register-edit-save'));
    expect(await screen.findByTestId('register-edit-error')).toHaveTextContent(
      'Another priority change is being saved. Please try again in a moment.',
    );
    expect(http.send).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('combobox', { name: 'Status of Alpha' })).toHaveValue('On Hold');
  });

  it('403 FORBIDDEN_PROJECT rows become read-only and their edits are dropped', async () => {
    const user = userEvent.setup();
    useDashboardProjects.mockReturnValue(ok([row('a', { project_name: 'Alpha' }), row('b', { project_name: 'Beta' })]));
    http.send.mockRejectedValueOnce(
      new ApiError(
        403,
        'forbidden',
        JSON.stringify({
          code: 'REGISTER_EDITS_FORBIDDEN',
          message: 'Forbidden',
          errors: [{ project_id: 'b', code: 'FORBIDDEN_PROJECT', message: 'Not allowed' }],
        }),
        'REGISTER_EDITS_FORBIDDEN',
      ),
    );
    renderWithProviders(<ProjectsPage />);
    await startEdit(user);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Status of Alpha' }), 'On Hold');
    await user.selectOptions(screen.getByRole('combobox', { name: 'Status of Beta' }), 'On Hold');
    await user.click(screen.getByTestId('register-edit-save'));

    const beta = rowEl('Beta');
    expect(await within(beta).findByTestId('row-error')).toHaveTextContent('You cannot edit this project.');
    expect(beta).toHaveAttribute('data-readonly');
    expect(within(beta).queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.getByTestId('register-edit-count')).toHaveTextContent('1 project changed');
  });

  it('rows outside the caller hub scope stay read-only; Draft rows keep their status badge', async () => {
    const user = userEvent.setup();
    useDashboardProjects.mockReturnValue(
      ok([
        row('a', { project_name: 'Alpha' }),
        row('b', { project_name: 'Beta', hub: 'PD-India', region: 'India' }),
        row('c', { project_name: 'Gamma', status: 'Draft' }),
      ]),
    );
    renderWithProviders(<ProjectsPage />, { session: { hub_scope_all: false, hub_ids: ['hub-1'] } });
    await startEdit(user);

    const beta = rowEl('Beta');
    expect(beta).toHaveAttribute('data-readonly');
    expect(within(beta).getByTestId('row-readonly')).toHaveTextContent('Read-only: you cannot edit Beta');
    expect(within(beta).queryByRole('combobox')).not.toBeInTheDocument();
    expect(within(beta).queryByRole('checkbox')).not.toBeInTheDocument();
    expect(within(rowEl('Alpha')).getByRole('combobox', { name: 'Status of Alpha' })).toBeInTheDocument();
    // A Draft row leaves Draft through Submit (ADR 0034): no status select, other fields editable.
    const gamma = rowEl('Gamma');
    expect(within(gamma).queryByRole('combobox', { name: 'Status of Gamma' })).not.toBeInTheDocument();
    expect(within(gamma).getByRole('combobox', { name: 'Design resource (leader) of Gamma' })).toBeInTheDocument();
  });

  it('a read-only role gets no Edit button', () => {
    useDashboardProjects.mockReturnValue(ok([row('a', { project_name: 'Alpha' })]));
    renderWithProviders(<ProjectsPage />, {
      session: { roles: ['Executive Viewer'], permissions: ROLE_MATRIX['Executive Viewer'] },
    });
    expect(screen.queryByTestId('register-edit-start')).not.toBeInTheDocument();
  });

  it('Cancel with unsaved edits asks first; reload is guarded while edits are unsaved', async () => {
    const user = userEvent.setup();
    useDashboardProjects.mockReturnValue(ok([row('a', { project_name: 'Alpha' })]));
    renderWithProviders(<ProjectsPage />);
    await startEdit(user);

    // No edits yet: Cancel just leaves.
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByTestId('register-edit-bar')).not.toBeInTheDocument();

    await startEdit(user);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Status of Alpha' }), 'On Hold');
    const unload = new Event('beforeunload', { cancelable: true });
    act(() => {
      window.dispatchEvent(unload);
    });
    expect(unload.defaultPrevented).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    const dialog = await screen.findByTestId('register-discard-dialog');
    expect(dialog).toHaveTextContent('1 project has unsaved edits');
    await user.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    expect(screen.getByRole('combobox', { name: 'Status of Alpha' })).toHaveValue('On Hold');

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    await user.click(within(await screen.findByTestId('register-discard-dialog')).getByRole('button', { name: 'Discard changes' }));
    expect(screen.queryByTestId('register-edit-bar')).not.toBeInTheDocument();
    expect(http.send).not.toHaveBeenCalled();
    const after = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
  });

  it('a queued save follows the run and reports the timeline updated', async () => {
    const user = userEvent.setup();
    useDashboardProjects.mockReturnValue(ok([row('a', { project_name: 'Alpha' })]));
    http.send.mockResolvedValue({ ...NOT_NEEDED, recalc_status: 'queued', schedule_run_id: 'run-9', task_id: 't' });
    sse.stream.mockResolvedValue({ status: 'completed' });
    renderWithProviders(<ProjectsPage />);
    await startEdit(user);
    await user.selectOptions(screen.getByRole('combobox', { name: 'Status of Alpha' }), 'On Hold');
    await user.click(screen.getByTestId('register-edit-save'));
    const panel = await screen.findByTestId('register-save-panel');
    await waitFor(() => expect(panel).toHaveAttribute('data-kind', 'updated'));
    expect(sse.stream).toHaveBeenCalledWith('run-9', expect.any(Function), expect.anything());
    expect(panel).toHaveTextContent('Timeline updated');
  });
});

describe('Projects register — P35-T08 extras', () => {
  it('the bulk bar stages status and times on every ticked row, saved in the same batch', async () => {
    const user = userEvent.setup();
    useDashboardProjects.mockReturnValue(
      ok([row('a', { project_name: 'Alpha' }), row('b', { project_name: 'Beta' }), row('c', { project_name: 'Gamma' })]),
    );
    renderWithProviders(<ProjectsPage />);
    await startEdit(user);
    expect(screen.queryByTestId('bulk-edit-bar')).not.toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: 'Select Alpha' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select Gamma' }));
    const bar = screen.getByTestId('bulk-edit-bar');
    expect(within(bar).getByTestId('bulk-selected-count')).toHaveTextContent('2 selected');

    await user.selectOptions(within(bar).getByLabelText('Status'), 'Commercialized');
    await user.click(within(bar).getByTestId('bulk-status-apply'));
    await user.type(within(bar).getByLabelText('Lab time (wk)'), '3.5');
    await user.click(within(bar).getByTestId('bulk-times-apply'));
    const leader = within(bar).getByLabelText('Design resource (leader)');
    await waitFor(() => expect(leader).toBeEnabled());
    await user.selectOptions(leader, 'Unassigned');
    await user.click(within(bar).getByTestId('bulk-leader-apply'));

    expect(screen.getByRole('combobox', { name: 'Status of Alpha' })).toHaveValue('Commercialized');
    expect(screen.getByRole('combobox', { name: 'Status of Beta' })).toHaveValue('In Development');
    expect(screen.getByRole('combobox', { name: 'Status of Gamma' })).toHaveValue('Commercialized');
    // The Unassigned flag follows the draft leader.
    expect(within(rowEl('Alpha')).getByTestId('unassigned-flag')).toBeInTheDocument();
    expect(within(rowEl('Beta')).queryByTestId('unassigned-flag')).not.toBeInTheDocument();
    expect(screen.getByTestId('register-edit-count')).toHaveTextContent('2 projects changed');

    await user.click(screen.getByTestId('register-edit-save'));
    await waitFor(() => expect(saveBody()).toBeDefined());
    const staged = { status: 'Commercialized', lab_effort_weeks: 3.5, leader_engineer_id: null };
    expect(saveBody()).toEqual({ edits: [{ project_id: 'a', ...staged }, { project_id: 'c', ...staged }] });
  });

  it('select-all ticks every editable row shown', async () => {
    const user = userEvent.setup();
    useDashboardProjects.mockReturnValue(
      ok([row('a', { project_name: 'Alpha' }), row('b', { project_name: 'Beta', hub: 'PD-India', region: 'India' })]),
    );
    renderWithProviders(<ProjectsPage />, { session: { hub_scope_all: false, hub_ids: ['hub-1'] } });
    await startEdit(user);
    await user.click(screen.getByRole('checkbox', { name: 'Select every editable row shown' }));
    expect(screen.getByTestId('bulk-selected-count')).toHaveTextContent('1 selected');
  });

  it('hides a column and persists it for this user; a dragged width is stored too', async () => {
    const user = userEvent.setup();
    useDashboardProjects.mockReturnValue(ok([row('a', { project_name: 'Alpha' })]));
    const { unmount } = renderWithProviders(<ProjectsPage />);
    expect(screen.getByRole('columnheader', { name: 'Lab time' })).toBeInTheDocument();

    await user.click(screen.getByTestId('column-menu-trigger'));
    await user.click(await screen.findByRole('menuitemcheckbox', { name: 'Lab time' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('columnheader', { name: 'Lab time' })).not.toBeInTheDocument();

    const handle = screen.getByRole('separator', { name: 'Resize Hub column' });
    handle.focus();
    await user.keyboard('{ArrowRight}');
    const stored = JSON.parse(window.localStorage.getItem(columnPrefsKey('user-super')) ?? '{}') as {
      hidden: string[];
      widths: Record<string, number>;
    };
    expect(stored.hidden).toEqual(['lab-time']);
    expect(stored.widths.hub).toBeGreaterThan(0);

    unmount();
    renderWithProviders(<ProjectsPage />);
    expect(screen.queryByRole('columnheader', { name: 'Lab time' })).not.toBeInTheDocument();
  });

  it('still works when localStorage throws on every read and write', async () => {
    const user = userEvent.setup();
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    useDashboardProjects.mockReturnValue(ok([row('a', { project_name: 'Alpha' })]));
    renderWithProviders(<ProjectsPage />);
    expect(screen.getByRole('link', { name: 'Alpha' })).toBeInTheDocument();

    await user.click(screen.getByTestId('column-menu-trigger'));
    await user.click(await screen.findByRole('menuitemcheckbox', { name: 'Design time' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('columnheader', { name: 'Design time' })).not.toBeInTheDocument();

    await user.click(screen.getByTestId('column-menu-trigger'));
    await user.click(await screen.findByTestId('column-reset'));
    expect(screen.getByRole('columnheader', { name: 'Design time' })).toBeInTheDocument();
  });

  it('has no serious axe violations in Edit mode with the bulk bar open', async () => {
    const user = userEvent.setup();
    useDashboardProjects.mockReturnValue(
      ok([row('a', { project_name: 'Alpha', design_effort_weeks: 4, actual_start_week: 10 }), row('b', { project_name: 'Beta', leader_engineer_id: null })]),
    );
    const { container } = renderWithProviders(<ProjectsPage />);
    await startEdit(user);
    await user.click(screen.getByRole('checkbox', { name: 'Select Alpha' }));
    expect(await seriousAxeViolations(container)).toEqual([]);
  });
});

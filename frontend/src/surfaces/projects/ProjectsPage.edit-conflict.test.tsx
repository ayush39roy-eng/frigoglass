import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UseQueryResult } from '@tanstack/react-query';

import { renderWithProviders } from '@/test/render';
import type { ProjectFilterParams, ProjectFilterResult, ProjectFilterRow } from '@/surfaces/dashboard/api/types';
import { P13_ROW_DEFAULTS } from '@/surfaces/dashboard/test-fixtures';

/**
 * P47-T03 (ADR 0059 C1 / C2): the Projects register's batch save with the
 * field-level conflict check. The grid sends each row's `base`; a 409
 * `EDIT_CONFLICT` opens the conflict dialog; "Keep mine" resends with `base`
 * = the stored values; "Use theirs" drops only the conflicting field and keeps
 * every other edit in the buffer; the 60 s poll pauses while a row is in edit.
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
  useDashboardProjects: (params: ProjectFilterParams, freshness?: unknown) => useDashboardProjects(params, freshness),
  useProjectFacets: () => ({ data: { leaders: [], steps: [] } }),
}));
vi.mock('@/lib/api/reference', () => ({
  useHubs: () => ({
    data: [{ id: 'hub-1', name: 'R&D-Greece', lab_region: 'Greece', is_oem: false, capacity_hub_id: null, capacity_hub_name: null }],
  }),
  useCategoriesForHub: () => ({ data: undefined, options: ['A+', 'A', 'B', 'C'] }),
}));
vi.mock('@/surfaces/project-workspace/api/workspace-api', () => ({ askAgent: vi.fn() }));
vi.mock('@/lib/download', () => ({ saveBlob: vi.fn() }));
vi.mock('@/lib/api/sse', () => ({ streamSolverProgress: vi.fn() }));

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
import { EDIT_POLL_MS } from '@/lib/use-edit-freshness';
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

const NOT_NEEDED = {
  project_ids: ['a', 'b'],
  projects_marked_stale: [],
  recalc_status: 'not_needed',
  schedule_run_id: null,
  baseline_run_id: null,
  task_id: null,
};

const CHANGED_AT = '2026-11-18T09:05:00Z';

/** The 409 the server answers when Alpha's status was saved by someone else meanwhile. */
function conflict409(): ApiError {
  const body = {
    code: 'EDIT_CONFLICT',
    detail: 'Someone else changed this while you were editing.',
    conflicts: [
      {
        entity: 'project',
        id: 'a',
        label: 'Alpha',
        field: 'status',
        your_value: 'On Hold',
        current_value: 'Cancelled',
        changed_by: 'Maria Kosta',
        changed_at: CHANGED_AT,
      },
    ],
  };
  return new ApiError(409, 'Request failed (409 Conflict)', body.detail, 'EDIT_CONFLICT', undefined, body);
}

const batchCalls = () => http.send.mock.calls.filter((c) => c[1] === '/projects/register-edits');

async function editAlphaAndBeta(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'Edit Alpha' }));
  await user.click(screen.getByRole('button', { name: 'Edit Beta' }));
  await user.selectOptions(screen.getByRole('combobox', { name: 'Status of Alpha' }), 'On Hold');
  await user.selectOptions(screen.getByRole('combobox', { name: 'Status of Beta' }), 'On Hold');
  expect(screen.getByTestId('register-edit-count')).toHaveTextContent('2 projects changed');
}

function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  http.get.mockImplementation((path: string) => {
    if (path === '/engineers') return Promise.resolve([{ id: 'eng-1', name: 'Nikos Papas', hub_id: 'hub-1' }]);
    return Promise.reject(new ApiError(404, 'not found'));
  });
  useDashboardProjects.mockReturnValue(ok([row('a', { project_name: 'Alpha' }), row('b', { project_name: 'Beta' })]));
});

describe('Projects register — concurrent edits (ADR 0059)', () => {
  it('a 409 shows the conflict dialog; "Keep mine" resends with base = the stored value', async () => {
    const user = userEvent.setup();
    http.send.mockRejectedValueOnce(conflict409()).mockResolvedValueOnce(NOT_NEEDED);
    renderWithProviders(<ProjectsPage />);
    await editAlphaAndBeta(user);
    await user.click(screen.getByTestId('register-edit-save'));

    const dialog = await screen.findByTestId('edit-conflict-dialog');
    const item = within(dialog).getByTestId('edit-conflict-item');
    expect(item).toHaveTextContent('Alpha: Status');
    expect(item).toHaveTextContent('You enteredOn Hold');
    expect(item).toHaveTextContent('Now savedCancelled');
    expect(item).toHaveTextContent(new RegExp(`Changed by Maria Kosta (on .* )?at ${hhmm(CHANGED_AT)}`));
    expect(within(dialog).getByText(/Your other edits stay in the edit buffer/)).toBeInTheDocument();

    // The first request carried each row's base, as read.
    expect(batchCalls()[0]![2]).toEqual({
      edits: [
        { project_id: 'a', status: 'On Hold', base: { status: 'In Development' } },
        { project_id: 'b', status: 'On Hold', base: { status: 'In Development' } },
      ],
    });

    await user.click(within(dialog).getByRole('button', { name: 'Keep mine' }));
    await waitFor(() => expect(batchCalls()).toHaveLength(2));
    // A deliberate overwrite: Alpha's base is now the stored value; Beta's is unchanged.
    expect(batchCalls()[1]![2]).toEqual({
      edits: [
        { project_id: 'a', status: 'On Hold', base: { status: 'Cancelled' } },
        { project_id: 'b', status: 'On Hold', base: { status: 'In Development' } },
      ],
    });
    expect(await screen.findByTestId('register-save-panel')).toHaveTextContent('Edits saved');
    expect(screen.queryByTestId('edit-conflict-dialog')).not.toBeInTheDocument();
  });

  it('"Use theirs" drops only the conflicting field; the other edits stay in the buffer, unsaved', async () => {
    const user = userEvent.setup();
    http.send.mockRejectedValueOnce(conflict409()).mockResolvedValue(NOT_NEEDED);
    renderWithProviders(<ProjectsPage />);
    await editAlphaAndBeta(user);
    await user.click(screen.getByTestId('register-edit-save'));

    const dialog = await screen.findByTestId('edit-conflict-dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Use theirs' }));

    await waitFor(() => expect(screen.queryByTestId('edit-conflict-dialog')).not.toBeInTheDocument());
    // Nothing was resent; Beta's edit is still staged, Alpha's status draft is gone.
    expect(batchCalls()).toHaveLength(1);
    expect(screen.getByTestId('register-edit-count')).toHaveTextContent('1 project changed');
    expect(screen.getByRole('combobox', { name: 'Status of Alpha' })).toHaveValue('In Development');
    expect(screen.getByRole('combobox', { name: 'Status of Beta' })).toHaveValue('On Hold');
    expect(screen.getByTestId('register-edit-bar')).toHaveTextContent(/Their saved values were kept/);

    // Saving again sends only Beta's edit, with its original base.
    await user.click(screen.getByTestId('register-edit-save'));
    await waitFor(() => expect(batchCalls()).toHaveLength(2));
    expect(batchCalls()[1]![2]).toEqual({
      edits: [{ project_id: 'b', status: 'On Hold', base: { status: 'In Development' } }],
    });
  });

  it('closing the dialog saves nothing and keeps every edit', async () => {
    const user = userEvent.setup();
    http.send.mockRejectedValueOnce(conflict409());
    renderWithProviders(<ProjectsPage />);
    await editAlphaAndBeta(user);
    await user.click(screen.getByTestId('register-edit-save'));
    await screen.findByTestId('edit-conflict-dialog');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('edit-conflict-dialog')).not.toBeInTheDocument());
    expect(batchCalls()).toHaveLength(1);
    expect(screen.getByTestId('register-edit-count')).toHaveTextContent('2 projects changed');
    expect(screen.getByTestId('register-edit-bar')).toHaveTextContent(/Nothing was saved/);
  });

  it('the list polls every 60 s and on focus while idle, and pauses while a row is in edit', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProjectsPage />);
    expect(useDashboardProjects).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ refetchInterval: EDIT_POLL_MS, refetchOnWindowFocus: true }),
    );
    await user.click(screen.getByRole('button', { name: 'Edit Alpha' }));
    expect(useDashboardProjects).toHaveBeenLastCalledWith(
      expect.anything(),
      expect.objectContaining({ refetchInterval: false, refetchOnWindowFocus: false }),
    );
  });
});

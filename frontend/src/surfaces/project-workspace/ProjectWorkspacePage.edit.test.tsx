import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';

import { renderWithProviders } from '@/test/render';
import { ROLE_MATRIX } from '@/test/roles';

import type { RegisterStepsResponse } from '@/surfaces/projects/api/register-edits';

import { workspaceFixture } from './test-fixtures';

/**
 * Register popup (owner 2026-11-17): the project folder's "Edit" opens the
 * same popup as the Projects list's row Edit, and saves the register fields
 * in ONE `POST /projects/register-edits` patch.
 */

const api = vi.hoisted(() => ({ fetchWorkspace: vi.fn(), fetchActivity: vi.fn(), searchMentions: vi.fn() }));
vi.mock('./api/workspace-api', () => ({
  fetchWorkspace: (...a: unknown[]) => api.fetchWorkspace(...a),
  fetchActivity: (...a: unknown[]) => api.fetchActivity(...a),
  searchMentions: (...a: unknown[]) => api.searchMentions(...a),
  patchStage: vi.fn(),
  recalculate: vi.fn(),
  uploadFile: vi.fn(),
  patchFile: vi.fn(),
  createComment: vi.fn(),
  editComment: vi.fn(),
  deleteComment: vi.fn(),
  downloadFile: vi.fn(),
  askAgent: vi.fn(),
  retryUnlessAuth: () => false,
}));
vi.mock('@/lib/api/sse', () => ({ streamSolverProgress: vi.fn() }));
vi.mock('@/lib/api/reference', () => ({
  useHubs: () => ({
    data: [{ id: 'hub-in', name: 'PD-India', lab_region: 'India', is_oem: false, capacity_hub_id: null, capacity_hub_name: null }],
  }),
  useCategoriesForHub: () => ({ data: undefined, options: ['A+', 'A', 'B', 'C'] }),
}));

const http = vi.hoisted(() => ({ get: vi.fn(), send: vi.fn(), sendWithHeaders: vi.fn() }));
vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return {
    ...actual,
    apiGet: (path: string, opts?: unknown) => http.get(path, opts),
    apiSend: (method: string, path: string, body?: unknown) => http.send(method, path, body),
    apiSendWithHeaders: (method: string, path: string, body?: unknown) => http.sendWithHeaders(method, path, body),
  };
});

import { ApiError } from '@/lib/api/client';
import ProjectWorkspacePage from './ProjectWorkspacePage';

vi.setConfig({ testTimeout: 90_000 });

const STEPS: RegisterStepsResponse = {
  project_id: 'p-1',
  current_step_code: 'PDD-B',
  end_week: 50,
  design_weeks_calculated: 7,
  lab_weeks_calculated: 3,
  steps: [
    { step_code: 'PDD-A', step_name: 'Concept', kind: 'design', status: 'Done', step_excluded: false, applicable: true, excludable: false, is_current: false },
    { step_code: 'PDD-B', step_name: 'Feasibility', kind: 'design', status: 'In Progress', step_excluded: false, applicable: true, excludable: true, is_current: true },
    { step_code: 'PDD-F', step_name: 'Safety lab', kind: 'lab', status: 'Not Started', step_excluded: false, applicable: true, excludable: true, is_current: false },
  ],
};

function renderPage(session?: Parameters<typeof renderWithProviders>[1]) {
  return renderWithProviders(
    <Routes>
      <Route path="/projects/:projectId" element={<ProjectWorkspacePage />} />
    </Routes>,
    { route: '/projects/p-1', ...session },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  const ws = workspaceFixture();
  api.fetchWorkspace.mockResolvedValue(ws);
  api.fetchActivity.mockResolvedValue({ items: [], next_before: null });
  api.searchMentions.mockResolvedValue([]);
  http.get.mockImplementation((path: string) => {
    if (path === '/projects/p-1') return Promise.resolve(ws.project);
    if (path === '/projects/p-1/register-steps') return Promise.resolve(STEPS);
    if (path === '/engineers') return Promise.resolve([{ id: 'eng-1', name: 'Asha Rao', hub_id: 'hub-in' }]);
    return Promise.reject(new ApiError(404, 'not found'));
  });
  http.send.mockResolvedValue({
    project_ids: ['p-1'],
    projects_marked_stale: ['p-1'],
    recalc_status: 'deferred',
    schedule_run_id: null,
    baseline_run_id: null,
    task_id: null,
  });
});

describe('ProjectWorkspacePage — Edit popup (owner 2026-11-17)', () => {
  it('the header Edit opens the same popup; a chip toggle saves ONE register-edits patch', async () => {
    const user = userEvent.setup();
    renderPage();
    const edit = await screen.findByTestId('workspace-edit');
    expect(edit).toHaveAccessibleName('Edit Cooler Alpha');
    await user.click(edit);

    const dialog = await screen.findByRole('dialog', { name: 'Edit Cooler Alpha' });
    expect(within(dialog).getByTestId('register-popup-section')).toBeInTheDocument();
    expect(within(dialog).getByTestId('popup-end-week')).toHaveTextContent('W50');
    // The register-steps read serves the calculated weeks, so the project folder shows the number too.
    expect(await within(dialog).findByLabelText(/^Design time/)).toHaveAttribute('placeholder', '7');

    const f = await within(dialog).findByRole('button', { name: /^Exclude PDD-F / });
    await user.click(f);
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(http.send).toHaveBeenCalledTimes(1));
    expect(http.send).toHaveBeenCalledWith('POST', '/projects/register-edits', {
      edits: [
        {
          project_id: 'p-1',
          step_exclusions: [{ step_code: 'PDD-F', step_excluded: true }],
          base: { step_exclusions: { 'PDD-F': false } },
        },
      ],
    });
    expect(http.sendWithHeaders).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // The save outcome stays on the page after the popup closes. Recalculation is
    // manual (2026-11-24): the save ran nothing, the user presses Recalculate.
    const panel = await screen.findByTestId('register-save-panel');
    expect(panel).toHaveTextContent('Saved — plan not recalculated yet');
    expect(panel).toHaveTextContent('Press Recalculate once you are done editing');
  });

  it('a role without Registration write gets no Edit', async () => {
    renderPage({
      session: {
        roles: ['Engineer'],
        permissions: ROLE_MATRIX.Engineer,
      },
    });
    await screen.findByTestId('workspace-header');
    expect(screen.queryByTestId('workspace-edit')).not.toBeInTheDocument();
  });
});

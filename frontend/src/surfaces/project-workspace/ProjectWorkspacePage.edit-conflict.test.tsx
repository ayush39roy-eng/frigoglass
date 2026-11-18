import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route, Routes } from 'react-router-dom';

import { renderWithProviders } from '@/test/render';
import { ApiError } from '@/lib/api/client';
import { seriousAxeViolations } from '@/test/axe';

import { workspaceFixture } from './test-fixtures';

const api = {
  fetchWorkspace: vi.fn(),
  patchStage: vi.fn(),
  recalculate: vi.fn(),
  uploadFile: vi.fn(),
  patchFile: vi.fn(),
  createComment: vi.fn(),
  editComment: vi.fn(),
  deleteComment: vi.fn(),
  fetchActivity: vi.fn(),
  searchMentions: vi.fn(),
  downloadFile: vi.fn(),
  askAgent: vi.fn(),
};
vi.mock('./api/workspace-api', () => ({
  fetchWorkspace: (...a: unknown[]) => api.fetchWorkspace(...a),
  patchStage: (...a: unknown[]) => api.patchStage(...a),
  recalculate: (...a: unknown[]) => api.recalculate(...a),
  uploadFile: (...a: unknown[]) => api.uploadFile(...a),
  patchFile: (...a: unknown[]) => api.patchFile(...a),
  createComment: (...a: unknown[]) => api.createComment(...a),
  editComment: (...a: unknown[]) => api.editComment(...a),
  deleteComment: (...a: unknown[]) => api.deleteComment(...a),
  fetchActivity: (...a: unknown[]) => api.fetchActivity(...a),
  searchMentions: (...a: unknown[]) => api.searchMentions(...a),
  downloadFile: (...a: unknown[]) => api.downloadFile(...a),
  askAgent: (...a: unknown[]) => api.askAgent(...a),
  retryUnlessAuth: () => false,
}));
const sse = { streamSolverProgress: vi.fn() };
vi.mock('@/lib/api/sse', () => ({
  streamSolverProgress: (...a: unknown[]) => sse.streamSolverProgress(...a),
}));
vi.mock('@/lib/api/reference', () => ({
  useHubs: () => ({ data: [{ id: 'hub-in', name: 'PD-India', lab_region: 'India', is_oem: false, capacity_hub_id: null, capacity_hub_name: null }] }),
  useCategoriesForHub: () => ({ data: undefined, options: ['A+', 'A', 'B', 'C'] }),
}));
vi.mock('@/surfaces/registration/hooks/use-registration', () => ({
  useEngineerOptions: () => ({ data: [] }),
}));
// P11: the Details form's PATCH (now carrying the X-Schedule-* recalc signal)
// and the run-to-run change list.
const reg = { updateProject: vi.fn() };
vi.mock('@/surfaces/registration/api/registration-api', () => ({
  updateProject: (...a: unknown[]) => reg.updateProject(...a),
}));
const moveApi = { fetchScheduleRunChanges: vi.fn(), moveProjectPriority: vi.fn() };
vi.mock('@/lib/api/priority-move', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/priority-move')>('@/lib/api/priority-move');
  return {
    ...actual,
    fetchScheduleRunChanges: (...a: unknown[]) => moveApi.fetchScheduleRunChanges(...a),
    moveProjectPriority: (...a: unknown[]) => moveApi.moveProjectPriority(...a),
  };
});

import ProjectWorkspacePage from './ProjectWorkspacePage';

/*
 * P47-T04 QA gate (ADR 0059 C2): the workspace Details FORM flow end to end.
 * Before P47 the form PATCHed the full body; now it sends only the changed
 * fields, each with its `base`. On a 409 the dialog offers "Keep mine"
 * (resend with base = stored value) and "Use theirs" (drop the conflicting
 * field, the non-conflicting change is still saved: a form has no buffer).
 */

function renderPage() {
  return renderWithProviders(
    <Routes>
      <Route path="*" element={<ProjectWorkspacePage />} />
    </Routes>,
  );
}

function conflict409(field: string, yours: unknown, current: unknown): ApiError {
  const body = {
    code: 'EDIT_CONFLICT',
    detail: 'Someone else changed this while you were editing.',
    conflicts: [
      {
        entity: 'project',
        id: workspaceFixture().project.id,
        label: 'Cooler Alpha',
        field,
        your_value: yours,
        current_value: current,
        changed_by: 'Alice Writer',
        changed_at: '2026-11-18T10:15:00+00:00',
      },
    ],
  };
  return new ApiError(409, body.detail, body.detail, 'EDIT_CONFLICT', undefined, body);
}

beforeEach(() => {
  vi.clearAllMocks();
  api.fetchWorkspace.mockResolvedValue(workspaceFixture());
  api.searchMentions.mockResolvedValue([]);
});

async function editTwoFields() {
  const user = userEvent.setup();
  renderPage();
  const panel = within(await screen.findByTestId('details-panel'));
  await user.click(panel.getByRole('button', { name: 'Edit details' }));
  const code = panel.getByLabelText(/^External code/);
  await user.clear(code);
  await user.type(code, 'RPD-MINE');
  const name = panel.getByLabelText(/^Name/);
  await user.clear(name);
  await user.type(name, 'Cooler Alpha v2');
  await user.click(panel.getByRole('button', { name: 'Save changes' }));
  return user;
}

describe('P47 — workspace Details form conflict flow', () => {
  it('sends ONLY the changed fields, each with the value it started from', async () => {
    const fixture = workspaceFixture();
    reg.updateProject.mockResolvedValue({ project: fixture.project, recalc: null });
    await editTwoFields();
    await waitFor(() => expect(reg.updateProject).toHaveBeenCalledTimes(1));
    expect(reg.updateProject).toHaveBeenCalledWith(fixture.project.id, {
      external_code: 'RPD-MINE',
      name: 'Cooler Alpha v2',
      base: { external_code: fixture.project.external_code, name: fixture.project.name },
    });
  });

  it('409 shows the dialog; Keep mine resends with base = the stored value for that field only', async () => {
    const fixture = workspaceFixture();
    reg.updateProject
      .mockRejectedValueOnce(conflict409('external_code', 'RPD-MINE', 'RPD-THEIRS'))
      .mockResolvedValueOnce({ project: fixture.project, recalc: null });
    const user = await editTwoFields();
    const dialog = await screen.findByTestId('edit-conflict-dialog');
    // axe on the surface with the conflict dialog open.
    expect(await seriousAxeViolations(document.body)).toEqual([]);
    expect(dialog).toHaveTextContent('RPD-MINE');
    expect(dialog).toHaveTextContent('RPD-THEIRS');
    expect(dialog).toHaveTextContent('Alice Writer');
    await user.click(within(dialog).getByRole('button', { name: 'Keep mine' }));
    await waitFor(() => expect(reg.updateProject).toHaveBeenCalledTimes(2));
    expect(reg.updateProject.mock.calls[1]?.[1]).toEqual({
      external_code: 'RPD-MINE',
      name: 'Cooler Alpha v2',
      base: { external_code: 'RPD-THEIRS', name: fixture.project.name },
    });
  });

  it('Use theirs drops the conflicting field and still saves the other change', async () => {
    const fixture = workspaceFixture();
    reg.updateProject
      .mockRejectedValueOnce(conflict409('external_code', 'RPD-MINE', 'RPD-THEIRS'))
      .mockResolvedValueOnce({ project: fixture.project, recalc: null });
    const user = await editTwoFields();
    const dialog = await screen.findByTestId('edit-conflict-dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Use theirs' }));
    await waitFor(() => expect(reg.updateProject).toHaveBeenCalledTimes(2));
    expect(reg.updateProject.mock.calls[1]?.[1]).toEqual({
      name: 'Cooler Alpha v2',
      base: { name: fixture.project.name },
    });
  });

  it('closing the dialog saves nothing and keeps the form open', async () => {
    reg.updateProject.mockRejectedValueOnce(conflict409('external_code', 'RPD-MINE', 'RPD-THEIRS'));
    const user = await editTwoFields();
    await screen.findByTestId('edit-conflict-dialog');
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByTestId('edit-conflict-dialog')).not.toBeInTheDocument());
    expect(reg.updateProject).toHaveBeenCalledTimes(1);
    const panel = within(screen.getByTestId('details-panel'));
    expect(panel.getByRole('button', { name: 'Save changes' })).toBeInTheDocument();
    expect(panel.getByLabelText(/^External code/)).toHaveValue('RPD-MINE');
  });
});

describe('P47-T04 defect pin — workspace stage row sends all six fields', () => {
  // ADR 0059 C1: "A field the request does not change is not checked. Two
  // people editing different fields ... both succeed." The stage PATCH accepts
  // any subset (StageUpdateRequest), but stage-row.tsx:157-166 sends all six
  // fields with a base for each. A concurrent check-in that changed only
  // percent_complete then makes this status edit a 409 naming a field the user
  // never touched, and "Keep mine" writes the stale percent back.
  // P47-R03 (QA-1): fixed; was `it.fails`.
  it('a status-only edit sends only status / blocked_reason with their base', async () => {
    api.patchStage.mockResolvedValue(workspaceFixture());
    const user = userEvent.setup();
    renderPage();
    const row = await screen.findByTestId('stage-PDD-B');
    await user.click(within(row).getByRole('combobox', { name: 'Status — Feasibility Study (Conceptual Design)' }));
    await user.click(await screen.findByRole('option', { name: 'On Hold' }));
    await user.type(within(row).getByLabelText(/Hold reason/), 'Waiting on supplier');
    await user.click(within(row).getByRole('button', { name: /Save progress/ }));
    await waitFor(() => expect(api.patchStage).toHaveBeenCalledTimes(1));
    expect(api.patchStage.mock.calls[0]?.[2]).toEqual({
      status: 'Blocked',
      blocked_reason: 'Waiting on supplier',
      base: { status: 'In Progress', blocked_reason: null },
    });
  });
});

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { seriousAxeViolations } from '@/test/axe';
import { renderWithProviders } from '@/test/render';
import { ApiError } from '@/lib/api/client';
import type { ProjectListItem } from './api/types';

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 44,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ key: index, index, start: index * 44, size: 44 })),
    measureElement: () => undefined,
    measure: () => undefined,
  }),
}));
// P13 follow-up: record the export button's filters (the real button is
// covered by `components/shared/download-button.test.tsx`).
const downloadProps = vi.hoisted(() => ({ last: null as null | { filters?: Record<string, string | undefined> } }));
vi.mock('@/components/shared/download-button', () => ({
  DownloadButton: (props: { filters?: Record<string, string | undefined> }) => {
    downloadProps.last = props;
    return null;
  },
}));
vi.mock('./components/hard-gate-panel', () => ({
  HardGatePanel: () => <div data-testid="hard-gate-panel" />,
}));

const hooks = {
  useProjectList: vi.fn(),
  useEngineerOptions: vi.fn(),
  useCreateProject: vi.fn(),
  useUpdateProject: vi.fn(),
  useSubmitProject: vi.fn(),
};
vi.mock('./hooks/use-registration', () => ({
  useProjectList: (args: unknown) => hooks.useProjectList(args),
  useEngineerOptions: (hubId: unknown) => hooks.useEngineerOptions(hubId),
  useCreateProject: () => hooks.useCreateProject(),
  useUpdateProject: () => hooks.useUpdateProject(),
  useSubmitProject: () => hooks.useSubmitProject(),
}));
vi.mock('@/lib/api/reference', () => ({
  useHubs: () => ({ data: [{ id: 'hub-1', name: 'R&D-Greece', lab_region: 'Greece', is_oem: false }] }),
  useCategoriesForHub: () => ({ data: undefined, options: ['A+', 'A', 'B', 'C'] }),
}));

// P14 (ADR 0026): a changed priority previews, then confirms with the token.
const moveApi = { previewProjectPriority: vi.fn(), moveProjectPriority: vi.fn() };
vi.mock('@/lib/api/priority-move', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/priority-move')>('@/lib/api/priority-move');
  return {
    ...actual,
    previewProjectPriority: (...a: unknown[]) => moveApi.previewProjectPriority(...a),
    moveProjectPriority: (...a: unknown[]) => moveApi.moveProjectPriority(...a),
  };
});

import RegistrationPage from './RegistrationPage';

function pending() {
  return { data: undefined, isPending: true, isError: false, error: null, refetch: vi.fn() };
}
function ready<T>(data: T) {
  return { data, isPending: false, isError: false, error: null, refetch: vi.fn() };
}
function failed(error: Error) {
  return { data: undefined, isPending: false, isError: true, error, refetch: vi.fn() };
}

const draftProject: ProjectListItem = {
  id: 'p1',
  name: 'Cooler A',
  external_code: null,
  hub_id: 'hub-1',
  leader_engineer_id: null,
  category: null,
  type: null,
  priority: null,
  status: 'Draft',
  frozen: false,
  actual_start_week: null,
  delay_weeks: 0,
  reg_year: null,
  carry_over: false,
  comments: null,
  customer_name: null,
  tcogs_eur: null,
  selling_price_eur: null,
  gross_margin_pct: null,
  capex_keur: null,
  rm_savings_keur: null,
  target_end_week: null,
  certification_testing_required: true,
  estimated_design_weeks: null,
  estimated_lab_weeks: null,
  schedule_stale: false,
  workflow_id: 'PDD',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  hooks.useEngineerOptions.mockReturnValue(ready([]));
  hooks.useCreateProject.mockReturnValue({ mutateAsync: vi.fn().mockResolvedValue({}) });
  hooks.useUpdateProject.mockReturnValue({ mutateAsync: vi.fn().mockResolvedValue({}) });
  hooks.useSubmitProject.mockReturnValue({ mutateAsync: vi.fn().mockResolvedValue({}) });
});

describe('RegistrationPage', () => {
  it('always renders the heading', () => {
    hooks.useProjectList.mockReturnValue(pending());
    renderWithProviders(<RegistrationPage />);
    expect(screen.getByRole('heading', { name: 'Project Registration' })).toBeInTheDocument();
  });

  it('degrades to an access notice on a 403 (Engineer / Executive Viewer / Auditor)', () => {
    hooks.useProjectList.mockReturnValue(failed(new ApiError(403, 'forbidden')));
    renderWithProviders(<RegistrationPage />);
    expect(screen.getByText(/does not have access to Project Registration/i)).toBeInTheDocument();
  });

  it('shows the empty state when no projects are registered', () => {
    hooks.useProjectList.mockReturnValue(ready([]));
    renderWithProviders(<RegistrationPage />);
    expect(screen.getByText('No projects registered yet')).toBeInTheDocument();
  });

  it('lists projects and re-fetches with the hub filter (hubId in the query)', async () => {
    const user = userEvent.setup();
    hooks.useProjectList.mockReturnValue(ready([draftProject]));
    renderWithProviders(<RegistrationPage />);

    expect(screen.getByText('Cooler A')).toBeInTheDocument();
    expect(hooks.useProjectList).toHaveBeenLastCalledWith(
      expect.objectContaining({ hubId: undefined }),
    );

    await user.click(screen.getByRole('combobox', { name: 'Hub' }));
    await user.click(await screen.findByRole('option', { name: 'R&D-Greece' }));
    expect(hooks.useProjectList).toHaveBeenLastCalledWith(
      expect.objectContaining({ hubId: 'hub-1' }),
    );
  });

  it('opening "New project" shows the create dialog', async () => {
    const user = userEvent.setup();
    hooks.useProjectList.mockReturnValue(ready([]));
    renderWithProviders(<RegistrationPage />);
    await user.click(screen.getAllByRole('button', { name: 'New project' })[0]!);
    expect(screen.getByRole('heading', { name: 'Register a project' })).toBeInTheDocument();
  });

  // P9-R03 (qa Q-F3, critical): the P4 axe spec never opened this dialog, so the
  // legend-only `#reg-comments` textarea went unnoticed. Scan the dialog open.
  it('the opened create dialog has no serious/critical axe violations; Comments is labelled', async () => {
    const user = userEvent.setup();
    hooks.useProjectList.mockReturnValue(ready([]));
    renderWithProviders(<RegistrationPage />);
    await user.click(screen.getAllByRole('button', { name: 'New project' })[0]!);
    const dialog = await screen.findByRole('dialog');
    expect(await seriousAxeViolations(dialog)).toEqual([]);
    expect(within(dialog).getByLabelText('Comments')).toHaveAttribute('id', 'reg-comments');
  });

  it('creating a project calls useCreateProject, not useUpdateProject', async () => {
    const user = userEvent.setup();
    const createMutateAsync = vi.fn().mockResolvedValue({});
    hooks.useCreateProject.mockReturnValue({ mutateAsync: createMutateAsync });
    hooks.useProjectList.mockReturnValue(ready([]));
    renderWithProviders(<RegistrationPage />);

    await user.click(screen.getAllByRole('button', { name: 'New project' })[0]!);
    await user.type(screen.getByLabelText(/^Name/), 'Cooler B');
    await user.click(screen.getByRole('combobox', { name: /^Hub/ }));
    await user.click(await screen.findByRole('option', { name: 'R&D-Greece' }));
    await user.click(screen.getByRole('button', { name: 'Create draft' }));

    expect(createMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Cooler B', hub_id: 'hub-1' }),
    );
  });

  it('hides "New project" and shows a read-only notice after a 403 on create', async () => {
    const user = userEvent.setup();
    hooks.useCreateProject.mockReturnValue({
      mutateAsync: vi.fn().mockRejectedValue(new ApiError(403, 'forbidden')),
    });
    hooks.useProjectList.mockReturnValue(ready([]));
    renderWithProviders(<RegistrationPage />);

    await user.click(screen.getAllByRole('button', { name: 'New project' })[0]!);
    await user.type(screen.getByLabelText(/^Name/), 'Cooler B');
    await user.click(screen.getByRole('combobox', { name: /^Hub/ }));
    await user.click(await screen.findByRole('option', { name: 'R&D-Greece' }));
    await user.click(screen.getByRole('button', { name: 'Create draft' }));

    expect(await screen.findByText(/read-only access to Project Registration/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New project' })).not.toBeInTheDocument();
  });

  it('P11: an edit whose PATCH reports X-Schedule-Recalc shows the same honest outcome (deferred here)', async () => {
    const user = userEvent.setup();
    const project = { ...draftProject, status: 'In Queue' as const, priority: 'P1' as const };
    hooks.useProjectList.mockReturnValue(ready([project]));
    hooks.useUpdateProject.mockReturnValue({
      mutateAsync: vi.fn().mockResolvedValue({
        project: { ...project, priority: 'P2' },
        recalc: { recalc_status: 'deferred', schedule_run_id: null, baseline_run_id: null },
      }),
    });
    renderWithProviders(<RegistrationPage />);
    await user.click(screen.getByRole('button', { name: 'Edit Cooler A' }));
    expect(await screen.findByText('Changing priority recalculates the timeline.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByTestId('priority-move-notice')).toHaveTextContent(
      'Saved — the timeline updates automatically after the current recalculation',
    );
  });

  it('P14: a priority change previews first; Yes applies it with the token, then PATCHes the rest without priority', async () => {
    const user = userEvent.setup();
    const project = { ...draftProject, status: 'In Queue' as const, priority: 'P1' as const };
    hooks.useProjectList.mockReturnValue(ready([project]));
    const mutateAsync = vi.fn().mockResolvedValue({ project: { ...project, priority: 'P2' }, recalc: null });
    hooks.useUpdateProject.mockReturnValue({ mutateAsync });
    moveApi.previewProjectPriority.mockResolvedValue({
      result: 'preview', project_id: 'p1', from_priority: 'P1', to_priority: 'P2', baseline_run_id: 'run-1',
      preview_token: 'tok-r', moved: null,
      summary: { affected: 0, delayed: 0, earlier: 0, pushed_out_of_year: 0, pulled_into_year: 0 },
      changes: [], hidden_count: 0, elapsed_ms: 3,
    });
    moveApi.moveProjectPriority.mockResolvedValue({
      project_id: 'p1', priority_before: 'P1', priority_after: 'P2', recalc_status: 'applied',
      schedule_run_id: 'run-2', baseline_run_id: 'run-1', task_id: null, changes: [], hidden_count: 0,
    });
    renderWithProviders(<RegistrationPage />);
    await user.click(screen.getByRole('button', { name: 'Edit Cooler A' }));
    await user.click(screen.getByRole('combobox', { name: /^Priority/ }));
    await user.click(await screen.findByRole('option', { name: 'P2' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    const preview = await screen.findByRole('dialog', { name: 'Move to P2?' });
    expect(moveApi.previewProjectPriority).toHaveBeenCalledWith('p1', 'P2', expect.anything());
    expect(mutateAsync).not.toHaveBeenCalled();
    const yes = within(preview).getByRole('button', { name: 'Yes, apply' });
    await vi.waitFor(() => expect(yes).toBeEnabled());
    await user.click(yes);
    expect(moveApi.moveProjectPriority).toHaveBeenCalledWith('p1', 'P2', 'tok-r');
    await vi.waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
    const body = (mutateAsync.mock.calls[0]![0] as { body: Record<string, unknown> }).body;
    expect(body).not.toHaveProperty('priority');
    expect(body).toHaveProperty('name', 'Cooler A');
    expect(await screen.findByRole('dialog', { name: 'Moved to P2' })).toBeInTheDocument();
  });

  it('P14: No on the priority preview saves nothing and keeps the form open with an explanation', async () => {
    const user = userEvent.setup();
    const project = { ...draftProject, status: 'In Queue' as const, priority: 'P1' as const };
    hooks.useProjectList.mockReturnValue(ready([project]));
    const mutateAsync = vi.fn();
    hooks.useUpdateProject.mockReturnValue({ mutateAsync });
    moveApi.previewProjectPriority.mockResolvedValue({
      result: 'preview', project_id: 'p1', from_priority: 'P1', to_priority: 'P3', baseline_run_id: 'run-1',
      preview_token: 'tok-r', moved: null,
      summary: { affected: 0, delayed: 0, earlier: 0, pushed_out_of_year: 0, pulled_into_year: 0 },
      changes: [], hidden_count: 0, elapsed_ms: 3,
    });
    renderWithProviders(<RegistrationPage />);
    await user.click(screen.getByRole('button', { name: 'Edit Cooler A' }));
    await user.click(screen.getByRole('combobox', { name: /^Priority/ }));
    await user.click(await screen.findByRole('option', { name: 'P3' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    const preview = await screen.findByRole('dialog', { name: 'Move to P3?' });
    await user.click(within(preview).getByRole('button', { name: 'No, cancel' }));
    expect(await screen.findByText(/The priority move was not applied, so nothing was saved/)).toBeInTheDocument();
    expect(mutateAsync).not.toHaveBeenCalled();
    expect(moveApi.moveProjectPriority).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument();
  });

  it('expanding a Draft row shows the hard-gate panel', async () => {
    const user = userEvent.setup();
    hooks.useProjectList.mockReturnValue(ready([draftProject]));
    renderWithProviders(<RegistrationPage />);
    await user.click(screen.getByRole('button', { name: 'Expand Cooler A' }));
    expect(screen.getByTestId('hard-gate-panel')).toBeInTheDocument();
  });
});

describe('RegistrationPage — search (P13-T17)', () => {
  it('sends the trimmed, debounced search to the server as q (≤ 100 chars) and Clear resets it', async () => {
    const user = userEvent.setup();
    hooks.useProjectList.mockReturnValue(ready([draftProject]));
    renderWithProviders(<RegistrationPage />);
    const box = screen.getByRole('searchbox', { name: 'Search' });
    expect(box).toHaveAttribute('maxLength', '100');
    await user.type(box, '  tauras ');
    await vi.waitFor(() =>
      expect(hooks.useProjectList).toHaveBeenLastCalledWith(expect.objectContaining({ q: 'tauras' })),
    );
    // The export downloads the same searched set.
    expect(downloadProps.last?.filters?.q).toBe('tauras');
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(box).toHaveValue('');
    await vi.waitFor(() =>
      expect(hooks.useProjectList).toHaveBeenLastCalledWith(expect.objectContaining({ q: undefined })),
    );
    expect(downloadProps.last?.filters?.q).toBeUndefined();
  });
});

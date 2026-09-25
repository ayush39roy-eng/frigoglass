import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

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
}));

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

  it('expanding a Draft row shows the hard-gate panel', async () => {
    const user = userEvent.setup();
    hooks.useProjectList.mockReturnValue(ready([draftProject]));
    renderWithProviders(<RegistrationPage />);
    await user.click(screen.getByRole('button', { name: 'Expand Cooler A' }));
    expect(screen.getByTestId('hard-gate-panel')).toBeInTheDocument();
  });
});

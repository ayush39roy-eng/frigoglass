import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import { ApiError } from '@/lib/api/client';
import type { ChamberRead, EngineerRead } from './api/types';

const hooks = {
  useEngineerList: vi.fn(),
  useChamberList: vi.fn(),
  useCreateEngineer: vi.fn(),
  useUpdateEngineer: vi.fn(),
  useDeleteEngineer: vi.fn(),
  useCreateChamber: vi.fn(),
  useUpdateChamber: vi.fn(),
  useDeleteChamber: vi.fn(),
  useApplyLogic: vi.fn(),
  useActiveScheduleRun: vi.fn(),
};
vi.mock('./hooks/use-planning', () => ({
  useEngineerList: (hubId: unknown) => hooks.useEngineerList(hubId),
  useChamberList: () => hooks.useChamberList(),
  useCreateEngineer: () => hooks.useCreateEngineer(),
  useUpdateEngineer: () => hooks.useUpdateEngineer(),
  useDeleteEngineer: () => hooks.useDeleteEngineer(),
  useCreateChamber: () => hooks.useCreateChamber(),
  useUpdateChamber: () => hooks.useUpdateChamber(),
  useDeleteChamber: () => hooks.useDeleteChamber(),
  useApplyLogic: () => hooks.useApplyLogic(),
  useActiveScheduleRun: (enabled: unknown) => hooks.useActiveScheduleRun(enabled),
}));
vi.mock('@/lib/api/reference', () => ({
  useHubs: () => ({ data: [{ id: 'hub-1', name: 'R&D-Greece', lab_region: 'Greece', is_oem: false }] }),
  useWorkflowStepTemplates: () => ({
    data: [{ id: 'PDD-F', name: 'Proof of Concept', kind: 'lab', base_weeks: 3 }],
    isPending: false,
  }),
}));

import PlanningPage from './PlanningPage';

function pending() {
  return { data: undefined, isPending: true, isError: false, error: null, refetch: vi.fn() };
}
function ready<T>(data: T) {
  return { data, isPending: false, isError: false, error: null, refetch: vi.fn() };
}
function failed(error: Error) {
  return { data: undefined, isPending: false, isError: true, error, refetch: vi.fn() };
}

const engineer: EngineerRead = {
  id: 'e1',
  name: 'Ada Lovelace',
  hub_id: 'hub-1',
  fte: 1,
  allowed_categories: ['A+'],
  user_id: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

const chamber: ChamberRead = {
  id: 'c1',
  code: 'GR-CH1',
  lab_region: 'Greece',
  max_concurrent: 2,
  platforms: 1,
  efficiency: 1,
  weeks_per_chamber: 0,
  allowed_stages: ['PDD-F'],
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

beforeEach(() => {
  vi.clearAllMocks();
  hooks.useEngineerList.mockReturnValue(ready([]));
  hooks.useChamberList.mockReturnValue(ready([]));
  hooks.useCreateEngineer.mockReturnValue({ mutateAsync: vi.fn().mockResolvedValue({}) });
  hooks.useUpdateEngineer.mockReturnValue({ mutateAsync: vi.fn().mockResolvedValue({}) });
  hooks.useDeleteEngineer.mockReturnValue({ mutateAsync: vi.fn().mockResolvedValue({}), isPending: false });
  hooks.useCreateChamber.mockReturnValue({ mutateAsync: vi.fn().mockResolvedValue({}) });
  hooks.useUpdateChamber.mockReturnValue({ mutateAsync: vi.fn().mockResolvedValue({}) });
  hooks.useDeleteChamber.mockReturnValue({ mutateAsync: vi.fn().mockResolvedValue({}), isPending: false });
  hooks.useApplyLogic.mockReturnValue({
    mutateAsync: vi.fn().mockResolvedValue({}),
    isPending: false,
    data: undefined,
  });
  hooks.useActiveScheduleRun.mockReturnValue(ready(null));
});

describe('PlanningPage', () => {
  it('always renders the heading', () => {
    hooks.useEngineerList.mockReturnValue(pending());
    renderWithProviders(<PlanningPage />);
    expect(screen.getByRole('heading', { name: 'Capacity Planning' })).toBeInTheDocument();
  });

  it('degrades to an access notice on a 403 (Engineer / Executive Viewer / Auditor)', () => {
    hooks.useEngineerList.mockReturnValue(failed(new ApiError(403, 'forbidden')));
    renderWithProviders(<PlanningPage />);
    expect(screen.getByText(/does not have access to Capacity Planning/i)).toBeInTheDocument();
  });

  it('shows the empty state when no engineers are registered', () => {
    renderWithProviders(<PlanningPage />);
    expect(screen.getByText('No engineers registered yet')).toBeInTheDocument();
  });

  it('lists engineers and re-fetches with the hub filter (hubId in the query)', async () => {
    const user = userEvent.setup();
    hooks.useEngineerList.mockReturnValue(ready([engineer]));
    renderWithProviders(<PlanningPage />);

    expect(screen.getByText('Ada Lovelace')).toBeInTheDocument();
    expect(hooks.useEngineerList).toHaveBeenLastCalledWith(undefined);

    await user.click(screen.getByRole('combobox', { name: 'Hub' }));
    await user.click(await screen.findByRole('option', { name: 'R&D-Greece' }));
    expect(hooks.useEngineerList).toHaveBeenLastCalledWith('hub-1');
  });

  it('creating an engineer calls useCreateEngineer', async () => {
    const user = userEvent.setup();
    const createMutateAsync = vi.fn().mockResolvedValue({});
    hooks.useCreateEngineer.mockReturnValue({ mutateAsync: createMutateAsync });
    renderWithProviders(<PlanningPage />);

    await user.click(screen.getAllByRole('button', { name: 'New engineer' })[0]!);
    await user.type(screen.getByLabelText(/^Name/), 'Ada Lovelace');
    await user.click(screen.getByRole('combobox', { name: /^Hub/ }));
    await user.click(await screen.findByRole('option', { name: 'R&D-Greece' }));
    await user.click(screen.getByRole('button', { name: 'Add engineer' }));

    expect(createMutateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Ada Lovelace', hub_id: 'hub-1' }),
    );
  });

  it('deleting an engineer requires confirmation', async () => {
    const user = userEvent.setup();
    const deleteMutateAsync = vi.fn().mockResolvedValue(undefined);
    hooks.useDeleteEngineer.mockReturnValue({ mutateAsync: deleteMutateAsync, isPending: false });
    hooks.useEngineerList.mockReturnValue(ready([engineer]));
    renderWithProviders(<PlanningPage />);

    await user.click(screen.getByRole('button', { name: 'Delete Ada Lovelace' }));
    const dialog = await screen.findByRole('dialog');
    expect(deleteMutateAsync).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(deleteMutateAsync).toHaveBeenCalledWith('e1');
  });

  it('switches to the Chambers tab and lists chambers', async () => {
    const user = userEvent.setup();
    hooks.useChamberList.mockReturnValue(ready([chamber]));
    renderWithProviders(<PlanningPage />);
    await user.click(screen.getByRole('tab', { name: 'Chambers' }));
    expect(screen.getByText('GR-CH1')).toBeInTheDocument();
  });

  it('switches to the Apply Logic tab and shows both Apply Logic and the Auto-assign placeholder', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PlanningPage />);
    await user.click(screen.getByRole('tab', { name: 'Apply Logic & Auto-assign' }));
    expect(screen.getByRole('heading', { name: 'Apply Logic' })).toBeInTheDocument();
    expect(screen.getByText('Auto-assign is pending a client decision')).toBeInTheDocument();
  });

  it('applying the logic requires confirmation, then calls the mutation', async () => {
    const user = userEvent.setup();
    const applyMutateAsync = vi.fn().mockResolvedValue({});
    hooks.useApplyLogic.mockReturnValue({ mutateAsync: applyMutateAsync, isPending: false, data: undefined });
    renderWithProviders(<PlanningPage />);
    await user.click(screen.getByRole('tab', { name: 'Apply Logic & Auto-assign' }));
    await user.click(screen.getByRole('button', { name: 'Apply Logic' }));
    const dialog = await screen.findByRole('dialog');
    expect(applyMutateAsync).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Apply Logic' }));
    expect(applyMutateAsync).toHaveBeenCalledTimes(1);
  });

  it('a 403 on Apply Logic (Hub Planner without Admin) shows the read-only notice, not a crash', async () => {
    const user = userEvent.setup();
    const applyMutateAsync = vi.fn().mockRejectedValue(new ApiError(403, 'forbidden'));
    hooks.useApplyLogic.mockReturnValue({ mutateAsync: applyMutateAsync, isPending: false, data: undefined });
    renderWithProviders(<PlanningPage />);
    await user.click(screen.getByRole('tab', { name: 'Apply Logic & Auto-assign' }));
    await user.click(screen.getByRole('button', { name: 'Apply Logic' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Apply Logic' }));
    expect(await screen.findByText(/limited to Admins/)).toBeInTheDocument();
    expect(await screen.findByText(/read-only access to Capacity Planning/i)).toBeInTheDocument();
  });
});

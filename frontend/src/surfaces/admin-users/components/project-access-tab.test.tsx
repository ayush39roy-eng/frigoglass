import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { seriousAxeViolations } from '@/test/axe';
import { renderWithProviders } from '@/test/render';
import { ApiError } from '@/lib/api/client';

import type { ProjectAccessGrantRead, UserRead } from '../api/types';
import { ProjectAccessTab } from './project-access-tab';

const hooks = {
  useProjectsForPicker: vi.fn(),
  useUsersForPicker: vi.fn(),
  useProjectAccessGrants: vi.fn(),
  useCreateProjectAccessGrant: vi.fn(),
  useRevokeProjectAccessGrant: vi.fn(),
};
vi.mock('../hooks/use-projects-for-picker', () => ({
  useProjectsForPicker: () => hooks.useProjectsForPicker(),
}));
vi.mock('../hooks/use-users', () => ({
  useUsersForPicker: () => hooks.useUsersForPicker(),
}));
vi.mock('../hooks/use-project-access', () => ({
  useProjectAccessGrants: (id: unknown) => hooks.useProjectAccessGrants(id),
  useCreateProjectAccessGrant: (id: unknown) => hooks.useCreateProjectAccessGrant(id),
  useRevokeProjectAccessGrant: (id: unknown) => hooks.useRevokeProjectAccessGrant(id),
}));
vi.mock('@/lib/api/reference', () => ({
  useHubs: () => ({ data: [{ id: 'hub-1', name: 'PD-India', lab_region: 'India', is_oem: false }] }),
}));

function ready<T>(data: T) {
  return { data, isPending: false, isError: false, error: null, refetch: vi.fn() };
}

const bob: UserRead = {
  id: 'u-bob',
  email: 'bob.hub@example.com',
  full_name: 'Bob Hub',
  is_active: true,
  roles: ['Hub Planner'],
  hub_scope_all: false,
  hub_ids: ['hub-1'],
  engineer_id: null,
  manager_id: null,
  oidc_linked: true,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};
const carol: UserRead = { ...bob, id: 'u-carol', email: 'carol.eng@example.com', full_name: 'Carol Eng', roles: ['Engineer'] };

function grant(over: Partial<ProjectAccessGrantRead> = {}): ProjectAccessGrantRead {
  return {
    id: 'grant-1',
    project_id: 'proj-1',
    user_id: 'u-carol',
    project_role: 'editor',
    granted_by_user_id: 'u-bob',
    created_at: '2026-09-30T00:00:00Z',
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  hooks.useProjectsForPicker.mockReturnValue(
    ready([{ id: 'proj-1', name: 'Cooler X200', hub_id: 'hub-1' }]),
  );
  hooks.useUsersForPicker.mockReturnValue(ready({ total_count: 2, items: [bob, carol] }));
  hooks.useCreateProjectAccessGrant.mockReturnValue({ mutateAsync: vi.fn().mockResolvedValue(grant()), isPending: false });
  hooks.useRevokeProjectAccessGrant.mockReturnValue({ mutateAsync: vi.fn().mockResolvedValue(undefined), isPending: false });
});

async function pickProject(user: ReturnType<typeof userEvent.setup>) {
  const search = screen.getByLabelText('Search projects');
  await user.type(search, 'Cooler');
  await user.click(await screen.findByRole('option', { name: /Cooler X200/ }));
}

describe('ProjectAccessTab (ADR 0012)', () => {
  it('lists a selected project’s grants with resolved user / granted-by names and role badges', async () => {
    const user = userEvent.setup();
    hooks.useProjectAccessGrants.mockReturnValue(ready([grant()]));
    renderWithProviders(<ProjectAccessTab />);

    await pickProject(user);

    const row = await screen.findByTestId('access-grant-row');
    expect(within(row).getByText(/Carol Eng \(carol.eng@example.com\)/)).toBeInTheDocument();
    expect(within(row).getByText(/Granted by Bob Hub \(bob.hub@example.com\)/)).toBeInTheDocument();
    expect(within(row).getByText('Editor')).toBeInTheDocument();
  });

  it('a 403 on the grant list shows an explicit no-delegation-rights state, not an empty table', async () => {
    const user = userEvent.setup();
    hooks.useProjectAccessGrants.mockReturnValue({
      data: undefined,
      isPending: false,
      isError: true,
      error: new ApiError(403, 'forbidden'),
      refetch: vi.fn(),
    });
    renderWithProviders(<ProjectAccessTab />);

    await pickProject(user);

    expect(await screen.findByText('No delegation rights on this project')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Grant access' })).not.toBeInTheDocument();
  });

  it('grants access to a picked user with the chosen role', async () => {
    const user = userEvent.setup();
    hooks.useProjectAccessGrants.mockReturnValue(ready([]));
    const mutateAsync = vi.fn().mockResolvedValue(grant());
    hooks.useCreateProjectAccessGrant.mockReturnValue({ mutateAsync, isPending: false });
    renderWithProviders(<ProjectAccessTab />);

    await pickProject(user);
    await user.type(screen.getByLabelText('Grant access to'), 'Carol');
    await user.click(await screen.findByRole('option', { name: /Carol Eng/ }));
    await user.click(screen.getByRole('combobox', { name: 'Project role' }));
    await user.click(await screen.findByRole('option', { name: 'Admin' }));
    await user.click(screen.getByRole('button', { name: 'Grant access' }));

    expect(mutateAsync).toHaveBeenCalledWith({ user_id: 'u-carol', project_role: 'admin' });
  });

  it('shows the ACTIVE_GRANT_EXISTS 409 inline', async () => {
    const user = userEvent.setup();
    hooks.useProjectAccessGrants.mockReturnValue(ready([]));
    const mutateAsync = vi
      .fn()
      .mockRejectedValue(new ApiError(409, 'conflict', 'already has an active grant', 'ACTIVE_GRANT_EXISTS'));
    hooks.useCreateProjectAccessGrant.mockReturnValue({ mutateAsync, isPending: false });
    renderWithProviders(<ProjectAccessTab />);

    await pickProject(user);
    await user.type(screen.getByLabelText('Grant access to'), 'Carol');
    await user.click(await screen.findByRole('option', { name: /Carol Eng/ }));
    await user.click(screen.getByRole('button', { name: 'Grant access' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/already has an active grant on this project/);
  });

  it('revokes a grant after confirmation', async () => {
    const user = userEvent.setup();
    hooks.useProjectAccessGrants.mockReturnValue(ready([grant()]));
    const mutateAsync = vi.fn().mockResolvedValue(undefined);
    hooks.useRevokeProjectAccessGrant.mockReturnValue({ mutateAsync, isPending: false });
    renderWithProviders(<ProjectAccessTab />);

    await pickProject(user);
    await user.click(await screen.findByRole('button', { name: /Revoke access for Carol Eng/ }));
    await user.click(screen.getByRole('button', { name: 'Revoke' }));

    expect(mutateAsync).toHaveBeenCalledWith('grant-1');
  });

  it('has no serious/critical axe violations with a project selected', async () => {
    const user = userEvent.setup();
    hooks.useProjectAccessGrants.mockReturnValue(ready([grant()]));
    const { container } = renderWithProviders(<ProjectAccessTab />);
    await pickProject(user);
    await screen.findByTestId('access-grant-row');
    expect(await seriousAxeViolations(container)).toEqual([]);
  });
});

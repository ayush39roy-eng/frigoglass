import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import { ROLE_MATRIX } from '@/test/roles';
import { ApiError } from '@/lib/api/client';
import type { RoleRead, UserRead } from './api/types';

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 44,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ key: index, index, start: index * 44, size: 44 })),
    measureElement: () => undefined,
  }),
}));

const hooks = {
  useUsers: vi.fn(),
  useRoles: vi.fn(),
  useCreateUser: vi.fn(),
  useUpdateUser: vi.fn(),
};
vi.mock('./hooks/use-users', () => ({
  useUsers: (params: unknown) => hooks.useUsers(params),
  useRoles: () => hooks.useRoles(),
  useCreateUser: () => hooks.useCreateUser(),
  useUpdateUser: () => hooks.useUpdateUser(),
}));
vi.mock('@/lib/api/reference', () => ({
  useHubs: () => ({
    data: [
      { id: 'hub-greece', name: 'R&D-Greece', lab_region: 'Greece', is_oem: false },
      { id: 'hub-india', name: 'PD-India', lab_region: 'India', is_oem: false },
    ],
  }),
}));
vi.mock('@/surfaces/registration/hooks/use-registration', () => ({
  useEngineerOptions: () => ({ data: [{ id: 'eng-1', name: 'Nikos Papas', hub_id: 'hub-greece' }] }),
}));

import AdminUsersPage from './AdminUsersPage';

function user(over: Partial<UserRead> = {}): UserRead {
  return {
    id: 'u1',
    email: 'hana.planner@example.com',
    full_name: 'Hana Planner',
    is_active: true,
    roles: ['Hub Planner'],
    hub_scope_all: false,
    hub_ids: ['hub-india'],
    engineer_id: null,
    manager_id: null,
    oidc_linked: true,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}
const superUser = user({ id: 'u2', email: 'sam.super@example.com', full_name: 'Sam Super', roles: ['Super Admin'], hub_scope_all: true, hub_ids: [], oidc_linked: false });
const engineerUser = user({ id: 'u3', email: 'carol.eng@example.com', full_name: 'Carol Eng', roles: ['Engineer'], hub_scope_all: false, hub_ids: ['hub-india'] });

function rolesFor(callerIsSuper: boolean): RoleRead[] {
  return [
    { name: 'Portfolio Manager', description: 'Portfolio-wide read, Matrix write', assignable: true },
    { name: 'Hub Planner', description: 'Own hub planning', assignable: true },
    { name: 'Admin', description: 'Everything but Workflow Settings', assignable: callerIsSuper },
    { name: 'Super Admin', description: 'Every right', assignable: callerIsSuper },
  ];
}

function ready<T>(data: T) {
  return { data, isPending: false, isError: false, error: null, refetch: vi.fn() };
}

beforeEach(() => {
  vi.clearAllMocks();
  hooks.useUsers.mockReturnValue(ready({ total_count: 2, items: [user(), superUser] }));
  hooks.useRoles.mockReturnValue(ready(rolesFor(true)));
  hooks.useCreateUser.mockReturnValue({ mutateAsync: vi.fn().mockResolvedValue(user()) });
  hooks.useUpdateUser.mockReturnValue({ mutateAsync: vi.fn().mockResolvedValue(user()) });
});

describe('AdminUsersPage', () => {
  it('lists users with email, name, role chips, hub scope, active and SSO state', () => {
    renderWithProviders(<AdminUsersPage />);
    expect(screen.getByRole('heading', { name: 'User / Role Admin' })).toBeInTheDocument();
    const rows = screen.getAllByTestId('user-row');
    expect(rows).toHaveLength(2);
    const hana = within(rows[0]!);
    expect(hana.getByText('hana.planner@example.com')).toBeInTheDocument();
    expect(hana.getByText('Hub Planner')).toBeInTheDocument();
    expect(hana.getByText('PD-India')).toBeInTheDocument();
    expect(hana.getByText('Active')).toBeInTheDocument();
    expect(hana.getByText('SSO')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('All hubs')).toBeInTheDocument();
  });

  it('search is debounced into the query params', async () => {
    const user = userEvent.setup();
    renderWithProviders(<AdminUsersPage />);
    await user.type(screen.getByLabelText('Search users'), 'sam');
    await vi.waitFor(() =>
      expect(hooks.useUsers).toHaveBeenLastCalledWith({ q: 'sam', limit: 100, offset: 0 }),
    );
  });

  it('creates a user with roles, hub scope and engineer link', async () => {
    const user = userEvent.setup();
    const mutateAsync = vi.fn().mockResolvedValue(superUser);
    hooks.useCreateUser.mockReturnValue({ mutateAsync });
    renderWithProviders(<AdminUsersPage />);
    await user.click(screen.getByRole('button', { name: 'New user' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByLabelText(/^Email/), 'new.user@example.com');
    await user.type(within(dialog).getByLabelText(/^Full name/), 'New User');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Portfolio Manager' }));
    await user.click(within(dialog).getByRole('checkbox', { name: 'All hubs' }));
    await user.click(within(dialog).getByRole('checkbox', { name: 'R&D-Greece' }));
    await user.click(within(dialog).getByRole('combobox', { name: 'Linked engineer' }));
    await user.click(await screen.findByRole('option', { name: 'Nikos Papas' }));
    await user.click(within(dialog).getByRole('button', { name: 'Create user' }));
    expect(mutateAsync).toHaveBeenCalledWith({
      email: 'new.user@example.com',
      full_name: 'New User',
      roles: ['Portfolio Manager'],
      hub_scope_all: false,
      hub_ids: ['hub-greece'],
      engineer_id: 'eng-1',
    });
  });

  it('sets a user’s manager (ADR 0012 delegation)', async () => {
    const user = userEvent.setup();
    const mutateAsync = vi.fn().mockResolvedValue(superUser);
    hooks.useUpdateUser.mockReturnValue({ mutateAsync });
    renderWithProviders(<AdminUsersPage />);
    await user.click(screen.getByRole('button', { name: 'Edit hana.planner@example.com' }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('combobox', { name: 'Manager' }));
    await user.click(await screen.findByRole('option', { name: /Sam Super/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    expect(mutateAsync).toHaveBeenCalledWith({
      userId: 'u1',
      body: expect.objectContaining({ manager_id: 'u2' }),
    });
  });

  it('shows the MANAGER_CYCLE 409 as an inline error on edit', async () => {
    const user = userEvent.setup();
    const mutateAsync = vi
      .fn()
      .mockRejectedValue(
        new ApiError(409, 'conflict', 'would create a reporting cycle', 'MANAGER_CYCLE'),
      );
    hooks.useUpdateUser.mockReturnValue({ mutateAsync });
    renderWithProviders(<AdminUsersPage />);
    await user.click(screen.getByRole('button', { name: 'Edit hana.planner@example.com' }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('combobox', { name: 'Manager' }));
    await user.click(await screen.findByRole('option', { name: /Sam Super/ }));
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/reporting-line cycle/);
  });

  it('shows the ENGINEER_HUB_SCOPE_ALL_NOT_ALLOWED 422 as an inline error on edit (P10-F01/F03)', async () => {
    hooks.useUsers.mockReturnValue(ready({ total_count: 2, items: [superUser, engineerUser] }));
    const user = userEvent.setup();
    const mutateAsync = vi
      .fn()
      .mockRejectedValue(
        new ApiError(422, 'unprocessable', 'engineer only, all hubs', 'ENGINEER_HUB_SCOPE_ALL_NOT_ALLOWED'),
      );
    hooks.useUpdateUser.mockReturnValue({ mutateAsync });
    renderWithProviders(<AdminUsersPage />);
    await user.click(screen.getByRole('button', { name: 'Edit carol.eng@example.com' }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('checkbox', { name: 'All hubs' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/Engineer-only account cannot have "All hubs" scope/);
  });

  it('shows the LAST_SUPER_ADMIN 409 as an inline error on edit', async () => {
    const user = userEvent.setup();
    const mutateAsync = vi
      .fn()
      .mockRejectedValue(new ApiError(409, 'conflict', 'would remove last super admin', 'LAST_SUPER_ADMIN'));
    hooks.useUpdateUser.mockReturnValue({ mutateAsync });
    renderWithProviders(<AdminUsersPage />);
    await user.click(screen.getByRole('button', { name: 'Edit sam.super@example.com' }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Active' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/leave no active Super Admin/);
    expect(mutateAsync).toHaveBeenCalledWith({
      userId: 'u2',
      body: expect.objectContaining({ is_active: false, roles: ['Super Admin'] }),
    });
  });

  it('an Admin (not Super Admin) cannot edit a Super Admin account and sees Admin roles disabled', async () => {
    const user = userEvent.setup();
    hooks.useRoles.mockReturnValue(ready(rolesFor(false)));
    renderWithProviders(<AdminUsersPage />, {
      session: { roles: ['Admin'], permissions: ROLE_MATRIX.Admin },
    });
    expect(screen.getByRole('button', { name: 'Edit sam.super@example.com' })).toBeDisabled();
    expect(screen.getByRole('note')).toHaveTextContent(/reserved for a Super Admin/);
    await user.click(screen.getByRole('button', { name: 'Edit hana.planner@example.com' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('checkbox', { name: 'Super Admin' })).toBeDisabled();
    expect(within(dialog).getByRole('checkbox', { name: 'Admin' })).toBeDisabled();
    expect(within(dialog).getByRole('checkbox', { name: 'Hub Planner' })).toBeEnabled();
  });

  it('a read-only permission hides every write control and shows the read-only notice', () => {
    renderWithProviders(<AdminUsersPage />, {
      session: {
        roles: ['Admin'],
        permissions: { ...ROLE_MATRIX.Admin, user_role_admin: { read: true, write: false } },
      },
    });
    expect(screen.queryByRole('button', { name: 'New user' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Edit / })).not.toBeInTheDocument();
    expect(screen.getByTestId('read-only-notice')).toBeInTheDocument();
  });

  it('degrades to an access notice on a 403', () => {
    hooks.useUsers.mockReturnValue({ data: undefined, isPending: false, isError: true, error: new ApiError(403, 'forbidden'), refetch: vi.fn() });
    renderWithProviders(<AdminUsersPage />);
    expect(screen.getByText(/does not have access to User \/ Role Admin/)).toBeInTheDocument();
  });
});

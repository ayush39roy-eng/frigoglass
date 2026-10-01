import * as React from 'react';
import { ChevronLeft, ChevronRight, Plus, Search, ShieldCheck, Users } from 'lucide-react';

import { PageHeader } from '@/components/layout/page-header';
import { TileStat } from '@/components/ui/stat-variants';
import { SectionBoundary } from '@/components/shared/section-boundary';
import { EmptyState } from '@/components/shared/empty-state';
import { ReadOnlyNotice, WriteGate } from '@/components/session/write-gate';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { ApiError } from '@/lib/api/client';
import { useHubs } from '@/lib/api/reference';
import { formatInteger } from '@/lib/format';
import { useDebouncedValue } from '@/lib/use-debounced-value';
import { SURFACES } from '@/app/nav';
import { usePermission, useSessionStore } from '@/stores/session';
import { useEngineerOptions } from '@/surfaces/registration/hooks/use-registration';

import { AccessNotice } from './components/access-notice';
import { ProjectAccessTab } from './components/project-access-tab';
import { UserFormDialog } from './components/user-form';
import { UsersTable } from './components/users-table';
import type { UserCreateRequest, UserRead, UserUpdateRequest } from './api/types';
import { useCreateUser, useRoles, useUpdateUser, useUsers } from './hooks/use-users';
import { callerCanManage } from './lib/user-helpers';

const ADMIN_SURFACE = SURFACES.find((s) => s.path === '/admin/users');
const PAGE_SIZE = 100;

function authKind(errors: unknown[]): 'forbidden' | 'unauthorized' | null {
  for (const err of errors) if (err instanceof ApiError && err.isForbidden) return 'forbidden';
  for (const err of errors) if (err instanceof ApiError && err.isUnauthorized) return 'unauthorized';
  return null;
}


export default function AdminUsersPage(): React.JSX.Element {
  const [search, setSearch] = React.useState('');
  const [offset, setOffset] = React.useState(0);
  const [formOpen, setFormOpen] = React.useState(false);
  const [formMode, setFormMode] = React.useState<'create' | 'edit'>('create');
  const [editUser, setEditUser] = React.useState<UserRead | null>(null);

  const q = useDebouncedValue(search.trim());
  // Reset to the first page when the search changes (render-phase adjust, as the Audit Log does).
  const [prevQ, setPrevQ] = React.useState(q);
  if (q !== prevQ) {
    setPrevQ(q);
    setOffset(0);
  }

  const me = useSessionStore((s) => s.me);
  const permission = usePermission('user_role_admin');
  const callerIsSuperAdmin = me?.roles.includes('Super Admin') ?? false;

  const usersQuery = useUsers({ q: q || undefined, limit: PAGE_SIZE, offset });
  const rolesQuery = useRoles();
  const hubsQuery = useHubs();
  const engineersQuery = useEngineerOptions(undefined);
  const createMut = useCreateUser();
  const updateMut = useUpdateUser();

  const title = ADMIN_SURFACE?.title ?? 'User / Role Admin';
  const description =
    ADMIN_SURFACE?.summary ?? 'Users, their roles, hub scope and engineer link (ADR 0010).';

  const denied = authKind([usersQuery.error, rolesQuery.error]);

  const hubNameById = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const h of hubsQuery.data ?? []) map.set(h.id, h.name);
    return map;
  }, [hubsQuery.data]);

  const totalCount = usersQuery.data?.total_count ?? 0;
  const rangeStart = totalCount === 0 ? 0 : offset + 1;
  const rangeEnd = Math.min(offset + PAGE_SIZE, totalCount);

  const handleNew = React.useCallback(() => {
    setFormMode('create');
    setEditUser(null);
    setFormOpen(true);
  }, []);
  const handleEdit = React.useCallback((user: UserRead) => {
    setFormMode('edit');
    setEditUser(user);
    setFormOpen(true);
  }, []);
  const handleSubmit = React.useCallback(
    async (body: UserCreateRequest | UserUpdateRequest) => {
      if (formMode === 'create') {
        await createMut.mutateAsync(body as UserCreateRequest);
      } else if (editUser) {
        await updateMut.mutateAsync({ userId: editUser.id, body });
      }
    },
    [formMode, editUser, createMut, updateMut],
  );

  return (
    <>
      <PageHeader
        title={title}
        description={description}
        actions={
          <WriteGate surface="user_role_admin">
            <Button type="button" size="sm" onClick={handleNew}>
              <Plus />
              New user
            </Button>
          </WriteGate>
        }
      />

      {/* Two independent sections, not one gate (ADR 0012 §5): a manager
          delegate (Hub Planner, Portfolio Manager, ...) has no
          `user_role_admin` surface permission at all and 403s on the Users
          tab's own `/users`/`/roles` reads below, but can still hold
          delegation rights on the Project Access tab's per-project
          `GET .../access` — see `routes.tsx`'s note on why `/admin/users`
          is not wrapped in `<RequireRead>` like every other surface. */}
      {usersQuery.data ? (
        <div className="mb-s6 grid gap-gutter sm:grid-cols-2 xl:max-w-3xl">
          <TileStat
            label="Users"
            value={usersQuery.data.total_count}
            icon={Users}
            accent="primary"
            hint={q ? 'Matching your search' : 'Accounts in the system'}
          />
          <TileStat
            label="Admins on this page"
            value={usersQuery.data.items.filter((u) => u.roles.includes('Admin') || u.roles.includes('Super Admin')).length}
            icon={ShieldCheck}
            accent="neutral"
            hint="Admin or Super Admin"
          />
        </div>
      ) : null}
      <Tabs defaultValue="users">
        <TabsList>
          <TabsTrigger value="users">Users</TabsTrigger>
          <TabsTrigger value="project-access">Project Access</TabsTrigger>
        </TabsList>
        <TabsContent value="users">
          {denied ? (
        <AccessNotice kind={denied} />
      ) : (
        <div className="flex flex-col gap-4">
          <ReadOnlyNotice surface="user_role_admin" what="Creating or editing users" />
          {!callerIsSuperAdmin && permission.write ? (
            <p className="text-2xs text-text-muted" role="note">
              As an Admin you manage the non-admin roles. Admin and Super Admin accounts, and
              granting those roles, are reserved for a Super Admin.
            </p>
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle>Users</CardTitle>
              <span className="text-2xs text-text-muted" data-numeric="">
                {totalCount === 0
                  ? '0 users'
                  : `${formatInteger(rangeStart)}–${formatInteger(rangeEnd)} of ${formatInteger(totalCount)}`}
              </span>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="relative max-w-sm">
                <Label htmlFor="users-search" className="sr-only">
                  Search users
                </Label>
                <Search
                  className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-text-subtle"
                  aria-hidden="true"
                />
                <Input
                  id="users-search"
                  type="search"
                  className="pl-8"
                  placeholder="Search by email or name…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>

              <SectionBoundary
                query={usersQuery}
                title="Users"
                errorDescription="The user list could not be loaded."
              >
                {(data) =>
                  data.items.length === 0 ? (
                    <EmptyState
                      title={q ? 'No users match this search' : 'No users yet'}
                      description={
                        q
                          ? 'Try a different email or name.'
                          : 'Users appear here when they first sign in through SSO, or when you create one.'
                      }
                      action={
                        !q ? (
                          <WriteGate surface="user_role_admin">
                            <Button type="button" size="sm" onClick={handleNew}>
                              <Plus />
                              New user
                            </Button>
                          </WriteGate>
                        ) : undefined
                      }
                    />
                  ) : (
                    <>
                      <UsersTable
                        rows={data.items}
                        hubNameById={hubNameById}
                        canWrite={permission.write}
                        canManage={(user) => callerCanManage(callerIsSuperAdmin, user)}
                        onEdit={handleEdit}
                      />
                      <div className="flex items-center justify-end gap-2">
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          disabled={offset === 0}
                          onClick={() => setOffset((prev) => Math.max(0, prev - PAGE_SIZE))}
                        >
                          <ChevronLeft />
                          Previous
                        </Button>
                        <Button
                          type="button"
                          variant="secondary"
                          size="sm"
                          disabled={offset + PAGE_SIZE >= totalCount}
                          onClick={() => setOffset((prev) => prev + PAGE_SIZE)}
                        >
                          Next
                          <ChevronRight />
                        </Button>
                      </div>
                    </>
                  )
                }
              </SectionBoundary>
            </CardContent>
          </Card>
        </div>
          )}
        </TabsContent>
        <TabsContent value="project-access">
          <ProjectAccessTab />
        </TabsContent>
      </Tabs>

      <UserFormDialog
        mode={formMode}
        user={editUser}
        open={formOpen}
        onOpenChange={setFormOpen}
        roles={rolesQuery.data ?? []}
        hubs={hubsQuery.data ?? []}
        engineers={engineersQuery.data ?? []}
        managerOptions={usersQuery.data?.items ?? []}
        onSubmit={handleSubmit}
      />
    </>
  );
}

import * as React from 'react';
import { Lock, Trash2 } from 'lucide-react';

import { EmptyState } from '@/components/shared/empty-state';
import { SectionBoundary } from '@/components/shared/section-boundary';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApiError } from '@/lib/api/client';
import { apiErrorMessage } from '@/lib/api/error-messages';
import { useHubs } from '@/lib/api/reference';
import { formatTimestamp } from '@/lib/format';
import { ConfirmDialog } from '@/surfaces/planning/components/confirm-dialog';

import { PROJECT_ACCESS_ROLES, type ProjectAccessGrantRead, type ProjectAccessRole, type UserRead } from '../api/types';
import {
  useCreateProjectAccessGrant,
  useProjectAccessGrants,
  useRevokeProjectAccessGrant,
} from '../hooks/use-project-access';
import { useProjectsForPicker } from '../hooks/use-projects-for-picker';
import { useUsersForPicker } from '../hooks/use-users';
import { SearchPicker } from './search-picker';

/**
 * Project Access tab (ADR 0012 §5): ONE code path for both Super Admin (sees
 * every grant on the selected project) and a manager delegate (sees only
 * their own reports' grants on it) — the server's `GET/POST/DELETE
 * /projects/{id}/access` already narrows by caller, so this component never
 * branches on the caller's role itself. A caller with no delegation rights
 * at all on the selected project gets a 403 from the list endpoint, shown as
 * an explicit empty/disabled state (never a silent empty table).
 *
 * There is no cross-project grant list endpoint (`project-access-api.ts`), so
 * this is project-first: pick a project, then manage its grants.
 */
export function ProjectAccessTab(): React.JSX.Element {
  const [selectedProject, setSelectedProject] = React.useState<{ id: string; name: string } | null>(null);

  const projectsQuery = useProjectsForPicker();
  const hubsQuery = useHubs();
  const usersQuery = useUsersForPicker();

  const hubNameById = React.useMemo(() => {
    const map = new Map<string, string>();
    for (const h of hubsQuery.data ?? []) map.set(h.id, h.name);
    return map;
  }, [hubsQuery.data]);

  const projectOptions = React.useMemo(
    () =>
      (projectsQuery.data ?? []).map((p) => ({
        id: p.id,
        label: p.name,
        sublabel: hubNameById.get(p.hub_id) ?? undefined,
      })),
    [projectsQuery.data, hubNameById],
  );

  const usersById = React.useMemo(() => {
    const map = new Map<string, UserRead>();
    for (const u of usersQuery.data?.items ?? []) map.set(u.id, u);
    return map;
  }, [usersQuery.data]);

  return (
    <div className="flex flex-col gap-s4">
      <Card>
        <CardHeader>
          <CardTitle>Choose a project</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          <SearchPicker
            label="Search projects"
            placeholder="Search projects by name…"
            options={projectOptions}
            disabled={projectsQuery.isPending}
            onSelect={(o) => setSelectedProject({ id: o.id, name: o.label })}
          />
          {selectedProject ? (
            <div className="flex items-center gap-2 text-xs text-text">
              <span className="text-text-muted">Managing access for</span>
              <Badge tone="outline">{selectedProject.name}</Badge>
              <Button type="button" variant="ghost" size="sm" onClick={() => setSelectedProject(null)}>
                Change
              </Button>
            </div>
          ) : null}
        </CardContent>
      </Card>

      {selectedProject ? (
        <ProjectGrants
          projectId={selectedProject.id}
          projectName={selectedProject.name}
          usersById={usersById}
          userOptions={(usersQuery.data?.items ?? []).map((u) => ({
            id: u.id,
            label: u.full_name,
            sublabel: u.email,
          }))}
        />
      ) : null}
    </div>
  );
}

function resolveUser(usersById: ReadonlyMap<string, UserRead>, userId: string): string {
  const u = usersById.get(userId);
  return u ? `${u.full_name} (${u.email})` : userId;
}

function ProjectGrants({
  projectId,
  projectName,
  usersById,
  userOptions,
}: {
  projectId: string;
  projectName: string;
  usersById: ReadonlyMap<string, UserRead>;
  userOptions: { id: string; label: string; sublabel?: string }[];
}): React.JSX.Element {
  const grantsQuery = useProjectAccessGrants(projectId);
  const createMut = useCreateProjectAccessGrant(projectId);
  const revokeMut = useRevokeProjectAccessGrant(projectId);

  const [pendingUser, setPendingUser] = React.useState<{ id: string; label: string } | null>(null);
  const [pendingRole, setPendingRole] = React.useState<ProjectAccessRole>('viewer');
  const [grantError, setGrantError] = React.useState<string | null>(null);
  const [revokeTarget, setRevokeTarget] = React.useState<ProjectAccessGrantRead | null>(null);

  const forbidden = grantsQuery.error instanceof ApiError && grantsQuery.error.isForbidden;

  if (forbidden) {
    return (
      <Card>
        <CardContent className="pt-s4">
          <EmptyState
            media={<Lock className="size-8" />}
            title="No delegation rights on this project"
            description="You are not a Super Admin, a global Admin, or a manager with Admin-level access on this project. Access grants here are managed by whoever is."
          />
        </CardContent>
      </Card>
    );
  }

  const submitGrant = async () => {
    if (!pendingUser) return;
    setGrantError(null);
    try {
      await createMut.mutateAsync({ user_id: pendingUser.id, project_role: pendingRole });
      setPendingUser(null);
      setPendingRole('viewer');
    } catch (err) {
      setGrantError(apiErrorMessage(err, 'This grant could not be created.'));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Access grants — {projectName}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap items-end gap-2 rounded-lg border border-border bg-surface-sunken p-3">
          <div className="min-w-[14rem] flex-1">
            <SearchPicker
              label="Grant access to"
              placeholder="Search users by name or email…"
              options={userOptions}
              onSelect={(o) => setPendingUser({ id: o.id, label: o.label })}
            />
          </div>
          <Select value={pendingRole} onValueChange={(v) => setPendingRole(v as ProjectAccessRole)}>
            <SelectTrigger className="h-9 w-32" aria-label="Project role">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PROJECT_ACCESS_ROLES.map((r) => (
                <SelectItem key={r} value={r}>
                  {r.charAt(0).toUpperCase() + r.slice(1)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            size="sm"
            disabled={!pendingUser || createMut.isPending}
            onClick={() => void submitGrant()}
          >
            {createMut.isPending ? 'Granting…' : 'Grant access'}
          </Button>
          {pendingUser ? (
            <span className="w-full text-2xs text-text-muted">
              Selected: <span className="font-medium text-text">{pendingUser.label}</span>
            </span>
          ) : null}
        </div>
        {grantError ? (
          <p role="alert" className="text-2xs text-danger">
            {grantError}
          </p>
        ) : null}

        <SectionBoundary
          query={grantsQuery}
          title="Access grants"
          errorDescription="This project's access grants could not be loaded."
        >
          {(grants) =>
            grants.length === 0 ? (
              <EmptyState
                title="No active grants on this project"
                description="Grants give a user access to this one project regardless of their hub or role."
              />
            ) : (
              <ul className="divide-y divide-border rounded-lg border border-border" aria-label="Active grants">
                {grants.map((g) => (
                  <li key={g.id} className="flex items-center gap-3 px-3 py-2 text-xs" data-testid="access-grant-row">
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium text-text">{resolveUser(usersById, g.user_id)}</div>
                      <div className="text-2xs text-text-subtle">
                        Granted by {resolveUser(usersById, g.granted_by_user_id)} ·{' '}
                        <time dateTime={g.created_at}>{formatTimestamp(g.created_at)}</time>
                      </div>
                    </div>
                    <Badge tone={g.project_role === 'admin' ? 'primary' : g.project_role === 'editor' ? 'outline' : 'neutral'}>
                      {g.project_role.charAt(0).toUpperCase() + g.project_role.slice(1)}
                    </Badge>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      className="size-7"
                      aria-label={`Revoke access for ${resolveUser(usersById, g.user_id)}`}
                      onClick={() => setRevokeTarget(g)}
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </li>
                ))}
              </ul>
            )
          }
        </SectionBoundary>
      </CardContent>

      <ConfirmDialog
        open={revokeTarget !== null}
        onOpenChange={(o) => {
          if (!o) setRevokeTarget(null);
        }}
        title="Revoke this access grant?"
        description="The user returns to whatever their role and hub scope alone would give them — never below it."
        confirmLabel="Revoke"
        busy={revokeMut.isPending}
        onConfirm={() => {
          if (revokeTarget) void revokeMut.mutateAsync(revokeTarget.id).finally(() => setRevokeTarget(null));
        }}
      />
    </Card>
  );
}

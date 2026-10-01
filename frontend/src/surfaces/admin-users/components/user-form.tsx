import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApiError } from '@/lib/api/client';
import { apiErrorMessage } from '@/lib/api/error-messages';
import type { Hub } from '@/lib/api/reference';
import type { EngineerOption } from '@/surfaces/registration/api/engineers-api';
import type { RoleName } from '@/types/enums';

import { type RoleRead, type UserCreateRequest, type UserRead, type UserUpdateRequest } from '../api/types';

/**
 * Create / edit dialog for one user (`POST /users` / `PATCH /users/{id}`,
 * contract §2). `react-hook-form` + `zod` for the text fields; roles, hub
 * scope, engineer link and the active toggle are local state merged in at
 * submit (the same pattern as Registration's `project-form.tsx`).
 *
 * Roles honour `RoleRead.assignable`: an Admin sees Admin / Super Admin
 * disabled with the reason (ADR 0010 §1 — only a Super Admin grants those).
 * The `LAST_SUPER_ADMIN` 409 and the admin-touches-admin 403 are shown inline;
 * the server remains the authority on both.
 */

const NONE = '__none__';

const userFormSchema = z.object({
  email: z.string().trim().min(1, 'Email is required').email('Enter a valid email address').max(320),
  full_name: z.string().trim().min(1, 'Name is required').max(300, 'Max 300 characters'),
});
type UserFormValues = z.infer<typeof userFormSchema>;

export interface UserFormDialogProps {
  mode: 'create' | 'edit';
  /** Required (non-null) when `mode === 'edit'`. */
  user: UserRead | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  roles: RoleRead[];
  hubs: Hub[];
  engineers: EngineerOption[];
  /** Candidates for the "Manager" picker (ADR 0012) — every other user;
   *  the edited user themself is excluded by the caller or filtered below.
   *  Ignored in `create` mode: `manager_id` is PATCH-only. */
  managerOptions: UserRead[];
  onSubmit: (body: UserCreateRequest | UserUpdateRequest) => Promise<unknown>;
}

export function UserFormDialog(props: UserFormDialogProps): React.JSX.Element {
  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="max-w-xl">
        {props.mode === 'edit' && props.user === null ? null : (
          <UserForm key={props.user?.id ?? 'new'} {...props} />
        )}
      </DialogContent>
    </Dialog>
  );
}

function UserForm({
  mode,
  user,
  roles,
  hubs,
  engineers,
  managerOptions,
  onOpenChange,
  onSubmit,
}: UserFormDialogProps): React.JSX.Element {
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const [selectedRoles, setSelectedRoles] = React.useState<RoleName[]>(user?.roles ?? []);
  const [hubScopeAll, setHubScopeAll] = React.useState<boolean>(user?.hub_scope_all ?? true);
  const [hubIds, setHubIds] = React.useState<string[]>(user?.hub_ids ?? []);
  const [engineerId, setEngineerId] = React.useState<string>(user?.engineer_id ?? NONE);
  const [isActive, setIsActive] = React.useState<boolean>(user?.is_active ?? true);
  const [managerId, setManagerId] = React.useState<string>(user?.manager_id ?? NONE);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<UserFormValues>({
    resolver: zodResolver(userFormSchema),
    defaultValues: { email: user?.email ?? '', full_name: user?.full_name ?? '' },
    mode: 'onChange',
  });

  const toggleRole = (role: RoleName, checked: boolean) =>
    setSelectedRoles((prev) => (checked ? [...new Set([...prev, role])] : prev.filter((r) => r !== role)));
  const toggleHub = (id: string, checked: boolean) =>
    setHubIds((prev) => (checked ? [...new Set([...prev, id])] : prev.filter((h) => h !== id)));

  const submit = handleSubmit(async (values) => {
    setSubmitError(null);
    const base = {
      full_name: values.full_name,
      roles: selectedRoles,
      hub_scope_all: hubScopeAll,
      hub_ids: hubScopeAll ? [] : hubIds,
      engineer_id: engineerId === NONE ? null : engineerId,
    };
    const body: UserCreateRequest | UserUpdateRequest =
      mode === 'create'
        ? { email: values.email, ...base }
        : { ...base, is_active: isActive, manager_id: managerId === NONE ? null : managerId };
    try {
      await onSubmit(body);
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError && err.isForbidden && !err.code) {
        setSubmitError('Only a Super Admin can change an Admin or Super Admin account or grant those roles.');
      } else {
        // LAST_SUPER_ADMIN (409), ADMIN_ACCOUNT_REQUIRES_SUPER_ADMIN (403), …
        setSubmitError(apiErrorMessage(err, 'The user could not be saved. Please try again.'));
      }
    }
  });

  return (
    <form onSubmit={submit} noValidate>
      <DialogHeader>
        <DialogTitle>{mode === 'create' ? 'Create a user' : `Edit ${user?.email ?? 'user'}`}</DialogTitle>
        <DialogDescription>
          Users sign in through the organisation&rsquo;s identity provider — there are no
          passwords here. Roles decide what the user can see and edit; hub scope limits rows.
        </DialogDescription>
      </DialogHeader>

      <div className="my-4 max-h-[60vh] space-y-5 overflow-y-auto pr-1">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor="user-email" className="text-xs">
              Email <span className="text-danger">*</span>
            </Label>
            <Input
              id="user-email"
              type="email"
              autoComplete="off"
              readOnly={mode === 'edit'}
              aria-invalid={errors.email ? true : undefined}
              {...register('email')}
            />
            {errors.email ? (
              <span role="alert" className="text-2xs text-danger">
                {errors.email.message}
              </span>
            ) : mode === 'edit' ? (
              <span className="text-2xs text-text-subtle">Email is the identity-provider key and cannot change.</span>
            ) : null}
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="user-name" className="text-xs">
              Full name <span className="text-danger">*</span>
            </Label>
            <Input id="user-name" aria-invalid={errors.full_name ? true : undefined} {...register('full_name')} />
            {errors.full_name ? (
              <span role="alert" className="text-2xs text-danger">
                {errors.full_name.message}
              </span>
            ) : null}
          </div>
        </div>

        <fieldset className="space-y-2">
          <legend className="text-2xs font-semibold uppercase tracking-wide text-text-muted">Roles</legend>
          <div className="grid gap-1.5 sm:grid-cols-2">
            {roles.map((role) => {
              const checked = selectedRoles.includes(role.name);
              return (
                <label
                  key={role.name}
                  className={`flex items-start gap-2 rounded-control border border-border px-2 py-1.5 text-xs ${role.assignable ? 'text-text' : 'text-text-muted'}`}
                >
                  <Checkbox
                    checked={checked}
                    disabled={!role.assignable}
                    onCheckedChange={(next) => toggleRole(role.name, next === true)}
                    aria-label={role.name}
                  />
                  <span className="min-w-0">
                    <span className="block font-medium">{role.name}</span>
                    <span className="block text-2xs text-text-subtle">
                      {role.assignable ? role.description : 'Only a Super Admin can grant this role'}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        <fieldset className="space-y-2">
          <legend className="text-2xs font-semibold uppercase tracking-wide text-text-muted">Hub scope</legend>
          <label className="flex items-center gap-2 text-xs text-text">
            <Checkbox checked={hubScopeAll} onCheckedChange={(next) => setHubScopeAll(next === true)} />
            All hubs
          </label>
          {!hubScopeAll ? (
            <div className="grid gap-1.5 pl-6 sm:grid-cols-2">
              {hubs.map((hub) => (
                <label key={hub.id} className="flex items-center gap-2 text-xs text-text">
                  <Checkbox
                    checked={hubIds.includes(hub.id)}
                    onCheckedChange={(next) => toggleHub(hub.id, next === true)}
                    aria-label={hub.name}
                  />
                  {hub.name}
                </label>
              ))}
            </div>
          ) : null}
        </fieldset>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor="user-engineer" className="text-xs">
              Linked engineer
            </Label>
            <Select value={engineerId} onValueChange={setEngineerId}>
              <SelectTrigger id="user-engineer" className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>Not linked</SelectItem>
                {engineers.map((e) => (
                  <SelectItem key={e.id} value={e.id}>
                    {e.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <span className="text-2xs text-text-subtle">
              Lets the Engineer role see its own assignments.
            </span>
          </div>
          {mode === 'edit' ? (
            <label className="flex items-center gap-2 self-end pb-5 text-xs text-text">
              <Checkbox checked={isActive} onCheckedChange={(next) => setIsActive(next === true)} />
              Active
            </label>
          ) : null}
        </div>

        {mode === 'edit' ? (
          <div className="flex flex-col gap-1">
            <Label htmlFor="user-manager" className="text-xs">
              Manager
            </Label>
            <Select value={managerId} onValueChange={setManagerId}>
              <SelectTrigger id="user-manager" className="h-8">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>No manager</SelectItem>
                {managerOptions
                  .filter((m) => m.id !== user?.id)
                  .map((m) => (
                    <SelectItem key={m.id} value={m.id}>
                      {m.full_name} ({m.email})
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            <span className="text-2xs text-text-subtle">
              Lets this manager grant/revoke this user&rsquo;s project access on projects the
              manager can already administer (ADR 0012).
            </span>
          </div>
        ) : null}
      </div>

      {submitError ? (
        <p role="alert" className="mb-2 text-2xs text-danger">
          {submitError}
        </p>
      ) : null}

      <DialogFooter>
        <Button type="button" variant="secondary" size="sm" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={isSubmitting}>
          {isSubmitting ? 'Saving…' : mode === 'create' ? 'Create user' : 'Save changes'}
        </Button>
      </DialogFooter>
    </form>
  );
}

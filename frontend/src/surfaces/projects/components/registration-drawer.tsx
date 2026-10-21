import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { CharterFieldList } from '@/components/shared/charter-fields';
import { ErrorState } from '@/components/shared/error-state';
import { ProjectStatusBadge } from '@/components/shared/project-status-badge';
import { applyFormPriorityMove } from '@/components/shared/priority-move/form-priority-move';
import type { PriorityMoveApi } from '@/components/shared/priority-move/priority-move-context';
import { ApiError } from '@/lib/api/client';
import type { Hub } from '@/lib/api/reference';
import { queryKeys } from '@/lib/query-keys';
import { cn } from '@/lib/utils';
import type { ProjectStatus } from '@/types/enums';

import { fetchProject } from '@/surfaces/registration/api/registration-api';
import type { ProjectCreateRequest, ProjectRead } from '@/surfaces/registration/api/types';
import { HardGatePanel } from '@/surfaces/registration/components/hard-gate-panel';
import { ProjectForm } from '@/surfaces/registration/components/project-form';
import {
  useCreateProject,
  useSubmitProject,
  useUpdateProject,
} from '@/surfaces/registration/hooks/use-registration';

/**
 * P22-T01: the Project Registration form as a full-height side drawer on the
 * Projects page (owner request "club the project registration and all project
 * page"). Opened by "Register project" (create), a row's "Edit registration"
 * (edit), or a `?edit=<id>` deep link.
 *
 * Same endpoints and payloads as the old `/register` page: `POST /projects`,
 * `PATCH /projects/{id}` (with the P14 priority preview first and the P11
 * recalc headers after), `GET /projects/{id}/hard-gate-status` and
 * `POST /projects/{id}/submit`. Nothing is computed here; the hard-gate verdict
 * is the served one (I9).
 *
 * Radix Dialog gives the focus trap, Escape and focus return to the trigger.
 * Every close path (Escape, overlay, the X, Cancel) goes through `requestClose`,
 * which asks before discarding edits. A successful save closes without asking.
 */

export type RegistrationDrawerState = { mode: 'create' } | { mode: 'edit'; projectId: string } | null;

export interface RegistrationSaved {
  mode: 'create' | 'edit';
  /** Undefined only if the server answered without a body (never, in practice). */
  project: ProjectRead | undefined;
}

export interface RegistrationDrawerProps {
  state: RegistrationDrawerState;
  /** Called once the drawer has decided to close (after any discard prompt). */
  onClose: (saved: RegistrationSaved | null) => void;
  hubs: Hub[];
  /** The page's priority-move host (`usePriorityMoveFlow().api`); its dialogs and
   *  result panel live on the page so they survive the drawer closing. */
  moveApi: PriorityMoveApi;
  /** A write came back 403: the page downgrades to read-only. */
  onForbidden: () => void;
  /** A legacy Draft project left Draft (the list refreshes; the drawer stays open). */
  onSubmitted: () => void;
  /** The control that opened the drawer; focus returns to it on close when it
   *  is still on the page (Radix's own return covers the rest). */
  returnFocusTo?: React.RefObject<HTMLElement | null>;
}

export default function RegistrationDrawer({
  state,
  onClose,
  hubs,
  moveApi,
  onForbidden,
  onSubmitted,
  returnFocusTo,
}: RegistrationDrawerProps): React.JSX.Element {
  const open = state !== null;
  const [dirty, setDirty] = React.useState(false);
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const savedRef = React.useRef<RegistrationSaved | null>(null);

  // A fresh drawer starts clean.
  const stateKey = state === null ? 'closed' : state.mode === 'create' ? 'create' : `edit:${state.projectId}`;
  const [prevKey, setPrevKey] = React.useState(stateKey);
  if (prevKey !== stateKey) {
    setPrevKey(stateKey);
    setDirty(false);
    setConfirmOpen(false);
  }
  React.useEffect(() => {
    savedRef.current = null;
  }, [stateKey]);

  // Leaving the page (reload, closing the tab) with unsaved edits asks first.
  React.useEffect(() => {
    if (!open || !dirty) return;
    const onBeforeUnload = (event: BeforeUnloadEvent): void => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [open, dirty]);

  const requestClose = React.useCallback(() => {
    const saved = savedRef.current;
    if (saved) {
      onClose(saved);
      return;
    }
    if (dirty) {
      setConfirmOpen(true);
      return;
    }
    onClose(null);
  }, [dirty, onClose]);

  const handleDirtyChange = React.useCallback((next: boolean) => setDirty(next), []);

  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) requestClose();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className={cn(
            'fixed inset-0 z-50 bg-slate-950/50',
            'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
          )}
        />
        <DialogPrimitive.Content
          data-testid="registration-drawer"
          onCloseAutoFocus={(event) => {
            const target = returnFocusTo?.current;
            if (target && target.isConnected) {
              event.preventDefault();
              target.focus();
            }
          }}
          className={cn(
            // Full screen on narrow viewports; a right-hand sheet from `sm` up.
            'fixed inset-y-0 right-0 z-50 flex h-full w-full flex-col bg-surface shadow-lg sm:max-w-2xl sm:border-l sm:border-border',
            'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right',
          )}
        >
          {state === null ? null : state.mode === 'create' ? (
            <CreateBody
              hubs={hubs}
              onDirtyChange={handleDirtyChange}
              requestClose={requestClose}
              onSaved={(saved) => {
                savedRef.current = saved;
              }}
              onForbidden={onForbidden}
            />
          ) : (
            <EditBody
              projectId={state.projectId}
              hubs={hubs}
              moveApi={moveApi}
              dirty={dirty}
              onDirtyChange={handleDirtyChange}
              requestClose={requestClose}
              onSaved={(saved) => {
                savedRef.current = saved;
              }}
              onForbidden={onForbidden}
              onSubmitted={onSubmitted}
            />
          )}
          <DialogPrimitive.Close
            className="absolute right-3 top-3 rounded p-1 text-text-muted transition-colors hover:bg-surface-raised hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Close"
          >
            <X className="size-4" aria-hidden="true" />
          </DialogPrimitive.Close>

          <DiscardChangesDialog
            open={confirmOpen}
            onKeepEditing={() => setConfirmOpen(false)}
            onDiscard={() => {
              setConfirmOpen(false);
              setDirty(false);
              onClose(null);
            }}
          />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

function CreateBody({
  hubs,
  onDirtyChange,
  requestClose,
  onSaved,
  onForbidden,
}: {
  hubs: Hub[];
  onDirtyChange: (dirty: boolean) => void;
  requestClose: () => void;
  onSaved: (saved: RegistrationSaved) => void;
  onForbidden: () => void;
}): React.JSX.Element {
  const createMut = useCreateProject();
  const handleSubmit = async (body: ProjectCreateRequest): Promise<void> => {
    try {
      // P23-T02: `POST /projects` requires the hard-gate fields and creates the
      // project In Queue (no Draft). A 422 maps onto the fields in the form.
      const created: unknown = await createMut.mutateAsync(body);
      onSaved({ mode: 'create', project: isProject(created) ? created : undefined });
    } catch (err) {
      if (err instanceof ApiError && err.isForbidden) onForbidden();
      throw err;
    }
  };
  return (
    <ProjectForm
      key="new"
      mode="create"
      project={null}
      hubs={hubs}
      variant="sheet"
      onDirtyChange={onDirtyChange}
      onOpenChange={(next) => {
        if (!next) requestClose();
      }}
      onSubmit={handleSubmit}
    />
  );
}

function isProject(value: unknown): value is ProjectRead {
  return typeof value === 'object' && value !== null && typeof (value as { id?: unknown }).id === 'string';
}

function EditBody({
  projectId,
  hubs,
  moveApi,
  dirty,
  onDirtyChange,
  requestClose,
  onSaved,
  onForbidden,
  onSubmitted,
}: {
  projectId: string;
  hubs: Hub[];
  moveApi: PriorityMoveApi;
  dirty: boolean;
  onDirtyChange: (dirty: boolean) => void;
  requestClose: () => void;
  onSaved: (saved: RegistrationSaved) => void;
  onForbidden: () => void;
  onSubmitted: () => void;
}): React.JSX.Element {
  const query = useQuery({
    queryKey: queryKeys.project(projectId),
    queryFn: ({ signal }) => fetchProject(projectId, { signal }),
    retry: false,
  });
  const updateMut = useUpdateProject();
  const submitMut = useSubmitProject();
  const [submitted, setSubmitted] = React.useState<ProjectStatus | null>(null);

  if (query.isPending) {
    return (
      <div className="flex flex-col gap-4 p-5" aria-busy="true">
        <DialogPrimitive.Title className="text-base font-semibold text-text">Loading registration…</DialogPrimitive.Title>
        <DialogPrimitive.Description className="sr-only">The project&apos;s registration is loading.</DialogPrimitive.Description>
        <Skeleton className="h-8 w-2/3" />
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (query.isError) {
    const forbidden = query.error instanceof ApiError && query.error.isForbidden;
    return (
      <div className="flex flex-col gap-4 p-5">
        <DialogPrimitive.Title className="text-base font-semibold text-text">Registration unavailable</DialogPrimitive.Title>
        <DialogPrimitive.Description className="text-sm text-text-muted">
          {forbidden
            ? 'Your role cannot open this project’s registration.'
            : 'The project’s registration could not be loaded.'}
        </DialogPrimitive.Description>
        {forbidden ? null : (
          <ErrorState description="Try again in a moment." onRetry={() => void query.refetch()} />
        )}
        <div>
          <Button type="button" variant="secondary" size="sm" onClick={requestClose}>
            Close
          </Button>
        </div>
      </div>
    );
  }

  const project = query.data;

  const handleSubmit = async (body: ProjectCreateRequest): Promise<void> => {
    try {
      // P14 (ADR 0026): a changed priority goes through the preview dialog first;
      // Yes applies it, then the rest of the form is PATCHed. No saves nothing.
      const rest = await applyFormPriorityMove(
        moveApi,
        { projectId: project.id, projectName: project.name, priority: project.priority, status: project.status },
        body,
      );
      const result = await updateMut.mutateAsync({ projectId: project.id, body: rest });
      // P11 (ADR 0015): a PATCH that changed priority reports the recalc in its
      // X-Schedule-* headers; show the same progress / "Timeline updated" panel.
      if (result?.recalc) {
        moveApi.followPatch(
          {
            projectId: project.id,
            projectName: result.project.name,
            priority: project.priority,
            status: result.project.status,
          },
          result.recalc,
          project.priority,
          result.project.priority,
        );
      }
      onSaved({ mode: 'edit', project: result?.project ?? project });
    } catch (err) {
      if (err instanceof ApiError && err.isForbidden) onForbidden();
      throw err;
    }
  };

  const handleGateSubmit = async (id: string, targetStatus: ProjectStatus): Promise<void> => {
    try {
      await submitMut.mutateAsync({ projectId: id, body: { target_status: targetStatus } });
      setSubmitted(targetStatus);
      onSubmitted();
    } catch (err) {
      if (err instanceof ApiError && err.isForbidden) onForbidden();
      throw err;
    }
  };

  return (
    <ProjectForm
      key={project.id}
      mode="edit"
      project={project}
      hubs={hubs}
      variant="sheet"
      onDirtyChange={onDirtyChange}
      onOpenChange={(next) => {
        if (!next) requestClose();
      }}
      onSubmit={handleSubmit}
      prelude={
        <RegistrationSummary
          project={project}
          dirty={dirty}
          submitted={submitted}
          onGateSubmit={handleGateSubmit}
        />
      }
    />
  );
}

/** The registration facts the old list's expanded row showed that the form
 *  does not (workflow, frozen, stale), and — only for a legacy project that is
 *  still Draft (none today; P23 creates projects In Queue) — the leave-Draft
 *  hard gate. */
function RegistrationSummary({
  project,
  dirty,
  submitted,
  onGateSubmit,
}: {
  project: ProjectRead;
  dirty: boolean;
  submitted: ProjectStatus | null;
  onGateSubmit: (projectId: string, targetStatus: ProjectStatus) => Promise<unknown>;
}): React.JSX.Element {
  return (
    <section aria-label="Registration status" className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-2xs text-text-muted">
        <ProjectStatusBadge status={project.status} />
        <Badge tone="outline">Workflow {project.workflow_id}</Badge>
        {project.frozen ? <Badge tone="outline">Frozen</Badge> : null}
        {project.schedule_stale ? (
          <Badge
            tone="outline"
            className="border-dashed text-text-muted"
            title="Progress or settings changed since the active schedule run"
          >
            Stale
          </Badge>
        ) : null}
      </div>
      <CharterBlock project={project} />
      {submitted ? (
        <p role="status" className="text-2xs font-medium text-success">
          Submitted. The project left Draft for {submitted}.
        </p>
      ) : null}
      {project.status === 'Draft' ? (
        <div className="space-y-2">
          <h3 className="text-2xs font-semibold uppercase tracking-wide text-text-muted">Leave Draft</h3>
          {dirty ? (
            <p className="text-2xs text-text-muted">
              The check below uses the saved values. Save your changes first, then reopen the
              registration to submit.
            </p>
          ) : null}
          <HardGatePanel project={project} onSubmit={onGateSubmit} />
        </div>
      ) : null}
    </section>
  );
}

/** P24-T02 (ADR 0035): the client workbook's charter fields. Served read-only
 *  (a write is rejected with 422), so they are shown here and are not in the
 *  form. */
function CharterBlock({ project }: { project: ProjectRead }): React.JSX.Element {
  const headingId = React.useId();
  return (
    <div
      className="space-y-2 rounded-lg border border-dashed border-border bg-surface-sunken/60 px-3 py-2.5"
      role="group"
      aria-labelledby={headingId}
      data-testid="registration-charter-block"
    >
      <h3 id={headingId} className="text-2xs font-semibold uppercase tracking-wide text-text-muted">
        From the client workbook
      </h3>
      <CharterFieldList project={project} />
      <p className="text-2xs text-text-subtle">Read-only. These values come from the client workbook and cannot be edited here.</p>
    </div>
  );
}

function DiscardChangesDialog({
  open,
  onKeepEditing,
  onDiscard,
}: {
  open: boolean;
  onKeepEditing: () => void;
  onDiscard: () => void;
}): React.JSX.Element {
  return (
    <DialogPrimitive.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onKeepEditing();
      }}
    >
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-[60] bg-slate-950/30" />
        <DialogPrimitive.Content
          role="alertdialog"
          data-testid="discard-changes-dialog"
          className="fixed left-1/2 top-1/2 z-[60] grid w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2 gap-4 rounded-lg border border-border bg-surface p-5 shadow-lg"
        >
          <DialogPrimitive.Title className="text-base font-semibold text-text">Discard unsaved changes?</DialogPrimitive.Title>
          <DialogPrimitive.Description className="text-sm text-text-muted">
            The registration has edits that are not saved. Closing now loses them.
          </DialogPrimitive.Description>
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
            <Button type="button" variant="secondary" size="sm" onClick={onKeepEditing}>
              Keep editing
            </Button>
            <Button type="button" variant="danger" size="sm" onClick={onDiscard}>
              Discard changes
            </Button>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

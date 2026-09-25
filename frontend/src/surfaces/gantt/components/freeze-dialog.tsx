import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Snowflake, TriangleAlert } from 'lucide-react';

import { Button } from '@/components/ui/button';
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
import { ApiError } from '@/lib/api/client';

import type { FreezeToggleRequest, GanttProjectRow } from '../api/types';
import {
  freezeFormSchema,
  type FreezeFormInput,
  type FreezeFormValues,
} from './freeze-schema';

/**
 * Freeze / unfreeze one project (`POST /gantt/projects/{id}/freeze`).
 *
 * - Not frozen → collect `actual_start_week` (required) and submit
 *   `{ frozen: true, actual_start_week }`.
 * - Already frozen → the project's dates are LOCKED; this dialog only offers to
 *   unfreeze (`{ frozen: false }`). Invariant I10: freezing is never presented as
 *   mutating a frozen project's already-locked dates.
 *
 * Freezing does NOT recalculate the schedule — the page shows a "recalc needed"
 * notice after a successful toggle.
 */

export interface FreezeDialogProps {
  project: GanttProjectRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (projectId: string, body: FreezeToggleRequest) => Promise<unknown>;
}

export function FreezeDialog({
  project,
  open,
  onOpenChange,
  onSubmit,
}: FreezeDialogProps): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        {project ? (
          project.frozen ? (
            <UnfreezeBody
              key={project.project_id}
              project={project}
              onOpenChange={onOpenChange}
              onSubmit={onSubmit}
            />
          ) : (
            <FreezeForm
              key={project.project_id}
              project={project}
              onOpenChange={onOpenChange}
              onSubmit={onSubmit}
            />
          )
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function useSubmitError() {
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const handle = React.useCallback((err: unknown) => {
    if (err instanceof ApiError && err.isForbidden) {
      setSubmitError('Your role cannot freeze projects (Hub Planner / Admin only).');
    } else if (err instanceof ApiError) {
      setSubmitError(err.detail ?? 'The change could not be saved. Please try again.');
    } else {
      setSubmitError('The change could not be saved. Please try again.');
    }
  }, []);
  return { submitError, setSubmitError, handle };
}

function FreezeForm({
  project,
  onOpenChange,
  onSubmit,
}: {
  project: GanttProjectRow;
  onOpenChange: (open: boolean) => void;
  onSubmit: FreezeDialogProps['onSubmit'];
}): React.JSX.Element {
  const { submitError, setSubmitError, handle } = useSubmitError();
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FreezeFormInput, unknown, FreezeFormValues>({
    resolver: zodResolver(freezeFormSchema),
    mode: 'onChange',
  });

  const submit = handleSubmit(async (values) => {
    setSubmitError(null);
    try {
      await onSubmit(project.project_id, {
        frozen: true,
        actual_start_week: values.actualStartWeek,
      });
      onOpenChange(false);
    } catch (err) {
      handle(err);
    }
  });

  return (
    <form onSubmit={submit} noValidate>
      <DialogHeader>
        <DialogTitle>Freeze {project.project_name}</DialogTitle>
        <DialogDescription>
          Freezing locks this project&apos;s start at the actual start week and excludes it from
          rescheduling. It does not recalculate the schedule — a Hub Planner or Admin must run a
          recalculation for the change to affect planned dates.
        </DialogDescription>
      </DialogHeader>

      <div className="my-4 space-y-2">
        <Label htmlFor="freeze-actual-start-week" className="text-xs">
          Actual start week <span className="text-danger">*</span>
        </Label>
        <Input
          id="freeze-actual-start-week"
          type="number"
          min={1}
          max={78}
          step={1}
          inputMode="numeric"
          className="h-8 w-24 tnum"
          aria-invalid={errors.actualStartWeek ? true : undefined}
          {...register('actualStartWeek')}
        />
        {errors.actualStartWeek ? (
          <p role="alert" className="text-2xs text-danger">
            {errors.actualStartWeek.message}
          </p>
        ) : (
          <p className="text-2xs text-text-muted">
            Required to freeze — the absolute week (1–78) the project actually started.
          </p>
        )}
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
          <Snowflake />
          {isSubmitting ? 'Freezing…' : 'Freeze project'}
        </Button>
      </DialogFooter>
    </form>
  );
}

function UnfreezeBody({
  project,
  onOpenChange,
  onSubmit,
}: {
  project: GanttProjectRow;
  onOpenChange: (open: boolean) => void;
  onSubmit: FreezeDialogProps['onSubmit'];
}): React.JSX.Element {
  const { submitError, setSubmitError, handle } = useSubmitError();
  const [busy, setBusy] = React.useState(false);

  const unfreeze = async () => {
    setSubmitError(null);
    setBusy(true);
    try {
      await onSubmit(project.project_id, { frozen: false });
      onOpenChange(false);
    } catch (err) {
      handle(err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <DialogHeader>
        <DialogTitle>Unfreeze {project.project_name}</DialogTitle>
        <DialogDescription>
          This project is frozen — its dates are locked and it is excluded from rescheduling.
          Unfreezing allows the next schedule recalculation to move it. Unfreezing does not itself
          recalculate the schedule.
        </DialogDescription>
      </DialogHeader>

      <div className="my-4 flex items-start gap-2 rounded-lg border border-border bg-surface-sunken px-3 py-2 text-2xs text-text-muted">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <span>
          A frozen project&apos;s locked dates are not changed by this action — it only removes the
          lock for the next recalculation.
        </span>
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
        <Button type="button" size="sm" disabled={busy} onClick={() => void unfreeze()}>
          {busy ? 'Unfreezing…' : 'Unfreeze project'}
        </Button>
      </DialogFooter>
    </div>
  );
}

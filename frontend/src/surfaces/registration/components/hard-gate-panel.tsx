import * as React from 'react';
import { CircleCheck, TriangleAlert } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApiError } from '@/lib/api/client';
import { Skeleton } from '@/components/ui/skeleton';
import { SCHEDULABLE_STATUSES, type ProjectStatus } from '@/types/enums';

import { useHardGateStatus } from '../hooks/use-registration';
import type { ProjectRead } from '../api/types';

/**
 * Project Registration's "leave Draft" hard gate
 * (`GET /projects/{id}/hard-gate-status` → `HardGateStatus`,
 * `POST /projects/{id}/submit`). Only rendered for a project currently in
 * `Draft` status.
 *
 * `missing_fields` and `can_leave_draft` are read verbatim from the API —
 * this panel never recomputes either (Invariant I9's spirit: a single
 * gating decision, not two implementations that can drift).
 */
export interface HardGatePanelProps {
  project: ProjectRead;
  onSubmit: (projectId: string, targetStatus: ProjectStatus) => Promise<unknown>;
}

export function HardGatePanel({ project, onSubmit }: HardGatePanelProps): React.JSX.Element {
  const gateQuery = useHardGateStatus(project.id);
  const [targetStatus, setTargetStatus] = React.useState<ProjectStatus>('In Queue');
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  const handleSubmit = async () => {
    setSubmitError(null);
    setBusy(true);
    try {
      await onSubmit(project.id, targetStatus);
    } catch (err) {
      if (err instanceof ApiError && err.isForbidden) {
        setSubmitError('Your role cannot submit projects out of Draft.');
      } else if (err instanceof ApiError) {
        const detail = err.detail;
        setSubmitError(
          detail ?? 'This project cannot leave Draft yet — required fields are missing.',
        );
      } else {
        setSubmitError('The project could not be submitted. Please try again.');
      }
    } finally {
      setBusy(false);
    }
  };

  if (gateQuery.isPending) {
    return <Skeleton className="h-16 w-full" />;
  }

  if (gateQuery.isError) {
    return (
      <p className="text-2xs text-danger" role="alert">
        The hard-gate status could not be loaded.
      </p>
    );
  }

  const gate = gateQuery.data;

  return (
    <div className="space-y-2 rounded-lg border border-border bg-surface-sunken p-3">
      <div className="flex items-center gap-2 text-xs font-medium">
        {gate.can_leave_draft ? (
          <>
            <CircleCheck className="size-4 text-success" aria-hidden="true" />
            <span>All required fields are set — this project can leave Draft.</span>
          </>
        ) : (
          <>
            <TriangleAlert className="size-4 text-warning" aria-hidden="true" />
            <span>Required fields missing before this project can leave Draft:</span>
          </>
        )}
      </div>

      {gate.can_leave_draft ? null : (
        <ul className="ml-6 list-disc text-2xs text-text-muted">
          {gate.missing_fields.map((field) => (
            <li key={field}>{field}</li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-end gap-2 pt-1">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`target-status-${project.id}`} className="text-2xs text-text-muted">
            Target status
          </Label>
          <Select value={targetStatus} onValueChange={(v) => setTargetStatus(v as ProjectStatus)}>
            <SelectTrigger id={`target-status-${project.id}`} className="h-8 w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SCHEDULABLE_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button
          type="button"
          size="sm"
          disabled={!gate.can_leave_draft || busy}
          onClick={() => void handleSubmit()}
        >
          {busy ? 'Submitting…' : 'Submit — leave Draft'}
        </Button>
      </div>

      {submitError ? (
        <p role="alert" className="text-2xs text-danger">
          {submitError}
        </p>
      ) : null}
    </div>
  );
}

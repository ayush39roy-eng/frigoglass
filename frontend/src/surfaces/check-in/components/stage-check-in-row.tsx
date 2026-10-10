import * as React from 'react';
import { CheckCheck, CircleCheck } from 'lucide-react';

import { StepKindBadge } from '@/components/shared/step-kind-badge';
import { Badge } from '@/components/ui/badge';
import type { CheckInDueStage } from '@/lib/api/check-ins';
import { CHECKIN_NOTE_MAX, CHECKIN_REASON_MAX } from '@/lib/api/check-ins';
import { formatWeek } from '@/lib/format';
import { cn } from '@/lib/utils';
import { stageStatusLabel, WORKFLOW_STEP_STATUSES, type WorkflowStepStatus } from '@/types/enums';

import { isEdited, withStatus, type CheckInDraft, type CheckInErrors } from '../lib/check-in-draft';
import { HistoryDrawer } from './history-drawer';

export interface StageCheckInRowProps {
  projectId: string;
  projectName: string;
  stage: CheckInDueStage;
  draft: CheckInDraft;
  /** Client validation errors (shown once the user tried to submit). */
  errors: CheckInErrors;
  /** The server's per-entry error for this row, if the last submit failed on it. */
  serverError: string | null;
  disabled: boolean;
  onChange: (next: CheckInDraft) => void;
}

const INPUT =
  'h-8 rounded border border-border-strong bg-surface px-2 text-xs text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-[invalid=true]:border-danger disabled:opacity-60';

function weeks(stage: CheckInDueStage): string {
  if (stage.planned_start_week === null || stage.planned_end_week === null) return '—';
  return `${formatWeek(stage.planned_start_week)}–${formatWeek(stage.planned_end_week)}`;
}

/** "per plan X %": the served share of the planned window elapsed (ADR 0021 §5). Display only. */
function PerPlan({ stage }: { stage: CheckInDueStage }): React.JSX.Element | null {
  if (stage.plan_percent === null) return null;
  return (
    <span className="whitespace-nowrap text-2xs text-text-muted" data-testid="per-plan" title="Share of the planned window already elapsed this week. Shown for comparison, never saved.">
      per plan{' '}
      <span className="font-mono font-semibold tabular-nums text-text" data-numeric="">
        {stage.plan_percent} %
      </span>
    </span>
  );
}

function CheckInState({ stage }: { stage: CheckInDueStage }): React.JSX.Element {
  if (stage.checked_in_this_week) {
    return (
      <Badge tone="success" data-testid="checked-in-this-week">
        <CircleCheck aria-hidden="true" />
        Checked in this week
      </Badge>
    );
  }
  return (
    <span className="text-2xs text-text-muted" data-testid="last-check-in">
      Last check-in{' '}
      <span className="font-mono tabular-nums text-text" data-numeric="">
        {stage.last_checkin_week === null ? 'never' : formatWeek(stage.last_checkin_week)}
      </span>
    </span>
  );
}

/**
 * One due stage on the weekly check-in (ADR 0021 §1). Editable only when the
 * server says `can_check_in`; otherwise it reads as a locked summary. Status
 * labels follow ADR 0017 ("Blocked" is shown as "On Hold").
 */
export function StageCheckInRow({
  projectId,
  projectName,
  stage,
  draft,
  errors,
  serverError,
  disabled,
  onChange,
}: StageCheckInRowProps): React.JSX.Element {
  const idBase = React.useId();
  const edited = isEdited(draft, stage);
  const label = `${stage.step_name} (${projectName})`;

  return (
    <div
      className={cn(
        'space-y-2 border-t border-dash-hairline py-3 first:border-t-0',
        (serverError || Object.keys(errors).length > 0) && 'rounded-md bg-danger-subtle/30 px-2',
      )}
      data-testid="check-in-stage"
      data-step-id={stage.step_id}
      data-included={stage.can_check_in && (draft.confirmed || edited) ? 'true' : undefined}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h4 className="text-xs font-semibold text-text">{stage.step_name}</h4>
        <StepKindBadge kind={stage.kind} compact />
        <span className="text-2xs text-text-muted">
          Planned{' '}
          <span className="font-mono tabular-nums text-text" data-numeric="">
            {weeks(stage)}
          </span>
        </span>
        <CheckInState stage={stage} />
        <span className="ml-auto">
          <HistoryDrawer projectId={projectId} projectName={projectName} stepId={stage.step_id} stepName={stage.step_name} />
        </span>
      </div>

      {stage.can_check_in ? (
        <fieldset className="grid items-end gap-2 sm:grid-cols-[9rem_11rem_1fr_auto]" aria-label={`Check-in for ${label}`} disabled={disabled}>
          <div className="flex flex-col gap-0.5">
            <label htmlFor={`${idBase}-status`} className="text-2xs text-text-muted">
              Status
            </label>
            <select
              id={`${idBase}-status`}
              className={INPUT}
              value={draft.status}
              onChange={(e) => onChange(withStatus(draft, e.target.value as WorkflowStepStatus, stage))}
              aria-invalid={errors.status ? true : undefined}
            >
              {/* ADR 0017: the wire value stays `Blocked`; it is SHOWN as "On Hold". */}
              {WORKFLOW_STEP_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {stageStatusLabel(s)}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-0.5">
            <label htmlFor={`${idBase}-pct`} className="text-2xs text-text-muted">
              % complete
            </label>
            <div className="flex items-center gap-2">
              <input
                id={`${idBase}-pct`}
                type="number"
                min={0}
                max={100}
                inputMode="numeric"
                className={cn(INPUT, 'w-16 text-right tabular-nums')}
                value={String(draft.percent_complete)}
                onChange={(e) =>
                  onChange({ ...draft, confirmed: false, percent_complete: e.target.value === '' ? 0 : Number(e.target.value) })
                }
                aria-invalid={errors.percent_complete ? true : undefined}
                aria-describedby={stage.plan_percent !== null ? `${idBase}-plan` : undefined}
              />
              <span id={`${idBase}-plan`}>
                <PerPlan stage={stage} />
              </span>
            </div>
          </div>

          <div className="flex flex-col gap-0.5">
            <label htmlFor={`${idBase}-note`} className="text-2xs text-text-muted">
              Note <span className="text-text-subtle">(optional)</span>
            </label>
            <input
              id={`${idBase}-note`}
              type="text"
              maxLength={CHECKIN_NOTE_MAX}
              className={INPUT}
              value={draft.note}
              onChange={(e) => onChange({ ...draft, note: e.target.value })}
              aria-invalid={errors.note ? true : undefined}
            />
          </div>

          <button
            type="button"
            className={cn(
              'inline-flex h-8 items-center gap-1 whitespace-nowrap rounded-control border px-2 text-2xs font-semibold transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60',
              draft.confirmed
                ? 'border-transparent bg-success-subtle text-success-subtle-fg'
                : 'border-border-strong bg-surface text-text hover:border-primary/40 hover:text-primary',
            )}
            aria-pressed={draft.confirmed}
            aria-label={`Confirm ${stage.step_name} unchanged`}
            disabled={disabled || edited}
            title={edited ? 'You changed this stage; it will be submitted with your changes.' : 'Report this stage as unchanged this week'}
            onClick={() => onChange({ ...draft, confirmed: !draft.confirmed })}
            data-testid="confirm-unchanged"
          >
            <CheckCheck className="size-3.5" aria-hidden="true" />
            {draft.confirmed ? 'Confirmed unchanged' : 'Confirm unchanged'}
          </button>

          {draft.status === 'Blocked' ? (
            <div className="flex flex-col gap-0.5 sm:col-span-4">
              <label htmlFor={`${idBase}-reason`} className="text-2xs text-text-muted">
                Hold reason <span className="text-danger">*</span>
              </label>
              <textarea
                id={`${idBase}-reason`}
                rows={2}
                maxLength={CHECKIN_REASON_MAX}
                className={cn(INPUT, 'h-auto py-1')}
                value={draft.blocked_reason}
                onChange={(e) => onChange({ ...draft, confirmed: false, blocked_reason: e.target.value })}
                aria-invalid={errors.blocked_reason ? true : undefined}
                aria-required="true"
              />
            </div>
          ) : null}
        </fieldset>
      ) : (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-md bg-surface-sunken/70 p-2 text-2xs text-text-muted sm:grid-cols-4" data-testid="check-in-stage-readonly">
          <div>
            <dt>Status</dt>
            <dd className="font-medium text-text">{stageStatusLabel(stage.status)}</dd>
          </div>
          <div>
            <dt>Complete</dt>
            <dd className="font-mono font-medium tabular-nums text-text" data-numeric="">
              {stage.percent_complete} %
            </dd>
          </div>
          <div>
            <dt>Per plan</dt>
            <dd className="font-mono font-medium tabular-nums text-text" data-numeric="">
              {stage.plan_percent === null ? '—' : `${String(stage.plan_percent)} %`}
            </dd>
          </div>
          {stage.status === 'Blocked' ? (
            <div>
              <dt>Hold reason</dt>
              <dd className="font-medium text-text">{stage.blocked_reason ?? '—'}</dd>
            </div>
          ) : null}
        </dl>
      )}

      {stage.can_check_in && (Object.keys(errors).length > 0 || serverError) ? (
        <ul role="alert" className="space-y-0.5 text-2xs text-danger" data-testid="check-in-stage-errors">
          {Object.entries(errors).map(([field, message]) => (
            <li key={field}>{message}</li>
          ))}
          {serverError ? <li>{serverError}</li> : null}
        </ul>
      ) : null}
    </div>
  );
}

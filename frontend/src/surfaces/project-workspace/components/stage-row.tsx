import * as React from 'react';
import { Save, Undo2 } from 'lucide-react';

import { StepKindBadge } from '@/components/shared/step-kind-badge';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ApiError } from '@/lib/api/client';
import { apiErrorMessage } from '@/lib/api/error-messages';
import { HORIZON_WEEKS } from '@/lib/domain-constants';
import { formatWeek } from '@/lib/format';
import { cn } from '@/lib/utils';
import { WORKFLOW_STEP_STATUSES, type WorkflowStepStatus } from '@/types/enums';

import type { StagePatchRequest, WorkspaceStage } from '../api/types';
import { applyStatus, validateStage, type StageDraft, type StageErrors } from '../lib/stage-validation';

/**
 * One stage of the Progress panel (DOMAIN_RULES "Per-stage progress fields").
 * Editable: status, percent (slider + number), actual start/end, remaining
 * override, blocked reason. Read-only: planned weeks, kind, resource, the
 * server-derived remaining weeks, and `overrun_weeks`. Validation mirrors the
 * server's rules; the row saves with one PATCH carrying all six fields.
 * Skipped stages have no progress state of their own and show "n/a".
 */

function draftOf(stage: WorkspaceStage): StageDraft {
  return {
    status: stage.status,
    percent_complete: stage.percent_complete,
    actual_start_week: stage.actual_start_week,
    actual_end_week: stage.actual_end_week,
    remaining_weeks_override: stage.remaining_weeks_override,
    blocked_reason: stage.blocked_reason,
  };
}

function sameDraft(a: StageDraft, b: StageDraft): boolean {
  return (
    a.status === b.status &&
    a.percent_complete === b.percent_complete &&
    a.actual_start_week === b.actual_start_week &&
    a.actual_end_week === b.actual_end_week &&
    a.remaining_weeks_override === b.remaining_weeks_override &&
    (a.blocked_reason ?? '') === (b.blocked_reason ?? '')
  );
}

function numOrNull(raw: string): number | null {
  if (raw.trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function serverFieldErrors(err: unknown): string {
  if (err instanceof ApiError && err.isForbidden && !err.code) return 'Your role cannot edit progress on this project.';
  // STAGE_INCONSISTENT (with field errors) / STAGE_SKIPPED
  return apiErrorMessage(err, 'The stage could not be saved.');
}

export interface StageRowProps {
  stage: WorkspaceStage;
  canWrite: boolean;
  onSave: (stepId: string, body: StagePatchRequest) => Promise<unknown>;
}

export function StageRow({ stage, canWrite, onSave }: StageRowProps): React.JSX.Element {
  const [draft, setDraft] = React.useState<StageDraft>(() => draftOf(stage));
  const [touched, setTouched] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);

  // Adopt the server's copy after a save (or a refetch) unless mid-edit.
  const serverDraft = draftOf(stage);
  const [prevServer, setPrevServer] = React.useState(serverDraft);
  if (!sameDraft(prevServer, serverDraft)) {
    setPrevServer(serverDraft);
    if (!touched) setDraft(serverDraft);
  }

  const errors: StageErrors = validateStage(draft);
  const dirty = !sameDraft(draft, serverDraft);
  const invalid = Object.keys(errors).length > 0;
  const idBase = `stage-${stage.step_id}`;
  const label = `${stage.step_id.slice(-1)}. ${stage.name}`;

  const update = (next: StageDraft) => {
    setTouched(true);
    setDraft(next);
  };

  if (stage.skipped) {
    return (
      <li className="flex items-center gap-2 border-b border-border px-3 py-2 text-xs text-text-muted last:border-0" data-testid={`stage-${stage.step_id}`}>
        <span className="w-6 font-mono text-2xs">{stage.step_id.slice(-1)}</span>
        <StepKindBadge kind={stage.kind} compact />
        <span className="flex-1 truncate line-through decoration-border-strong">{stage.name}</span>
        <Badge tone="outline" className="border-dashed text-text-subtle" title="Not applicable — no lead time for this project's category, or a lab step without certification testing">
          n/a
        </Badge>
      </li>
    );
  }

  const planned =
    stage.planned_start_week !== null && stage.planned_end_week !== null
      ? `${formatWeek(stage.planned_start_week)}–${formatWeek(stage.planned_end_week)}`
      : 'Not scheduled';
  // A non-null engineer name is always the caller (OQ#8, P9-T03).
  const resource =
    stage.kind === 'lab'
      ? stage.assigned_chamber_code
      : stage.kind === 'design' && stage.assigned_engineer_name !== null
        ? 'Assigned to you'
        : null;

  const save = async () => {
    setServerError(null);
    setSaving(true);
    try {
      await onSave(stage.step_id, {
        status: draft.status,
        percent_complete: draft.percent_complete,
        actual_start_week: draft.actual_start_week,
        actual_end_week: draft.actual_end_week,
        remaining_weeks_override: draft.remaining_weeks_override,
        blocked_reason: draft.status === 'Blocked' ? (draft.blocked_reason ?? '').trim() : null,
      });
      setTouched(false);
    } catch (err) {
      setServerError(serverFieldErrors(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <li className="space-y-2 border-b border-border px-3 py-2.5 last:border-0" data-testid={`stage-${stage.step_id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="w-6 font-mono text-2xs text-text-muted">{stage.step_id.slice(-1)}</span>
        <StepKindBadge kind={stage.kind} compact />
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-text" title={stage.name}>
          {stage.name}
        </span>
        <span className="text-2xs text-text-muted" data-numeric="">
          Planned <span className="font-mono text-text">{planned}</span>
        </span>
        {stage.overrun_weeks !== null && stage.overrun_weeks > 0 ? (
          <Badge tone="warning" title="Running over its planned duration (from the active schedule run)" data-testid={`overrun-${stage.step_id}`}>
            +{stage.overrun_weeks} wk over
          </Badge>
        ) : null}
        {resource ? <span className="text-2xs text-text-subtle">{resource}</span> : null}
      </div>

      {canWrite ? (
        <fieldset className="grid gap-2 sm:grid-cols-[9rem_1fr_6rem_6rem_7rem]" aria-label={`Progress for ${label}`}>
          <div className="flex flex-col gap-0.5">
            <label htmlFor={`${idBase}-status`} className="text-2xs text-text-muted">
              Status
            </label>
            <Select value={draft.status} onValueChange={(v) => update(applyStatus(draft, v as WorkflowStepStatus))}>
              <SelectTrigger id={`${idBase}-status`} className="h-8 text-xs" aria-label={`Status — ${stage.name}`}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {WORKFLOW_STEP_STATUSES.map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-0.5">
            <label htmlFor={`${idBase}-pct`} className="text-2xs text-text-muted">
              Percent complete
            </label>
            <div className="flex items-center gap-2">
              <input
                type="range"
                min={0}
                max={100}
                step={5}
                value={draft.percent_complete}
                onChange={(e) => update({ ...draft, percent_complete: Number(e.target.value) })}
                aria-label={`Percent complete slider — ${stage.name}`}
                className="h-8 flex-1 accent-primary"
                disabled={draft.status === 'Not Started' || draft.status === 'Done'}
              />
              <input
                id={`${idBase}-pct`}
                type="number"
                min={0}
                max={100}
                inputMode="numeric"
                value={String(draft.percent_complete)}
                onChange={(e) => update({ ...draft, percent_complete: e.target.value === '' ? 0 : Number(e.target.value) })}
                aria-label={`Percent complete — ${stage.name}`}
                aria-invalid={errors.percent_complete ? true : undefined}
                className="h-8 w-16 rounded border border-border-strong bg-surface px-2 text-right text-xs tabular-nums text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-[invalid=true]:border-danger"
              />
            </div>
          </div>

          <WeekInput
            id={`${idBase}-start`}
            label="Actual start"
            aria={`Actual start week — ${stage.name}`}
            value={draft.actual_start_week}
            invalid={Boolean(errors.actual_start_week)}
            onChange={(v) => update({ ...draft, actual_start_week: v })}
          />
          <WeekInput
            id={`${idBase}-end`}
            label="Actual end"
            aria={`Actual end week — ${stage.name}`}
            value={draft.actual_end_week}
            invalid={Boolean(errors.actual_end_week)}
            disabled={draft.status !== 'Done'}
            onChange={(v) => update({ ...draft, actual_end_week: v })}
          />
          <div className="flex flex-col gap-0.5">
            <label htmlFor={`${idBase}-rem`} className="text-2xs text-text-muted">
              Remaining (wk)
            </label>
            <input
              id={`${idBase}-rem`}
              type="number"
              min={0}
              inputMode="numeric"
              placeholder={stage.remaining_weeks === null ? '—' : `${String(stage.remaining_weeks)} (auto)`}
              value={draft.remaining_weeks_override === null ? '' : String(draft.remaining_weeks_override)}
              onChange={(e) => update({ ...draft, remaining_weeks_override: numOrNull(e.target.value) })}
              aria-label={`Remaining weeks override — ${stage.name}`}
              aria-invalid={errors.remaining_weeks_override ? true : undefined}
              className="h-8 rounded border border-border-strong bg-surface px-2 text-right text-xs tabular-nums text-text placeholder:text-text-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-[invalid=true]:border-danger"
            />
          </div>

          {draft.status === 'Blocked' ? (
            <div className="flex flex-col gap-0.5 sm:col-span-5">
              <label htmlFor={`${idBase}-reason`} className="text-2xs text-text-muted">
                Blocked reason <span className="text-danger">*</span>
              </label>
              <textarea
                id={`${idBase}-reason`}
                rows={2}
                value={draft.blocked_reason ?? ''}
                onChange={(e) => update({ ...draft, blocked_reason: e.target.value })}
                aria-invalid={errors.blocked_reason ? true : undefined}
                className="rounded border border-border-strong bg-surface px-2 py-1 text-xs text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-[invalid=true]:border-danger"
              />
            </div>
          ) : null}
        </fieldset>
      ) : (
        // Read-only (frozen, or the caller's role lacks write) reads as visibly
        // "locked" rather than as an editable row with its inputs simply hidden:
        // a sunken tint replaces the surface background the input fields use.
        <dl
          className="grid grid-cols-2 gap-x-4 gap-y-1 rounded-md bg-surface-sunken/70 p-2 text-2xs text-text-muted sm:grid-cols-5"
          data-testid={`stage-readonly-${stage.step_id}`}
        >
          <ReadField label="Status" value={stage.status} />
          <ReadField label="Complete" value={`${String(stage.percent_complete)}%`} />
          <ReadField label="Actual" value={stage.actual_start_week === null ? '—' : `${formatWeek(stage.actual_start_week)}–${stage.actual_end_week === null ? '…' : formatWeek(stage.actual_end_week)}`} />
          <ReadField label="Remaining" value={stage.remaining_weeks === null ? '—' : `${String(stage.remaining_weeks)} wk${stage.remaining_weeks_override === null ? '' : ' (override)'}`} />
          {stage.status === 'Blocked' ? <ReadField label="Blocked" value={stage.blocked_reason ?? '—'} /> : null}
        </dl>
      )}

      {canWrite && touched && invalid ? (
        <ul role="alert" className="space-y-0.5 text-2xs text-danger" data-testid={`stage-errors-${stage.step_id}`}>
          {Object.entries(errors).map(([field, message]) => (
            <li key={field}>{message}</li>
          ))}
        </ul>
      ) : null}
      {serverError ? (
        <p role="alert" className="text-2xs text-danger">
          {serverError}
        </p>
      ) : null}
      {canWrite && dirty ? (
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setDraft(serverDraft);
              setTouched(false);
              setServerError(null);
            }}
          >
            <Undo2 />
            Reset
          </Button>
          <Button type="button" size="sm" disabled={invalid || saving} onClick={() => void save()} aria-label={`Save progress — ${stage.name}`}>
            <Save />
            {saving ? 'Saving…' : 'Save stage'}
          </Button>
        </div>
      ) : null}
    </li>
  );
}

function WeekInput({
  id,
  label,
  aria,
  value,
  invalid,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  aria: string;
  value: number | null;
  invalid: boolean;
  disabled?: boolean;
  onChange: (v: number | null) => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-0.5">
      <label htmlFor={id} className="text-2xs text-text-muted">
        {label}
      </label>
      <input
        id={id}
        type="number"
        min={1}
        max={HORIZON_WEEKS}
        inputMode="numeric"
        placeholder="W"
        value={value === null ? '' : String(value)}
        disabled={disabled}
        onChange={(e) => onChange(numOrNull(e.target.value))}
        aria-label={aria}
        aria-invalid={invalid ? true : undefined}
        className={cn(
          'h-8 rounded border border-border-strong bg-surface px-2 text-right text-xs tabular-nums text-text placeholder:text-text-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
          'aria-[invalid=true]:border-danger',
        )}
      />
    </div>
  );
}

function ReadField({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div>
      <dt className="text-text-subtle">{label}</dt>
      <dd className="text-text">{value}</dd>
    </div>
  );
}

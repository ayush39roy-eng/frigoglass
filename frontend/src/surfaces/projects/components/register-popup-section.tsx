import * as React from 'react';
import { Lock, RotateCw, TriangleAlert } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { ProjectStatusBadge } from '@/components/shared/project-status-badge';
import type { Hub } from '@/lib/api/reference';
import { formatPlanWeek } from '@/lib/format';
import { hubPickerLabel } from '@/lib/hub-labels';
import { cn } from '@/lib/utils';
import { UI_PROJECT_STATUSES, type ProjectStatus } from '@/types/enums';

import { useEngineerOptions } from '@/surfaces/registration/hooks/use-registration';

import type { RegisterEditError, RegisterStepsResponse } from '../api/register-edits';
import { groupPopupErrors, type PopupErrorTarget } from '../lib/popup-errors';
import { endBeforeStart } from '../lib/register-edit';
import {
  currentStepMove,
  currentStepOptions,
  dropExclusions,
  normaliseDraft,
  popupFieldChanged,
  popupValues,
  FROZEN_LOCK,
  servedLockReason,
  setPopupField,
  toggleExclusion,
  type PopupBase,
  type PopupDraft,
  type PopupScalarField,
  type PopupScalars,
} from '../lib/register-popup';
import { CHANGED, EffortInput, NativeSelect, WeekDateInput } from './register-edit-cells';
import { StepChips, type StepChipState } from './step-chips';

/**
 * Register popup (owner 2026-11-17): the list attributes of one project —
 * status, hub, leader, actual start / end, design / lab time, needs lab
 * testing, current step and the step chips — next to the registration's
 * identity fields in the row's "Edit" popup. End wk (the scheduler's forecast)
 * is read-only. Controlled: the popup owns the draft and saves it in ONE
 * `POST /projects/register-edits` patch.
 */

export const STEPS_NOTE_ID = 'reg-steps-note';

export interface RegisterStepsState {
  data: RegisterStepsResponse | undefined;
  isPending: boolean;
  isError: boolean;
  refetch: () => void;
}

export function RegisterPopupSection({
  base,
  draft,
  onDraft,
  steps,
  hubs,
  calculated,
  endWeek,
  errors,
  projectLock = null,
}: {
  base: PopupBase;
  draft: PopupDraft;
  onDraft: (next: PopupDraft) => void;
  steps: RegisterStepsState;
  /** The hubs the caller may pick (in scope); the served hub is always kept. */
  hubs: readonly Hub[];
  /** The served calculated design / lab weeks (null when not at hand). */
  calculated: { design: number | null; lab: number | null };
  /** The served forecast finish (read-only). */
  endWeek: number | null;
  errors: readonly RegisterEditError[];
  /** The served project's lock on its steps (frozen / closed), or null. */
  projectLock?: string | null;
}): React.JSX.Element {
  const values = popupValues(base, draft);
  const changed = (f: PopupScalarField): boolean => popupFieldChanged(base, draft, f);
  const exclusionsChanged = normaliseDraft(base, draft).excluded !== undefined;
  const { byTarget, general } = groupPopupErrors(errors, {
    exclusionsChanged,
    currentChanged: changed('current_step_code'),
  });
  const set = <F extends PopupScalarField>(field: F, value: PopupScalars[F]): void =>
    onDraft(setPopupField(base, draft, field, value));

  const servedHub = hubs.find((h) => h.id === base.hub_id);
  const pickedHub = hubs.find((h) => h.id === values.hub_id);
  // A hub of the other workflow re-points the project's steps on Save: the
  // served chips no longer describe it, so they wait for the save.
  const workflowChanges =
    servedHub !== undefined && pickedHub !== undefined && servedHub.is_oem !== pickedHub.is_oem;
  const labFlagChanged = changed('certification_testing_required');
  const isDraftStatus = base.status === 'Draft';

  const stepList = steps.data?.steps ?? [];
  const labCodes = stepList.filter((s) => s.kind === 'lab').map((s) => s.step_code);

  const onHub = (next: string): void => {
    let d = setPopupField(base, draft, 'hub_id', next);
    const nextHub = hubs.find((h) => h.id === next);
    if (servedHub && nextHub && servedHub.is_oem !== nextHub.is_oem) {
      // Step edits belong to the served workflow: drop them.
      d = dropExclusions(base, d, stepList.map((s) => s.step_code));
      d = setPopupField(base, d, 'current_step_code', base.current_step_code);
    }
    onDraft(d);
  };
  const onLabFlag = (on: boolean): void => {
    let d = setPopupField(base, draft, 'certification_testing_required', on);
    d = dropExclusions(base, d, labCodes);
    onDraft(d);
  };

  const engineers = useEngineerOptions(values.hub_id || undefined);
  const leaderList = engineers.data ?? [];
  const servedLeaderMissing =
    base.leader_engineer_id !== null && !leaderList.some((e) => e.id === base.leader_engineer_id);

  const statusOptions: ProjectStatus[] = UI_PROJECT_STATUSES.includes(base.status)
    ? [...UI_PROJECT_STATUSES]
    : [base.status, ...UI_PROJECT_STATUSES];

  const servedHubMissing = !hubs.some((h) => h.id === base.hub_id);

  const options = currentStepOptions(stepList, values);
  const move = currentStepMove(stepList, base.current_step_code, values.current_step_code);
  const currentValueListed = values.current_step_code !== null && options.some((s) => s.step_code === values.current_step_code);
  const stepsLocked = workflowChanges ? 'the new hub uses another workflow' : null;

  const stepsError = byTarget.steps !== undefined;
  const chips: StepChipState[] = stepList.map((step) => {
    const servedExcluded = base.excluded[step.step_code] ?? false;
    const excluded = values.excluded[step.step_code] ?? false;
    let lockedReason = servedLockReason(step, servedExcluded, projectLock);
    if (lockedReason === null && stepsLocked) lockedReason = stepsLocked;
    if (lockedReason === null && labFlagChanged && step.kind === 'lab') lockedReason = 'lab testing change not saved yet';
    return {
      step,
      excluded,
      changed: excluded !== servedExcluded,
      current: values.current_step_code === step.step_code,
      lockedReason,
      // The error row names no step: mark the chips this Save changed.
      invalid: stepsError && excluded !== servedExcluded,
    };
  });

  const errId = (t: PopupErrorTarget): string => `reg-popup-err-${t}`;
  const errorText = (t: PopupErrorTarget): string | null => {
    const list = byTarget[t];
    return list && list.length > 0 ? list.join(' ') : null;
  };
  const describe = (t: PopupErrorTarget): string | undefined => (errorText(t) ? errId(t) : undefined);

  return (
    <fieldset className="space-y-3 border-t border-border pt-5" data-testid="register-popup-section">
      <legend className="text-2xs font-semibold uppercase tracking-wide text-text-muted">Status and progress</legend>
      <p className="text-2xs text-text-muted">
        The register&apos;s fields. Saved together in one change, which recalculates the timeline once.
      </p>
      {general.length > 0 ? (
        <ul role="alert" className="space-y-0.5 rounded-md border border-danger/40 bg-danger-subtle/50 px-3 py-2 text-2xs font-semibold text-danger" data-testid="register-popup-general-errors">
          {general.map((t) => (
            <li key={t} className="flex items-start gap-1">
              <TriangleAlert className="mt-px size-3 shrink-0" aria-hidden="true" />
              {t}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-2">
        <PopupField label="Status" htmlFor="reg-popup-status" error={errorText('status')} errorId={errId('status')} changed={changed('status')}>
          {isDraftStatus ? (
            <span className="flex flex-col gap-1">
              <ProjectStatusBadge status={base.status} />
              <span className="text-2xs text-text-subtle">A Draft leaves Draft through Submit (above).</span>
            </span>
          ) : (
            <NativeSelect
              id="reg-popup-status"
              wrapperClassName="h-8"
              className="h-8 text-sm"
              value={values.status}
              aria-invalid={errorText('status') ? true : undefined}
              aria-describedby={describe('status')}
              onChange={(e) => set('status', e.currentTarget.value as ProjectStatus)}
            >
              {statusOptions.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </NativeSelect>
          )}
        </PopupField>

        <PopupField label="Hub" htmlFor="reg-popup-hub" error={errorText('hub_id')} errorId={errId('hub_id')} changed={changed('hub_id')}
          hint={workflowChanges ? 'This hub uses the other workflow: the steps change on Save.' : undefined}
        >
          <NativeSelect
            id="reg-popup-hub"
            wrapperClassName="h-8"
            className="h-8 text-sm"
            value={values.hub_id}
            aria-invalid={errorText('hub_id') ? true : undefined}
            aria-describedby={describe('hub_id')}
            onChange={(e) => onHub(e.currentTarget.value)}
          >
            {servedHubMissing ? <option value={base.hub_id}>Current hub</option> : null}
            {hubs.map((h) => (
              <option key={h.id} value={h.id}>
                {hubPickerLabel(h, hubs)}
              </option>
            ))}
          </NativeSelect>
        </PopupField>

        <PopupField label="Leader" htmlFor="reg-popup-leader" error={errorText('leader_engineer_id')} errorId={errId('leader_engineer_id')} changed={changed('leader_engineer_id')}>
          <NativeSelect
            id="reg-popup-leader"
            wrapperClassName="h-8"
            className="h-8 text-sm"
            value={values.leader_engineer_id ?? ''}
            aria-busy={engineers.isPending && values.hub_id ? true : undefined}
            aria-invalid={errorText('leader_engineer_id') ? true : undefined}
            aria-describedby={describe('leader_engineer_id')}
            onChange={(e) => set('leader_engineer_id', e.currentTarget.value === '' ? null : e.currentTarget.value)}
          >
            <option value="">Unassigned</option>
            {servedLeaderMissing && base.leader_engineer_id !== null ? (
              <option value={base.leader_engineer_id}>Current leader</option>
            ) : null}
            {leaderList.map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </NativeSelect>
        </PopupField>

        <PopupField label="End wk (forecast)" htmlFor="reg-popup-end-week" readOnly>
          <span
            id="reg-popup-end-week"
            className="flex h-8 items-center gap-1.5 rounded border border-dashed border-border bg-surface-sunken/60 px-2.5 text-sm font-semibold tabular-nums text-text"
            data-numeric=""
            data-testid="popup-end-week"
            title="Set by the scheduler; read-only"
          >
            <Lock className="size-3 text-text-subtle" aria-hidden="true" />
            {endWeek === null ? '—' : formatPlanWeek(endWeek)}
            <span className="sr-only"> (read-only, set by the scheduler)</span>
          </span>
        </PopupField>

        <PopupField label="Actual start" htmlFor="reg-popup-actual-start" changed={changed('actual_start_week')} error={errorText('actual_start_week')} errorId={errId('actual_start_week')}>
          <WeekDateInput
            id="reg-popup-actual-start"
            week={values.actual_start_week}
            changed={false}
            label="Actual start"
            warning={null}
            invalid={errorText('actual_start_week') !== null}
            onChange={(next) => set('actual_start_week', next)}
          />
        </PopupField>

        <PopupField label="Actual end" htmlFor="reg-popup-actual-end" changed={changed('actual_end_week')} error={errorText('actual_end_week')} errorId={errId('actual_end_week')}>
          <WeekDateInput
            id="reg-popup-actual-end"
            week={values.actual_end_week}
            changed={false}
            label="Actual end"
            warning={endBeforeStart(values) ? 'End is before start' : null}
            invalid={errorText('actual_end_week') !== null}
            onChange={(next) => set('actual_end_week', next)}
          />
        </PopupField>

        <PopupField label="Design time" htmlFor="reg-popup-design-time" changed={changed('design_effort_weeks')} error={errorText('design_effort_weeks')} errorId={errId('design_effort_weeks')}
          hint="Green: calculated. Orange: typed by hand (↺ reset clears it)."
        >
          <EffortInput
            id="reg-popup-design-time"
            inputClassName="h-8 w-24 text-sm"
            figure={values.design_effort_weeks}
            calculated={calculated.design}
            changed={false}
            label="Design time"
            invalid={errorText('design_effort_weeks') !== null}
            describedBy={describe('design_effort_weeks')}
            onChange={(next) => set('design_effort_weeks', next)}
          />
        </PopupField>

        <PopupField label="Lab time" htmlFor="reg-popup-lab-time" changed={changed('lab_effort_weeks')} error={errorText('lab_effort_weeks')} errorId={errId('lab_effort_weeks')}>
          <EffortInput
            id="reg-popup-lab-time"
            inputClassName="h-8 w-24 text-sm"
            figure={values.lab_effort_weeks}
            calculated={calculated.lab}
            changed={false}
            label="Lab time"
            invalid={errorText('lab_effort_weeks') !== null}
            describedBy={describe('lab_effort_weeks')}
            onChange={(next) => set('lab_effort_weeks', next)}
          />
        </PopupField>

        <div className={cn('flex flex-col gap-1 p-0.5', changed('certification_testing_required') && CHANGED)}>
          <span className="block h-4" aria-hidden="true" />
          <label className="flex h-8 w-fit cursor-pointer items-center gap-2 rounded px-1 text-xs text-text hover:bg-primary-subtle/30">
            <Checkbox
              checked={values.certification_testing_required}
              onCheckedChange={(next) => onLabFlag(next === true)}
              aria-describedby="reg-popup-lab-hint"
              data-testid="popup-lab-testing"
            />
            Needs lab testing
          </label>
          <span id="reg-popup-lab-hint" className="pl-7 text-2xs text-text-subtle">
            Certification testing. Lab steps are skipped when off.
          </span>
        </div>

        <PopupField label="Current step" htmlFor="reg-popup-current-step" changed={changed('current_step_code')} error={errorText('current_step_code')} errorId={errId('current_step_code')}
          hint={move !== null ? (
            <span className="font-semibold text-warning-subtle-fg" data-testid="current-step-note" role="status">
              {move === 'forward'
                ? 'Earlier steps will be marked Done.'
                : 'Earlier steps will be marked Done; later steps go back to Not Started.'}
            </span>
          ) : undefined}
        >
          {steps.isPending ? (
            <Skeleton className="h-8 w-full" />
          ) : steps.isError || !steps.data ? (
            <span className="text-2xs text-text-muted">Not available.</span>
          ) : (
            <NativeSelect
              id="reg-popup-current-step"
              wrapperClassName="h-8"
              className="h-8 text-sm"
              value={currentValueListed ? (values.current_step_code ?? '') : ''}
              // A frozen project's progress cannot change (contract §2.2, PROJECT_FROZEN).
              disabled={stepsLocked !== null || options.length === 0 || projectLock === FROZEN_LOCK}
              aria-invalid={errorText('current_step_code') ? true : undefined}
              aria-describedby={describe('current_step_code')}
              onChange={(e) => {
                if (e.currentTarget.value !== '') set('current_step_code', e.currentTarget.value);
              }}
            >
              {currentValueListed ? null : (
                <option value="">{values.current_step_code === null ? 'All steps done' : 'Set by the server'}</option>
              )}
              {options.map((s) => (
                <option key={s.step_code} value={s.step_code}>
                  {`${s.step_code} · ${s.step_name}`}
                </option>
              ))}
            </NativeSelect>
          )}
        </PopupField>
      </div>

      <div role="group" aria-labelledby="reg-steps-legend" className="space-y-2">
        <p id="reg-steps-legend" className="text-xs font-medium text-text">
          Steps (click to exclude)
        </p>
        <p id={STEPS_NOTE_ID} className="text-2xs text-text-subtle">
          <span className="font-semibold text-dashChartInk-7">Indigo</span> = design step,{' '}
          <span className="font-semibold text-success-subtle-fg">green</span> = lab step. N/A and Done steps cannot be
          excluded; the current step is ringed. N/A marks are the saved state: a changed time or lab testing is re-checked on Save.
          {stepsLocked ? ' The new hub uses another workflow: save the hub first, then edit its steps.' : ''}
          {projectLock === FROZEN_LOCK
            ? ' The project is frozen: its steps cannot change.'
            : projectLock !== null
              ? ' The project is Cancelled or Commercialized: its steps cannot change.'
              : ''}
        </p>
        {errorText('steps') ? (
          <p id={errId('steps')} role="alert" className="flex items-start gap-1 text-2xs font-semibold text-danger" data-testid="steps-error">
            <TriangleAlert className="mt-px size-3 shrink-0" aria-hidden="true" />
            {errorText('steps')}
          </p>
        ) : null}
        {steps.isPending ? (
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-4" aria-busy="true">
            {Array.from({ length: 8 }, (_, i) => (
              <Skeleton key={i} className="h-12" />
            ))}
          </div>
        ) : steps.isError || !steps.data ? (
          <p className="flex items-center gap-2 text-2xs text-text-muted" data-testid="steps-unavailable">
            The steps could not be loaded.
            <Button type="button" variant="ghost" size="sm" onClick={steps.refetch}>
              <RotateCw aria-hidden="true" />
              Retry
            </Button>
          </p>
        ) : (
          <StepChips
            chips={chips}
            onToggle={(code) => onDraft(toggleExclusion(base, draft, code))}
            describedBy={[STEPS_NOTE_ID, describe('steps')].filter(Boolean).join(' ')}
            invalid={errorText('steps') !== null}
          />
        )}
      </div>
    </fieldset>
  );
}

function PopupField({
  label,
  htmlFor,
  error = null,
  errorId,
  hint,
  changed = false,
  readOnly = false,
  children,
}: {
  label: string;
  htmlFor: string;
  error?: string | null;
  errorId?: string;
  hint?: React.ReactNode;
  changed?: boolean;
  readOnly?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className={cn('flex min-w-0 flex-col gap-1 p-0.5', changed && CHANGED)} data-changed={changed ? 'true' : undefined}>
      {readOnly ? (
        <span id={`${htmlFor}-label`} className="text-xs font-medium text-text">
          {label}
        </span>
      ) : (
        <Label htmlFor={htmlFor} className="text-xs">
          {label}
        </Label>
      )}
      {children}
      {error ? (
        <span id={errorId} role="alert" className="text-2xs font-semibold text-danger">
          {error}
        </span>
      ) : hint ? (
        <span className="text-2xs text-text-subtle">{hint}</span>
      ) : null}
    </div>
  );
}

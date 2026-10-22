import * as React from 'react';
import { useForm, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { RotateCcw } from 'lucide-react';

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
import { formatPlanWeek } from '@/lib/format';
import { DISPLAY_HORIZON_WEEKS } from '@/lib/domain-constants';

import type { StepTimingRequest } from '../../api/types';
import { DURATION_OVERRIDE_MAX_WEEKS } from '../../lib/gantt-coordinates';
import { calendarRangePhrase, WORK_WEEKS_HELP, workWeeksPhrase } from '../../lib/step-weeks-copy';
import type { StepTimingTarget } from './step-timing-context';
import { stepTimingFormSchema, type StepTimingFormInput, type StepTimingFormValues } from './step-timing-schema';
import { TIMING_COPY } from './timing-copy';

/**
 * "Edit timing": the keyboard alternative to dragging a step bar (ADR 0019 §3).
 * Duration sets `duration_override_weeks`, earliest start sets
 * `start_not_before_week`, "Reset timing" sends both as `null`. Only changed
 * fields are sent (an absent field is left as it is). A started step
 * (`timing_editable === "resize"`) offers the duration only.
 *
 * P20 (ADR 0032): the duration typed here is WORK weeks for every kind. For a
 * design step it is labelled "Work (weeks)" and the hint shows the served bar
 * as calendar weeks next to the served work weeks, because a leader below
 * 1.0 FTE stretches the one into more of the other. Nothing is converted
 * here: the value is sent as typed.
 */
export function StepTimingDialog({
  target,
  busy,
  onOpenChange,
  onSubmit,
}: {
  target: StepTimingTarget | null;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (target: StepTimingTarget, body: StepTimingRequest) => void;
}): React.JSX.Element {
  return (
    <Dialog open={target !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md" data-testid="step-timing-dialog">
        {target ? (
          <TimingForm
            key={`${target.projectId}:${target.stepId}`}
            target={target}
            busy={busy}
            onCancel={() => onOpenChange(false)}
            onSubmit={onSubmit}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function currentDuration(target: StepTimingTarget): number {
  return target.durationOverrideWeeks ?? target.durationWeeks ?? target.leadTimeWeeks;
}

function TimingForm({
  target,
  busy,
  onCancel,
  onSubmit,
}: {
  target: StepTimingTarget;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (target: StepTimingTarget, body: StepTimingRequest) => void;
}): React.JSX.Element {
  const ids = { duration: React.useId(), start: React.useId() };
  const canMove = target.timingEditable === 'move_resize';
  const isDesign = target.kind === 'design';
  const plannedNow =
    target.plannedStartWeek !== null && target.plannedEndWeek !== null && target.durationWeeks !== null
      ? `Planned now: ${calendarRangePhrase(target.plannedStartWeek, target.plannedEndWeek)} · ${workWeeksPhrase(target.kind, target.durationWeeks, target.spanFte)}.`
      : null;
  // P30 (ADR 0041 R4): only the user's two fields count; Reset restores the
  // client effort value (or the table when the project has none).
  const hasEdit = target.durationOverrideWeeks !== null || target.startNotBeforeWeek !== null;
  const resetTo =
    target.effortWeeks !== null
      ? `the client effort figure (${String(target.effortWeeks)} wks)`
      : `the lead-time table (${String(target.leadTimeWeeks)} wks)`;
  const [nothingChanged, setNothingChanged] = React.useState(false);
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<StepTimingFormInput, unknown, StepTimingFormValues>({
    // @hookform/resolvers v3 types the resolver's output as its input; at
    // runtime it returns the parsed (transformed) values, which this states.
    resolver: zodResolver(stepTimingFormSchema) as unknown as Resolver<StepTimingFormInput, unknown, StepTimingFormValues>,
    mode: 'onChange',
    defaultValues: {
      durationWeeks: currentDuration(target),
      startNotBeforeWeek: target.startNotBeforeWeek === null ? '' : String(target.startNotBeforeWeek),
    },
  });

  const submit = handleSubmit((values) => {
    const body: StepTimingRequest = {};
    if (values.durationWeeks !== currentDuration(target)) body.duration_override_weeks = values.durationWeeks;
    if (canMove && values.startNotBeforeWeek !== target.startNotBeforeWeek) {
      body.start_not_before_week = values.startNotBeforeWeek;
    }
    if (Object.keys(body).length === 0) {
      setNothingChanged(true);
      return;
    }
    onSubmit(target, body);
  });

  const reset = () => onSubmit(target, { duration_override_weeks: null, start_not_before_week: null });

  return (
    <form onSubmit={(e) => void submit(e)} noValidate onChange={() => setNothingChanged(false)}>
      <DialogHeader>
        <DialogTitle>Edit timing — {target.stepName}</DialogTitle>
        <DialogDescription>
          {target.projectName}. Saving recalculates the timeline. {canMove ? TIMING_COPY.floorNote : TIMING_COPY.startedNote}
        </DialogDescription>
      </DialogHeader>

      <div className="my-4 grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor={ids.duration} className="text-xs">
            {isDesign ? 'Work (weeks)' : 'Duration (weeks)'}
          </Label>
          <Input
            id={ids.duration}
            type="number"
            min={1}
            max={DURATION_OVERRIDE_MAX_WEEKS}
            step={1}
            inputMode="numeric"
            className="h-8 w-24 tnum"
            aria-invalid={errors.durationWeeks ? true : undefined}
            aria-describedby={`${ids.duration}-hint`}
            {...register('durationWeeks')}
          />
          {errors.durationWeeks ? (
            <p id={`${ids.duration}-hint`} role="alert" className="text-2xs text-danger">
              {errors.durationWeeks.message}
            </p>
          ) : (
            <p id={`${ids.duration}-hint`} className="text-2xs text-text-muted" data-numeric="">
              Lead-time table: {target.leadTimeWeeks} wks{isDesign ? ' of work' : ''}
              {target.effortWeeks !== null ? ` · client effort ${String(target.effortWeeks)}` : ''}
              {target.durationOverrideWeeks !== null ? ` · overridden to ${String(target.durationOverrideWeeks)}` : ''}
            </p>
          )}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor={ids.start} className="text-xs">
            Earliest start week
          </Label>
          <Input
            id={ids.start}
            type="number"
            min={1}
            max={DISPLAY_HORIZON_WEEKS}
            step={1}
            inputMode="numeric"
            placeholder="None"
            disabled={!canMove}
            className="h-8 w-24 tnum"
            aria-invalid={errors.startNotBeforeWeek ? true : undefined}
            aria-describedby={`${ids.start}-hint`}
            {...register('startNotBeforeWeek')}
          />
          {errors.startNotBeforeWeek ? (
            <p id={`${ids.start}-hint`} role="alert" className="text-2xs text-danger">
              {errors.startNotBeforeWeek.message}
            </p>
          ) : (
            <p id={`${ids.start}-hint`} className="text-2xs text-text-muted" data-numeric="">
              {canMove
                ? `Blank = no floor. Planned now: ${target.plannedStartWeek === null ? '—' : formatPlanWeek(target.plannedStartWeek)}.`
                : 'Fixed: the step has started.'}
            </p>
          )}
        </div>
      </div>

      <div className="mb-3 space-y-1 text-2xs text-text-muted" data-testid="step-timing-weeks-note">
        {plannedNow ? <p data-numeric="">{plannedNow}</p> : null}
        <p>{isDesign ? WORK_WEEKS_HELP : 'Lab and elapsed steps are not stretched by FTE: their weeks of work and calendar weeks are the same.'}</p>
      </div>

      {nothingChanged ? (
        <p role="status" className="mb-2 text-2xs text-text-muted">
          Nothing changed — edit a value, or press Cancel.
        </p>
      ) : null}

      <DialogFooter className="gap-2 sm:justify-between">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={reset}
          disabled={busy || !hasEdit}
          title={`Clear your timing edit: the step goes back to ${resetTo}`}
          data-testid="step-timing-reset"
        >
          <RotateCcw />
          Reset timing
        </Button>
        <span className="flex gap-2">
          <Button type="button" variant="secondary" size="sm" onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={busy}>
            Save timing
          </Button>
        </span>
      </DialogFooter>
    </form>
  );
}

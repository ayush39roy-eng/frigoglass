import * as React from 'react';
import { X } from 'lucide-react';

import { WITHIN_YEAR_WEEK } from '@/lib/domain-constants';
import { usePlanYearLabels } from '@/lib/plan-clock';
import { cn } from '@/lib/utils';

import { PIN_BLOCK_REASON_COPY } from '../api/step-pins-api';
import type { GanttProjectRow, GanttStepRow } from '../api/types';
import { useStepPinEdit } from '../hooks/use-step-pin-edit';
import { pinDraftProblem, pinKey, pinRunState, shownPair } from '../lib/step-pin-drafts';

/** Width the pin inputs add to the Timeline's name column, px. */
export const STEP_PIN_CELL_WIDTH = 96;

const INPUT_CLASS = cn(
  'h-5 w-9 shrink-0 rounded-[4px] border bg-surface px-1 text-center text-[0.6875rem] tabular-nums text-text',
  'placeholder:text-text-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
  '[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none',
);

/**
 * P40-T03c (ADR 0054 R40-2, R40-13; the old tool's two small S / E boxes per
 * step row, `Charter.jsx` ~1320): one step's manual Start / End weeks, ends
 * inclusive.
 *
 * - Editable only when the server says so (`pin_editable`); otherwise
 *   read-only, with the served `pin_block_reason` as the tooltip.
 * - Typing a Start moves the End to `Start + current_length_weeks − 1`;
 *   typing an End keeps the Start. Neighbouring steps never change.
 * - The inputs show the draft, else the LIVE pin, else nothing (the served
 *   planned weeks are the placeholder).
 * - "Pin applies on the next run" / "Lapsed: placed from W{n}" from the
 *   step's served weeks and its own `pin_lapsed` (`pinRunState`).
 * - Red (`aria-invalid`, error text linked by `aria-describedby`) for End <
 *   Start, a week outside current week..W52, or a refusal from the last Save.
 * - Clear (send nulls) only where the server serves `pin_clearable`.
 *
 * Renders nothing outside the Timeline (no `StepPinEditProvider`).
 */
export function StepPinCell({ project, step }: { project: GanttProjectRow; step: GanttStepRow }): React.JSX.Element | null {
  const edit = useStepPinEdit();
  const baseId = React.useId();
  const years = usePlanYearLabels();
  if (!edit) return null;

  const key = pinKey(project.project_id, step.step_id);
  const draft = edit.drafts.get(key);
  const pair = shownPair(step, draft);
  const problem = draft ? pinDraftProblem(pair, edit.minWeek, edit.maxWeek) : null;
  const serverError = edit.serverErrors.get(key) ?? null;
  const message = problem?.message ?? serverError;
  const startInvalid = problem ? problem.start : serverError !== null;
  const endInvalid = problem ? problem.end : serverError !== null;

  const editable = step.pin_editable && !edit.locked;
  const reason = step.pin_editable ? null : step.pin_block_reason ? PIN_BLOCK_REASON_COPY[step.pin_block_reason] : null;
  // Clear (R40-2, contract §2 P40-R02): only the served `pin_clearable`
  // (the save's own Clear rules: role, hub scope, live row, not frozen) says
  // whether the caller may clear; the browser adds only "there is something
  // to clear".
  const canClear = step.pin_clearable && !edit.locked && (pair.start !== '' || pair.end !== '');

  const errorId = `${baseId}-error`;
  const reasonId = `${baseId}-reason`;
  const describedBy = [message ? errorId : null, reason ? reasonId : null].filter(Boolean).join(' ') || undefined;
  const willClear = draft !== undefined && pair.start === '' && pair.end === '';
  // R40-13: while the saved pin differs from the run's bar, say so.
  const runState = draft === undefined ? pinRunState(step) : null;

  const inputProps = (which: 'start' | 'end') => {
    const invalid = which === 'start' ? startInvalid : endInvalid;
    const placeholderWeek = which === 'start' ? step.planned_start_week : step.planned_end_week;
    return {
      type: 'number' as const,
      inputMode: 'numeric' as const,
      min: edit.minWeek,
      max: edit.maxWeek,
      step: 1,
      readOnly: !editable,
      'aria-readonly': !editable || undefined,
      'aria-invalid': invalid || undefined,
      'aria-describedby': describedBy,
      // ADR 0024: no surface shows a week past W52. A planned week in the
      // next year shows as that year's week (plan week 53 → 1, owner
      // 2026-11-18); the tooltip names the year.
      placeholder:
        placeholderWeek == null
          ? which === 'start' ? 'S' : 'E'
          : String(placeholderWeek > WITHIN_YEAR_WEEK ? placeholderWeek - WITHIN_YEAR_WEEK : placeholderWeek),
      title:
        reason ??
        `${which === 'start' ? 'Start week (inclusive)' : 'End week (inclusive)'}${
          placeholderWeek != null && placeholderWeek > WITHIN_YEAR_WEEK
            ? ` — week ${String(placeholderWeek - WITHIN_YEAR_WEEK)} of ${years.spilloverYear} (spillover)`
            : ''
        }`,
      className: cn(
        INPUT_CLASS,
        invalid ? 'border-2 border-danger' : 'border-border',
        !editable && 'cursor-not-allowed bg-surface-sunken text-text-muted',
        draft !== undefined && !invalid && 'border-warning',
      ),
      'data-testid': `step-pin-${which}`,
    };
  };

  return (
    <div
      className="relative flex shrink-0 items-center gap-0.5"
      data-testid="step-pin-cell"
      data-step={step.step_id}
      data-draft={draft !== undefined || undefined}
      data-editable={step.pin_editable || undefined}
    >
      <input
        {...inputProps('start')}
        aria-label={`Start week, ${step.step_name}`}
        value={pair.start}
        onChange={(e) => edit.setStart(project, step, e.target.value)}
      />
      <input
        {...inputProps('end')}
        aria-label={`End week, ${step.step_name}`}
        value={pair.end}
        onChange={(e) => edit.setEnd(project, step, e.target.value)}
      />
      {canClear ? (
        <button
          type="button"
          className="grid size-4 shrink-0 place-items-center rounded-sm text-text-muted hover:bg-surface-raised hover:text-danger focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Clear weeks, ${step.step_name}`}
          title="Clear the typed weeks (the scheduler places the step again)"
          onClick={() => edit.clear(project, step)}
          data-testid="step-pin-clear"
        >
          <X className="size-3" aria-hidden="true" />
        </button>
      ) : (
        <span className="size-4 shrink-0" aria-hidden="true" />
      )}
      {reason ? (
        <span id={reasonId} className="sr-only">
          {reason}
        </span>
      ) : null}
      {message ? (
        <span
          id={errorId}
          className="absolute left-full top-1/2 z-20 ml-1 -translate-y-1/2 whitespace-nowrap rounded-sm border border-danger/60 bg-surface px-1.5 text-[0.625rem] font-semibold leading-4 text-danger shadow-sm"
          data-testid="step-pin-error"
        >
          {message}
        </span>
      ) : willClear ? (
        <span
          className="absolute left-full top-1/2 z-20 ml-1 -translate-y-1/2 whitespace-nowrap rounded-sm border border-dashed border-warning/60 bg-surface px-1.5 text-[0.625rem] font-semibold leading-4 text-warning-subtle-fg"
          data-testid="step-pin-will-clear"
        >
          Cleared on save
        </span>
      ) : runState === 'pending' ? (
        <span
          className="absolute left-full top-1/2 z-20 ml-1 -translate-y-1/2 whitespace-nowrap rounded-sm border border-dashed border-primary/50 bg-surface px-1.5 text-[0.625rem] font-semibold leading-4 text-primary-subtle-fg"
          data-testid="step-pin-next-run"
        >
          Pin applies on the next run
        </span>
      ) : runState === 'lapsed' && step.planned_start_week != null ? (
        <span
          className="absolute left-full top-1/2 z-20 ml-1 -translate-y-1/2 whitespace-nowrap rounded-sm border border-dashed border-warning/60 bg-surface px-1.5 text-[0.625rem] font-semibold leading-4 text-warning-subtle-fg"
          title="The typed start week had passed, so the run placed the step from its own week, keeping the length."
          data-testid="step-pin-lapsed"
        >
          Lapsed: placed from W{step.planned_start_week}
        </span>
      ) : null}
    </div>
  );
}

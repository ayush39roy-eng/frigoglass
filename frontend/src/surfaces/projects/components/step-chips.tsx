import * as React from 'react';
import { Check } from 'lucide-react';

import { cn } from '@/lib/utils';
import { WORKFLOW_STEP_STATUS_LABELS, type WorkflowStepStatus } from '@/types/enums';

import type { RegisterStep } from '../api/register-edits';

/**
 * Register popup (owner 2026-11-17, ADR 0049): the project's steps as chips,
 * like the client's old tool. One chip per step, in the served workflow order:
 * code + short name, design steps indigo, lab steps green.
 *
 * - N/A (`applicable = false`, served) — greyed and disabled;
 * - Done (served stage status) — not clickable;
 * - the current step — ringed;
 * - excluded — struck through and greyed, "off" instead of ✓.
 *
 * A chip is a native toggle button (`aria-pressed` = excluded), so click,
 * Space and Enter toggle it. Every flag is served; the chips never decide on
 * their own whether a step applies (I9).
 *
 * P44-T01 (owner 2026-11-18): the Projects list's "Steps (click to exclude)"
 * column uses `compact` (3 per line, code above a short name, like the old
 * tool) and, outside a row's edit, `readOnly` (a display of the served state:
 * no buttons, one text per chip).
 */

export interface StepChipState {
  step: RegisterStep;
  /** Excluded with the draft applied. */
  excluded: boolean;
  /** The draft differs from the served flag. */
  changed: boolean;
  /** The step the current-step select shows. */
  current: boolean;
  /** Why the chip cannot be toggled (shown in its name and tooltip), or null. */
  lockedReason: string | null;
  /** A server error names this step. */
  invalid: boolean;
}

/** Indigo (the categorical indigo already used for category tags) and the
 *  success green: existing tokens only. Elapsed (waiting) steps — served by
 *  the contract, not named by the owner — are neutral. */
const KIND_ON: Record<RegisterStep['kind'], string> = {
  design: 'border-dashChart-7/50 bg-dashChart-7/10 text-dashChartInk-7',
  lab: 'border-success/50 bg-success-subtle text-success-subtle-fg',
  elapsed: 'border-border-strong bg-surface-raised text-text-muted',
};
const KIND_HOVER: Record<RegisterStep['kind'], string> = {
  design: 'hover:border-dashChart-7 hover:bg-dashChart-7/20',
  lab: 'hover:border-success hover:bg-success-subtle/70',
  elapsed: 'hover:border-primary/60 hover:bg-primary-subtle/30',
};
const KIND_LABEL: Record<RegisterStep['kind'], string> = { design: 'Design', lab: 'Lab', elapsed: 'Elapsed' };

function shortName(name: string, max = 22): string {
  return name.length > max ? `${name.slice(0, max - 1)}…` : name;
}

export function StepChips({
  chips,
  onToggle,
  describedBy,
  invalid = false,
  compact = false,
  readOnly = false,
  label,
}: {
  chips: readonly StepChipState[];
  onToggle: (stepCode: string) => void;
  describedBy?: string | undefined;
  invalid?: boolean;
  /** The list row's column: 3 per line, smaller chips. */
  compact?: boolean;
  /** A display only (a row not in edit): no buttons. */
  readOnly?: boolean;
  /** Accessible name of the list (the list row names its project). */
  label?: string;
}): React.JSX.Element {
  return (
    <ul
      className={cn(
        compact ? 'grid w-full grid-cols-3 gap-1' : 'grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-4',
        invalid && 'rounded-md p-1 ring-2 ring-danger/60',
      )}
      aria-label={label}
      aria-describedby={describedBy}
      data-testid="step-chips"
      data-readonly={readOnly ? 'true' : undefined}
    >
      {chips.map((chip) => (
        <li key={chip.step.step_code} className="min-w-0">
          <StepChip chip={chip} onToggle={onToggle} compact={compact} readOnly={readOnly} />
        </li>
      ))}
    </ul>
  );
}

function StepChip({
  chip,
  onToggle,
  compact,
  readOnly,
}: {
  chip: StepChipState;
  onToggle: (stepCode: string) => void;
  compact: boolean;
  readOnly: boolean;
}): React.JSX.Element {
  const { step, excluded, changed, current, lockedReason, invalid } = chip;
  const na = !step.applicable;
  const done = step.status === 'Done';
  const disabled = lockedReason !== null;
  const kindLabel = KIND_LABEL[step.kind];
  // Contract §3: an applicable step the split gave 0 weeks is served Skipped
  // ("0 wk (split)", R35-2), never N/A; it stays excludable.
  const splitZero = !na && !excluded && step.status === 'Skipped';
  const state = na
    ? 'N/A'
    : excluded
      ? 'excluded'
      : done
        ? 'Done'
        : splitZero
          ? '0 wk (split)'
          : WORKFLOW_STEP_STATUS_LABELS[step.status as WorkflowStepStatus];
  const nameParts = [`Exclude ${step.step_code} ${step.step_name}`, `${kindLabel.toLowerCase()} step`];
  if (splitZero) nameParts.push('0 weeks after the split');
  if (current) nameParts.push('current step');
  if (lockedReason !== null) nameParts.push(lockedReason);
  const title = `${step.step_code} · ${step.step_name} — ${kindLabel} — ${state}${current ? ' — current step' : ''}${
    disabled ? '' : excluded ? ' — click to include' : ' — click to exclude'
  }`;

  const readTitle = `${step.step_code} · ${step.step_name} — ${kindLabel} — ${state}${current ? ' — current step' : ''}`;
  const className = cn(
    compact
      ? 'relative flex h-9 w-full min-w-0 flex-col items-start justify-center rounded border px-1 text-left text-[0.625rem] leading-tight transition-colors'
      : 'relative flex h-12 w-full min-w-0 flex-col items-start justify-center rounded-md border px-2 text-left text-2xs transition-colors',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-surface',
    na
      ? 'cursor-not-allowed border-dashed border-border-strong bg-surface-sunken/60 text-text-subtle opacity-60'
      : excluded
        ? 'border-dashed border-border-strong bg-surface-sunken text-text-subtle'
        : KIND_ON[step.kind],
    !readOnly && !disabled && !excluded && KIND_HOVER[step.kind],
    !readOnly && !disabled && excluded && 'hover:border-primary/60 hover:bg-primary-subtle/30',
    (readOnly || (disabled && !na)) && 'cursor-default',
    current && 'ring-2 ring-primary ring-offset-1 ring-offset-surface',
    invalid && 'border-danger ring-2 ring-danger',
  );
  const body = (
    <>
      <span className="flex w-full min-w-0 items-center justify-between gap-0.5">
        <span className={cn('truncate font-bold', excluded && 'line-through')}>{step.step_code}</span>
        <span className="flex shrink-0 items-center gap-0.5 font-semibold" aria-hidden="true">
          {changed ? <span className="size-1.5 rounded-full bg-warning" title="Changed, not saved" /> : null}
          {na ? 'N/A' : excluded ? 'off' : splitZero ? (compact ? '0 wk' : '0 wk (split)') : done && !compact ? (
            <>
              <Check className="size-3" />
              Done
            </>
          ) : (
            <Check className={compact ? 'size-2.5' : 'size-3'} />
          )}
        </span>
      </span>
      <span className={cn('w-full truncate', excluded && 'line-through')} aria-hidden="true">
        {shortName(step.step_name, compact ? 9 : 22)}
      </span>
    </>
  );

  if (readOnly) {
    return (
      <span
        className={className}
        title={readTitle}
        data-testid="step-chip"
        data-step={step.step_code}
        data-kind={step.kind}
        data-state={na ? 'na' : excluded ? 'excluded' : done ? 'done' : 'on'}
        data-current={current ? 'true' : undefined}
        data-changed={changed ? 'true' : undefined}
      >
        {body}
        <span className="sr-only">{`${step.step_code} ${step.step_name}: ${state}${current ? ', current step' : ''}${changed ? ', unsaved change' : ''}`}</span>
      </span>
    );
  }

  return (
    <button
      type="button"
      aria-pressed={excluded}
      aria-label={nameParts.join(', ')}
      aria-invalid={invalid ? true : undefined}
      disabled={disabled}
      title={title}
      data-testid="step-chip"
      data-step={step.step_code}
      data-kind={step.kind}
      data-state={na ? 'na' : excluded ? 'excluded' : done ? 'done' : 'on'}
      data-current={current ? 'true' : undefined}
      data-changed={changed ? 'true' : undefined}
      onClick={() => onToggle(step.step_code)}
      className={className}
    >
      {body}
    </button>
  );
}

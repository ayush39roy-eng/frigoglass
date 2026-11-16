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

function shortName(name: string): string {
  return name.length > 22 ? `${name.slice(0, 21)}…` : name;
}

export function StepChips({
  chips,
  onToggle,
  describedBy,
  invalid = false,
}: {
  chips: readonly StepChipState[];
  onToggle: (stepCode: string) => void;
  describedBy?: string | undefined;
  invalid?: boolean;
}): React.JSX.Element {
  return (
    <ul
      className={cn(
        'grid grid-cols-2 gap-1.5 sm:grid-cols-3 lg:grid-cols-4',
        invalid && 'rounded-md p-1 ring-2 ring-danger/60',
      )}
      aria-describedby={describedBy}
      data-testid="step-chips"
    >
      {chips.map((chip) => (
        <li key={chip.step.step_code} className="min-w-0">
          <StepChip chip={chip} onToggle={onToggle} />
        </li>
      ))}
    </ul>
  );
}

function StepChip({ chip, onToggle }: { chip: StepChipState; onToggle: (stepCode: string) => void }): React.JSX.Element {
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
      className={cn(
        'relative flex h-12 w-full min-w-0 flex-col items-start justify-center rounded-md border px-2 text-left text-2xs transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-surface',
        na
          ? 'cursor-not-allowed border-border bg-surface-sunken/60 text-text-subtle opacity-60'
          : excluded
            ? 'border-dashed border-border-strong bg-surface-sunken text-text-subtle'
            : KIND_ON[step.kind],
        !disabled && !excluded && KIND_HOVER[step.kind],
        !disabled && excluded && 'hover:border-primary/60 hover:bg-primary-subtle/30',
        disabled && !na && 'cursor-default',
        current && 'ring-2 ring-primary ring-offset-1 ring-offset-surface',
        invalid && 'border-danger ring-2 ring-danger',
      )}
    >
      <span className="flex w-full min-w-0 items-center justify-between gap-1">
        <span className={cn('truncate font-bold', excluded && 'line-through')}>{step.step_code}</span>
        <span className="flex shrink-0 items-center gap-0.5 font-semibold" aria-hidden="true">
          {changed ? <span className="size-1.5 rounded-full bg-warning" title="Changed, not saved" /> : null}
          {na ? 'N/A' : excluded ? 'off' : splitZero ? '0 wk (split)' : done ? (
            <>
              <Check className="size-3" />
              Done
            </>
          ) : (
            <Check className="size-3" />
          )}
        </span>
      </span>
      <span className={cn('w-full truncate', excluded && 'line-through')} aria-hidden="true">
        {shortName(step.step_name)}
      </span>
    </button>
  );
}

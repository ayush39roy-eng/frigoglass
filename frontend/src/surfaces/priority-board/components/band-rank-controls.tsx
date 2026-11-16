import * as React from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

import { cn } from '@/lib/utils';
import type { ProjectPriority } from '@/types/enums';

import { parseTypedRank } from '../lib/board-model';

/**
 * Owner request 2026-11-17: re-rank a card without dragging — the served
 * position chip as an editable number, and ↑ / ↓ one position. Both hand a
 * target rank (`to_rank`) to the board, which opens the shared preview side
 * panel; nothing is written before Yes. The browser never knows the band's
 * size (P36-R02): ↓ is disabled only when the board knows the card is last
 * from served data, otherwise the server answers 422 `BAD_RANK`.
 */

export const TYPED_RANK_ERROR = 'Type a whole number, 1 or more.';

export interface BandRankInputProps {
  name: string;
  band: ProjectPriority;
  /** The served `band_rank`. */
  rank: number;
  /** A move is in flight or this card's move is pending: typing is ignored. */
  inert: boolean;
  /** This card's own move is pending: the served rank is stale, shown as "…". */
  pending?: boolean;
  onSubmit: (toRank: number) => void;
  /** Dense list row. */
  dense?: boolean;
  className?: string;
}

/** The position chip as an input in place: Enter / blur submits, Escape cancels. */
export function BandRankInput({ name, band, rank, inert, pending = false, onSubmit, dense = false, className }: BandRankInputProps): React.JSX.Element {
  const [draft, setDraft] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  // The blur after Enter (focus moves into the preview panel) must not submit twice.
  const draftRef = React.useRef<string | null>(null);
  const errorId = React.useId();

  const reset = (): void => {
    draftRef.current = null;
    setDraft(null);
    setError(null);
  };

  const commit = (source: 'enter' | 'blur'): void => {
    const raw = draftRef.current;
    if (raw === null) return;
    if (inert || pending) {
      reset();
      return;
    }
    const next = parseTypedRank(raw);
    if (next === null) {
      if (source === 'enter') setError(TYPED_RANK_ERROR);
      else reset();
      return;
    }
    reset();
    if (next !== rank) onSubmit(next);
  };

  return (
    <span className={cn('relative inline-flex shrink-0 items-center', className)}>
      <span className="pointer-events-none absolute left-1 font-mono text-2xs font-semibold text-text-subtle" aria-hidden="true">
        #
      </span>
      <input
        type="text"
        inputMode="numeric"
        autoComplete="off"
        spellCheck={false}
        maxLength={4}
        value={pending ? '…' : (draft ?? String(rank))}
        readOnly={inert || pending}
        aria-label={`Position of ${name} in ${band}. Type a new position and press Enter`}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        title={`Position ${String(rank)} in ${band}: its scheduling order inside the band. Type a number and press Enter to move it.`}
        className={cn(
          'rounded-sm bg-surface-sunken pl-3 pr-1 text-right font-mono text-2xs font-semibold tabular-nums text-text',
          'ring-1 ring-inset ring-border-strong/50 transition-colors hover:ring-primary focus:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          dense ? 'h-5 w-9' : 'h-5 w-10',
          error && 'ring-2 ring-danger',
          inert && 'cursor-not-allowed opacity-60',
        )}
        data-numeric=""
        data-testid="board-rank-input"
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => {
          draftRef.current = e.target.value;
          setDraft(e.target.value);
          setError(null);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit('enter');
          } else if (e.key === 'Escape') {
            if (draftRef.current !== null || error) {
              e.preventDefault();
              e.stopPropagation();
            }
            reset();
          }
        }}
        onBlur={() => commit('blur')}
      />
      {error ? (
        <span
          id={errorId}
          role="alert"
          className="absolute left-0 top-full z-10 mt-1 whitespace-nowrap rounded-sm bg-danger-subtle px-1.5 py-0.5 text-2xs font-medium text-danger-subtle-fg shadow-sm"
          data-testid="board-rank-input-error"
        >
          {error}
        </span>
      ) : null}
    </span>
  );
}

export interface BandRankStepButtonsProps {
  name: string;
  band: ProjectPriority;
  rank: number;
  inert: boolean;
  /** The board knows from served data that this card is last in its full band. */
  knownLast: boolean;
  onMove: (toRank: number) => void;
  /** `row` (card footer) or `stack` (list row). */
  orientation?: 'row' | 'stack';
}

function StepButton({
  label,
  disabled,
  inert,
  onClick,
  children,
  className,
  testId,
}: {
  label: string;
  disabled: boolean;
  inert: boolean;
  onClick: () => void;
  children: React.ReactNode;
  className: string;
  testId: string;
}): React.JSX.Element {
  return (
    <button
      type="button"
      // Busy / pending: aria-disabled, not `disabled`, so focus stays on the
      // button while the preview panel is open and returns to it on close.
      disabled={disabled}
      aria-disabled={!disabled && inert ? true : undefined}
      aria-label={label}
      title={label}
      onClick={() => {
        if (!disabled && !inert) onClick();
      }}
      className={cn(
        'grid shrink-0 place-items-center rounded-sm text-text-muted transition-colors hover:bg-primary-subtle hover:text-primary',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-text-muted',
        'aria-disabled:cursor-not-allowed aria-disabled:opacity-60',
        className,
      )}
      data-testid={testId}
    >
      {children}
    </button>
  );
}

/** ↑ / ↓ one position inside the band (current rank ± 1). */
export function BandRankStepButtons({
  name,
  band,
  rank,
  inert,
  knownLast,
  onMove,
  orientation = 'row',
}: BandRankStepButtonsProps): React.JSX.Element {
  const stack = orientation === 'stack';
  const size = stack ? 'h-[1.3rem] w-5' : 'size-6';
  return (
    <span className={cn('inline-flex shrink-0', stack ? 'flex-col' : 'items-center gap-0.5')} data-testid="board-rank-steps">
      <StepButton
        label={`Move ${name} up one position in ${band}`}
        disabled={rank <= 1}
        inert={inert}
        onClick={() => onMove(rank - 1)}
        className={size}
        testId="board-rank-up"
      >
        <ChevronUp className="size-3.5" aria-hidden="true" />
      </StepButton>
      <StepButton
        label={`Move ${name} down one position in ${band}`}
        disabled={knownLast}
        inert={inert}
        onClick={() => onMove(rank + 1)}
        className={size}
        testId="board-rank-down"
      >
        <ChevronDown className="size-3.5" aria-hidden="true" />
      </StepButton>
    </span>
  );
}

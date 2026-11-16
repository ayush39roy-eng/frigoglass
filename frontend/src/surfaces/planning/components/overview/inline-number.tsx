import * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * Numeric input for one resource field (FTE, platforms, efficiency) while its
 * card is in edit mode (owner ask 2026-11-17). Controlled by the card's draft:
 * typing only changes the draft, nothing is sent until the card's Save.
 * Escape restores the served value. A changed value is marked (amber border
 * and fill, plus the row's "Unsaved" tag for screen readers); an invalid one
 * shows the existing form schema message under the input.
 */
export interface InlineNumberProps {
  id: string;
  label: string;
  text: string;
  step: string;
  min: number;
  inputMode: 'decimal' | 'numeric';
  changed: boolean;
  error: string | null;
  disabled?: boolean;
  onChange: (text: string) => void;
  onRevert: () => void;
  className?: string;
}

export function InlineNumber({
  id,
  label,
  text,
  step,
  min,
  inputMode,
  changed,
  error,
  disabled,
  onChange,
  onRevert,
  className,
}: InlineNumberProps): React.JSX.Element {
  const errorId = `${id}-error`;
  return (
    <div className={cn('flex flex-col items-end', className)}>
      <input
        id={id}
        type="number"
        aria-label={label}
        value={text}
        step={step}
        min={min}
        inputMode={inputMode}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        data-changed={changed ? 'true' : undefined}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
          } else if (e.key === 'Escape') {
            onRevert();
          }
        }}
        className={cn(
          'tnum h-7 w-14 rounded-control border border-border bg-surface px-1 text-right text-xs text-text',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60',
          'data-[changed=true]:border-2 data-[changed=true]:border-warning data-[changed=true]:bg-warning-subtle',
          'aria-[invalid=true]:border-danger [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none',
        )}
      />
      {error ? (
        <span id={errorId} className="mt-0.5 max-w-[8rem] text-right text-2xs text-danger">
          {error}
        </span>
      ) : null}
    </div>
  );
}

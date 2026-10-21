import * as React from 'react';

import { cn } from '@/lib/utils';

import { saveErrorMessage } from './save-error';

/**
 * Inline numeric editor for one resource input (FTE, platforms, efficiency).
 * Commits on Enter or blur when the text changed and passes `validate` (the
 * same rules as the existing engineer / chamber form schemas); Escape restores
 * the saved value. A rejected save (server 422 / 403) shows the message under
 * the input and restores the saved value; the optimistic list cache is rolled
 * back by the mutation hook.
 */
export interface InlineNumberProps {
  id: string;
  label: string;
  value: number;
  step: string;
  min: number;
  inputMode: 'decimal' | 'numeric';
  validate: (text: string) => string | null;
  onCommit: (value: number) => Promise<unknown>;
  className?: string;
}

export function InlineNumber({ id, label, value, step, min, inputMode, validate, onCommit, className }: InlineNumberProps): React.JSX.Element {
  const [text, setText] = React.useState(String(value));
  const [error, setError] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);

  // A new served value (refetch, someone else's edit) replaces the text
  // (state adjusted during render, not in an effect).
  const [seenValue, setSeenValue] = React.useState(value);
  if (seenValue !== value) {
    setSeenValue(value);
    setText(String(value));
  }

  const commit = async () => {
    const trimmed = text.trim();
    if (trimmed === String(value)) {
      setError(null);
      return;
    }
    const problem = validate(trimmed);
    if (problem) {
      setError(problem);
      return;
    }
    setError(null);
    setBusy(true);
    try {
      await onCommit(Number(trimmed));
    } catch (err) {
      setText(String(value));
      setError(saveErrorMessage(err));
    } finally {
      setBusy(false);
    }
  };

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
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? errorId : undefined}
        aria-busy={busy || undefined}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => void commit()}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            void commit();
          } else if (e.key === 'Escape') {
            setText(String(value));
            setError(null);
          }
        }}
        className={cn(
          'tnum h-7 w-14 rounded-control border border-border bg-surface px-1 text-right text-xs text-text',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          'aria-[invalid=true]:border-danger [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none',
        )}
      />
      {error ? (
        <span id={errorId} role="alert" className="mt-0.5 max-w-[8rem] text-right text-2xs text-danger">
          {error}
        </span>
      ) : null}
    </div>
  );
}


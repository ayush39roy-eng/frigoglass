import * as React from 'react';
import { Check } from 'lucide-react';

import { cn } from '@/lib/utils';

/**
 * A small toggle button for one allowed category / allowed stage (P19-T04).
 * `aria-pressed` carries the state; the accessible name is the action
 * ("Allow category B for Lokesh") and stays the same in both states, as the
 * WAI-ARIA toggle-button pattern asks. The check mark and the filled style are
 * the visual state; colour is never the only cue.
 */
export interface ToggleChipProps {
  pressed: boolean;
  label: string;
  onToggle: () => void;
  tone: 'primary' | 'success';
  disabled?: boolean;
  title?: string | undefined;
  children: React.ReactNode;
}

const TONE = {
  primary: 'aria-pressed:border-primary aria-pressed:bg-primary aria-pressed:text-primary-fg',
  success: 'aria-pressed:border-success aria-pressed:bg-success-subtle aria-pressed:text-success-subtle-fg',
} as const;

export function ToggleChip({ pressed, label, onToggle, tone, disabled, title, children }: ToggleChipProps): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      aria-label={label}
      title={title ?? label}
      disabled={disabled}
      onClick={onToggle}
      className={cn(
        'inline-flex min-h-6 items-center gap-0.5 rounded-pill border border-border bg-surface px-1.5 text-2xs font-semibold',
        'text-text-muted transition-colors hover:border-border-strong hover:text-text',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        'disabled:cursor-wait disabled:opacity-60 motion-reduce:transition-none',
        TONE[tone],
      )}
    >
      {pressed ? <Check aria-hidden="true" className="size-3 shrink-0" /> : null}
      {children}
    </button>
  );
}

/** The read-only counterpart: a static chip, no control. */
export function StaticChip({ tone, title, children }: { tone: 'primary' | 'success'; title?: string | undefined; children: React.ReactNode }): React.JSX.Element {
  return (
    <span
      title={title}
      className={cn(
        'inline-flex min-h-6 items-center rounded-pill border px-1.5 text-2xs font-semibold',
        tone === 'primary'
          ? 'border-primary/40 bg-primary-subtle text-primary-subtle-fg'
          : 'border-success/40 bg-success-subtle text-success-subtle-fg',
      )}
    >
      {children}
    </span>
  );
}

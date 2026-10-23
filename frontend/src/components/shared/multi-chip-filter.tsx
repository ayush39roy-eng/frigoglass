import * as React from 'react';
import { Check } from 'lucide-react';

import { cn } from '@/lib/utils';
import { toggleSelection, type MultiChipOption } from '@/lib/multi-select-filter';

/**
 * P31: the ONE multi-select "tabs" control for project category and project
 * type, used on every surface that filters by them (Dashboard, Projects,
 * Gantt, Matrix View panel, Priority board) and as the clickable legend of the
 * Dashboard's cross-filter donuts.
 *
 * `[All] [A+] [A] [B] …` — "All" clears the selection (and reads as pressed when
 * nothing is selected); every other chip toggles its value, so several can be
 * on at once. The order of the selection is always the option order.
 *
 * Accessibility: a labelled `role="group"` of native `<button aria-pressed>`
 * toggles — Tab moves between chips, Space / Enter toggles. The pressed state is
 * shown by fill AND a check mark (colour is never the only cue). Labels never
 * truncate: a chip keeps its full text on one line and the row wraps.
 */

export type { MultiChipOption };

export interface MultiChipFilterProps<T extends string> {
  /** The group's name ("Category", "Type"). */
  label: string;
  /** Keep the label for screen readers only. */
  hideLabel?: boolean;
  options: readonly MultiChipOption<T>[];
  value: readonly T[];
  onChange: (next: T[]) => void;
  /** Show the "All" chip (clears the selection). Default true. */
  showAll?: boolean;
  allLabel?: string;
  /** Visually dim the chips that are not selected while something is selected (legend use). */
  dimUnselected?: boolean;
  className?: string;
  'data-testid'?: string;
}

const CHIP =
  'inline-flex h-7 max-w-full shrink-0 items-center gap-1 whitespace-nowrap rounded-pill border px-2.5 text-xs font-semibold ' +
  'transition-colors motion-reduce:transition-none ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-canvas ' +
  'border-border bg-surface text-text-muted hover:border-border-strong hover:text-text ' +
  'aria-pressed:border-primary aria-pressed:bg-primary aria-pressed:text-primary-fg aria-pressed:hover:text-primary-fg';

export function MultiChipFilter<T extends string>({
  label,
  hideLabel = false,
  options,
  value,
  onChange,
  showAll = true,
  allLabel = 'All',
  dimUnselected = false,
  className,
  'data-testid': testId,
}: MultiChipFilterProps<T>): React.JSX.Element {
  const labelId = React.useId();
  const allowed = React.useMemo(() => options.map((o) => o.value), [options]);
  const selected = new Set<string>(value);
  const none = value.length === 0;

  return (
    <div
      role="group"
      aria-labelledby={labelId}
      className={cn('flex min-w-0 items-start gap-2', className)}
      data-testid={testId}
    >
      <span
        id={labelId}
        className={cn(
          hideLabel ? 'sr-only' : 'shrink-0 pt-1.5 text-2xs font-bold uppercase leading-none tracking-wider text-text-subtle',
        )}
      >
        {label}
      </span>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {showAll ? (
          <button type="button" aria-pressed={none} className={CHIP} onClick={() => onChange([])} data-chip="all">
            {none ? <Check aria-hidden="true" className="size-3 shrink-0" /> : null}
            {allLabel}
          </button>
        ) : null}
        {options.map((o) => {
          const on = selected.has(o.value);
          return (
            <button
              key={o.value}
              type="button"
              aria-pressed={on}
              title={o.title}
              className={cn(CHIP, dimUnselected && !none && !on && 'opacity-55 hover:opacity-100')}
              onClick={() => onChange(toggleSelection(value, o.value, allowed))}
              data-chip={o.value}
            >
              {on ? <Check aria-hidden="true" className="size-3 shrink-0" /> : null}
              {o.swatch ? (
                <span aria-hidden="true" className="size-2.5 shrink-0 rounded-sm" style={{ background: o.swatch }} />
              ) : null}
              <span>{o.label}</span>
              {o.meta ? (
                <span className={cn('font-medium tabular-nums', on ? 'text-primary-fg' : 'text-text-subtle')} data-numeric="">
                  {o.meta}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}

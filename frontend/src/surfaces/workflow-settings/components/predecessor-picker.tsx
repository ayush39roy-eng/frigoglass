import * as React from 'react';
import { ChevronDown } from 'lucide-react';

import { Checkbox } from '@/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';

/**
 * "Can start after…" multi-select for one step: the EARLIER steps (lower
 * sequence order) of the same workflow as a checkbox list. Read-only roles get
 * the same list as plain text.
 */
export interface PredecessorOption {
  step_id: string;
  name: string;
}

export function PredecessorPicker({
  stepId,
  stepName,
  options,
  value,
  onChange,
  disabled,
  invalid,
}: {
  stepId: string;
  stepName: string;
  options: PredecessorOption[];
  value: readonly string[];
  onChange: (next: string[]) => void;
  disabled: boolean;
  invalid?: boolean;
}): React.JSX.Element {
  const label = value.length === 0 ? (options.length === 0 ? 'First step' : 'Nothing selected') : value.map((v) => v.slice(-1)).join(', ');
  if (disabled) {
    return (
      <span className="text-xs text-text" data-testid={`preds-${stepId}`}>
        {label}
      </span>
    );
  }
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex h-8 w-full items-center justify-between gap-2 rounded border bg-surface px-2.5 text-left text-xs text-text',
            invalid ? 'border-danger' : 'border-border-strong',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            options.length === 0 && 'cursor-not-allowed opacity-60',
          )}
          aria-label={`Can start after — ${stepName}`}
          aria-invalid={invalid ? true : undefined}
          disabled={options.length === 0}
          data-testid={`preds-${stepId}`}
        >
          <span className="truncate">{label}</span>
          <ChevronDown className="size-3.5 shrink-0 opacity-60" aria-hidden="true" />
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72 p-2">
        <p className="mb-1 px-1 text-2xs font-semibold text-text-muted">{stepName} can start after…</p>
        <div className="max-h-64 space-y-0.5 overflow-y-auto">
          {options.map((opt) => {
            const checked = value.includes(opt.step_id);
            return (
              <label key={opt.step_id} className="flex items-center gap-2 rounded px-1 py-1 text-xs text-text hover:bg-surface-raised">
                <Checkbox
                  checked={checked}
                  onCheckedChange={(next) =>
                    onChange(
                      next === true
                        ? [...value, opt.step_id].sort()
                        : value.filter((v) => v !== opt.step_id),
                    )
                  }
                  aria-label={`${opt.step_id.slice(-1)} ${opt.name}`}
                />
                <span className="font-mono text-2xs text-text-muted">{opt.step_id.slice(-1)}</span>
                <span className="truncate">{opt.name}</span>
              </label>
            );
          })}
        </div>
      </PopoverContent>
    </Popover>
  );
}

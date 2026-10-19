import * as React from 'react';

import { Input } from '@/components/ui/input';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

/**
 * P13-T14 Matrix toolbar pieces (API_CONTRACT_P13 §7; mock-up image 11):
 * Cat / Type / Status chip rows and the per-column filter inputs. Category,
 * Type, Status and the Project search are SERVER params (the served `rank` is
 * within that filtered set). The Hub and Leader column inputs only narrow the
 * rows already served — a view filter; no figure is recomputed.
 */

const ALL = '__all__';

/** One labelled single-select chip row ("CAT: All A+ A B C"). */
export function ChipFilter<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T | null;
  options: readonly { value: T; label: string; title?: string }[];
  onChange: (next: T | null) => void;
}): React.JSX.Element {
  const labelId = React.useId();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span id={labelId} className="text-2xs font-bold uppercase tracking-wider text-text-subtle">
        {label}
      </span>
      <ToggleGroup
        type="single"
        size="sm"
        aria-labelledby={labelId}
        value={value ?? ALL}
        onValueChange={(next) => {
          // Radix emits "" when the active chip is re-clicked: keep a selection.
          if (next === '') return;
          onChange(next === ALL ? null : (next as T));
        }}
        className="flex-wrap"
      >
        <ToggleGroupItem value={ALL} className="rounded-pill">
          All
        </ToggleGroupItem>
        {options.map((o) => (
          <ToggleGroupItem key={o.value} value={o.value} title={o.title} className="rounded-pill">
            {o.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

/** A compact "Filter…" input for the grid's filter row. */
export function ColumnFilterInput({
  column,
  value,
  onChange,
  placeholder = 'Filter…',
  maxLength,
}: {
  column: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  maxLength?: number;
}): React.JSX.Element {
  return (
    <Input
      type="search"
      aria-label={`Filter by ${column}`}
      value={value}
      placeholder={placeholder}
      maxLength={maxLength}
      onChange={(e) => onChange(e.currentTarget.value)}
      className="h-7 w-full px-2 text-2xs normal-case tracking-normal"
    />
  );
}

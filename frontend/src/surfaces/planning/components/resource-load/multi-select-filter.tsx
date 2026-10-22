import * as React from 'react';
import { ChevronDown } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

import type { FilterOption } from '../../api/types';

/**
 * A compact multi-select filter (P19-T04 Resource load analytics): a trigger
 * reading "Type: All" / "Type: NM" / "Type: 2 selected" that opens a popover
 * of checkboxes, with a search box once the list is long. An empty selection
 * means "All". Keyboard: the trigger opens with Enter/Space, Tab moves through
 * the search box and checkboxes, Escape closes and returns focus.
 */
export interface MultiSelectFilterProps {
  label: string;
  /** The full name for assistive technology when `label` is abbreviated ("Dept" → "Department"). */
  name?: string;
  options: FilterOption[];
  value: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
  disabledReason?: string;
}

export function MultiSelectFilter({ label, name, options, value, onChange, disabled, disabledReason }: MultiSelectFilterProps): React.JSX.Element {
  const [query, setQuery] = React.useState('');
  const listId = React.useId();
  const selected = new Set(value);
  const summary =
    value.length === 0
      ? 'All'
      : value.length === 1
        ? (options.find((o) => o.value === value[0])?.label ?? value[0]!)
        : `${String(value.length)} selected`;
  const shown = query.trim()
    ? options.filter((o) => o.label.toLowerCase().includes(query.trim().toLowerCase()))
    : options;

  const toggle = (v: string, checked: boolean) => {
    onChange(checked ? [...value, v] : value.filter((x) => x !== v));
  };

  if (disabled) {
    // aria-disabled (not `disabled`) keeps it focusable so the tooltip saying
    // why is reachable by keyboard; it never opens.
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            aria-disabled="true"
            aria-label={`${label} filter: ${summary}, unavailable`}
            onClick={(e) => e.preventDefault()}
            className="h-8 cursor-not-allowed gap-1 px-2.5 opacity-60"
          >
            <span className="text-2xs font-bold uppercase tracking-wide text-text-muted">{label}</span>
            <span className="text-xs">{summary}</span>
            <ChevronDown aria-hidden="true" className="size-3.5 shrink-0" />
          </Button>
        </TooltipTrigger>
        <TooltipContent>{disabledReason}</TooltipContent>
      </Tooltip>
    );
  }

  return (
    <Popover onOpenChange={(open) => (open ? undefined : setQuery(''))}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          aria-label={`${label} filter: ${summary}`}
          className={cn('h-8 max-w-[14rem] justify-between gap-1 px-2.5', value.length > 0 && 'border-primary text-primary-subtle-fg')}
        >
          <span className="text-2xs font-bold uppercase tracking-wide text-text-muted">{label}</span>
          <span className="truncate text-xs">{summary}</span>
          <ChevronDown aria-hidden="true" className="size-3.5 shrink-0" />
        </Button>
      </PopoverTrigger>
      {/* QA-F24-1 (WCAG 4.1.2): the popover is a dialog and needs a name. */}
      <PopoverContent align="start" className="w-64 p-2" aria-label={`${name ?? label} filter options`}>
        <fieldset>
          <legend className="sr-only">{name ?? label}</legend>
          {options.length > 8 ? (
            <input
              type="search"
              aria-label={`Search ${label.toLowerCase()} options`}
              aria-controls={listId}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search…"
              className="mb-2 h-8 w-full rounded-control border border-border bg-surface px-2 text-xs text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            />
          ) : null}
          <ul id={listId} className="max-h-64 overflow-y-auto">
            {shown.length === 0 ? <li className="px-1 py-1 text-2xs text-text-subtle">No options</li> : null}
            {shown.map((o) => {
              const id = `${listId}-${o.value}`;
              return (
                <li key={o.value} className="flex items-center gap-2 rounded px-1 py-1 hover:bg-surface-sunken">
                  <Checkbox id={id} checked={selected.has(o.value)} onCheckedChange={(c) => toggle(o.value, c === true)} />
                  <label htmlFor={id} className="flex-1 cursor-pointer text-xs text-text">
                    {o.label}
                  </label>
                </li>
              );
            })}
          </ul>
        </fieldset>
        {value.length > 0 ? (
          <Button type="button" variant="ghost" size="sm" className="mt-1 h-7 w-full" onClick={() => onChange([])}>
            Clear {label.toLowerCase()}
          </Button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

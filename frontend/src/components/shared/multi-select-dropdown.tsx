import * as React from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';

import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { summarizeSelection } from '@/lib/multi-select-summary';
import { cn } from '@/lib/utils';

/**
 * Owner ask 2026-11-13 ("make all the filters multiple select";
 * `docs/API_CONTRACT_MULTISELECT.md` §3): the ONE multi-select filter dropdown.
 *
 * A trigger button that summarises the selection ("All statuses" / "In Queue" /
 * "3 statuses") opens a popover holding a checkbox list:
 * - "All …" first — it clears the selection and reads as checked when nothing
 *   is selected (nothing selected = not filtered);
 * - every option toggles; the popover stays open so several can be picked;
 * - a search box appears when there are more than `searchThreshold` (8) options;
 * - options may carry a `group` heading (the header hub filter: Countries / Hubs).
 *
 * The selection handed to `onChange` is always in OPTION order, so the request,
 * the URL and the query key do not depend on click order.
 *
 * Keyboard: the trigger is a button (Enter / Space / ArrowDown open it). Inside,
 * focus starts on the search box (if any) or the first checked row; ArrowUp /
 * ArrowDown / Home / End move between rows, Space / Enter toggle, Escape closes
 * and returns focus to the trigger (Radix Popover). Rows are `role="option"`
 * with `aria-selected` inside an `aria-multiselectable` listbox; the check box
 * is drawn AND the state is exposed (colour is never the only cue).
 *
 * Pure UI: it never filters data itself — the caller sends the list to the
 * server (I9).
 */

export interface MultiSelectOption<T extends string = string> {
  value: T;
  label: string;
  /** Group heading the option sits under (consecutive options share one heading). */
  group?: string | undefined;
  /** Tooltip / extra text (also matched by the search box). */
  title?: string | undefined;
  /** A small leading visual (flag, swatch). Decorative. */
  icon?: React.ReactNode;
}

export interface MultiSelectDropdownProps<T extends string> {
  /** Field name ("Status"); the trigger's accessible name. */
  label: string;
  /** Keep the label for screen readers only (default: shown above the trigger). */
  hideLabel?: boolean | undefined;
  options: readonly MultiSelectOption<T>[];
  value: readonly T[];
  onChange: (next: T[]) => void;
  /** Text for "nothing selected" ("All statuses"); also the clear row's label. */
  allLabel: string;
  /** Plural noun for "3 statuses". Default: `allLabel` without its leading "All ". */
  pluralNoun?: string | undefined;
  /** Custom trigger summary for a non-empty selection. */
  summarize?: ((selected: readonly MultiSelectOption<T>[]) => string) | undefined;
  /** Show the search box above this many options (default 8). */
  searchThreshold?: number | undefined;
  disabled?: boolean | undefined;
  /** Classes for the trigger (width, height). */
  triggerClassName?: string | undefined;
  /** Classes for the wrapper. */
  className?: string | undefined;
  /** Leading icon inside the trigger. */
  triggerIcon?: React.ReactNode | undefined;
  align?: 'start' | 'center' | 'end' | undefined;
  id?: string | undefined;
  'data-testid'?: string | undefined;
}

const ROW =
  'flex w-full cursor-pointer select-none items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-text outline-none ' +
  'hover:bg-surface-sunken focus-visible:bg-surface-sunken focus-visible:ring-2 focus-visible:ring-ring';

function CheckBox({ checked }: { checked: boolean }): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className={cn(
        'grid size-4 shrink-0 place-items-center rounded-sm border',
        checked ? 'border-primary bg-primary text-primary-fg' : 'border-border-strong bg-surface',
      )}
    >
      {checked ? <Check className="size-3" /> : null}
    </span>
  );
}

export function MultiSelectDropdown<T extends string>({
  label,
  hideLabel = false,
  options,
  value,
  onChange,
  allLabel,
  pluralNoun,
  summarize,
  searchThreshold = 8,
  disabled = false,
  triggerClassName,
  className,
  triggerIcon,
  align = 'start',
  id: idProp,
  'data-testid': testId,
}: MultiSelectDropdownProps<T>): React.JSX.Element {
  const autoId = React.useId();
  const id = idProp ?? autoId;
  const labelId = `${id}-label`;
  const summaryId = `${id}-summary`;
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const listRef = React.useRef<HTMLDivElement>(null);
  const searchRef = React.useRef<HTMLInputElement>(null);

  const selectedSet = React.useMemo(() => new Set<string>(value), [value]);
  const selectedOptions = React.useMemo(() => options.filter((o) => selectedSet.has(o.value)), [options, selectedSet]);
  // A selected value with no option yet (options still loading) still counts.
  const unknownCount = value.filter((v) => !options.some((o) => o.value === v)).length;
  const summary =
    unknownCount > 0
      ? summarizeSelection(
          [...selectedOptions, ...Array.from({ length: unknownCount }, () => ({ value: '' as T, label: 'Selected' }))],
          allLabel,
          pluralNoun,
        )
      : selectedOptions.length > 0 && summarize
        ? summarize(selectedOptions)
        : summarizeSelection(selectedOptions, allLabel, pluralNoun);
  const showSearch = options.length > searchThreshold;
  const needle = query.trim().toLowerCase();
  const visible = needle
    ? options.filter(
        (o) => o.label.toLowerCase().includes(needle) || (o.title?.toLowerCase().includes(needle) ?? false),
      )
    : options;

  const toggle = (v: T): void => {
    const next = new Set<string>(value);
    if (next.has(v)) next.delete(v);
    else next.add(v);
    // Option order; values not (yet) among the options are kept at the end.
    const ordered = options.filter((o) => next.has(o.value)).map((o) => o.value);
    const extra = value.filter((x) => next.has(x) && !options.some((o) => o.value === x));
    onChange([...ordered, ...extra]);
  };

  const rows = (): HTMLElement[] =>
    Array.from(listRef.current?.querySelectorAll<HTMLElement>('[role="option"]') ?? []);

  const focusRow = (index: number): void => {
    const all = rows();
    if (all.length === 0) return;
    const i = Math.max(0, Math.min(all.length - 1, index));
    all[i]?.focus();
  };

  const onListKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const all = rows();
    const current = all.indexOf(document.activeElement as HTMLElement);
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        focusRow(current + 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (current <= 0 && showSearch) searchRef.current?.focus();
        else focusRow(current - 1);
        break;
      case 'Home':
        e.preventDefault();
        focusRow(0);
        break;
      case 'End':
        e.preventDefault();
        focusRow(all.length - 1);
        break;
      default:
        break;
    }
  };

  const onRowKeyDown = (e: React.KeyboardEvent<HTMLElement>, act: () => void): void => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      act();
    }
  };

  // Consecutive options sharing a `group` render under one heading.
  const sections: { group: string | undefined; items: MultiSelectOption<T>[] }[] = [];
  for (const o of visible) {
    const last = sections[sections.length - 1];
    if (last && last.group === o.group) last.items.push(o);
    else sections.push({ group: o.group, items: [o] });
  }

  return (
    <div className={cn('flex min-w-0 flex-col gap-1', className)} data-testid={testId}>
      <span id={labelId} className={hideLabel ? 'sr-only' : 'text-2xs text-text-muted'}>
        {label}
      </span>
      <Popover
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setQuery('');
        }}
      >
        <PopoverTrigger asChild disabled={disabled}>
          <button
            type="button"
            id={id}
            aria-labelledby={labelId}
            aria-describedby={summaryId}
            data-active={value.length > 0 ? 'true' : undefined}
            className={cn(
              'flex h-8 w-40 min-w-0 items-center justify-between gap-1.5 rounded border border-border-strong bg-surface px-2.5 text-left text-xs text-text',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-canvas',
              'disabled:cursor-not-allowed disabled:opacity-50',
              value.length > 0 && 'border-primary/50 bg-primary-subtle text-primary-subtle-fg',
              triggerClassName,
            )}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' && !open) {
                e.preventDefault();
                setOpen(true);
              }
            }}
          >
            {triggerIcon}
            <span id={summaryId} className="min-w-0 flex-1 truncate" data-testid={testId ? `${testId}-summary` : undefined}>
              {summary}
            </span>
            <ChevronDown aria-hidden="true" className="size-3.5 shrink-0 opacity-60" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          aria-label={label}
          align={align}
          className="w-64 p-1.5"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            if (showSearch) {
              searchRef.current?.focus();
              return;
            }
            const all = rows();
            const firstChecked = all.findIndex((r) => r.getAttribute('aria-selected') === 'true');
            focusRow(firstChecked >= 0 ? firstChecked : 0);
          }}
        >
          {showSearch ? (
            <div className="relative mb-1.5">
              <Search
                aria-hidden="true"
                className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-text-subtle"
              />
              <input
                ref={searchRef}
                type="search"
                value={query}
                onChange={(e) => setQuery(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    focusRow(0);
                  }
                }}
                aria-label={`Search ${label.toLowerCase()}`}
                placeholder="Search…"
                maxLength={100}
                className="h-8 w-full rounded border border-border-strong bg-surface pl-7 pr-2 text-xs text-text placeholder:text-text-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </div>
          ) : null}
          <div
            ref={listRef}
            role="listbox"
            aria-multiselectable="true"
            aria-labelledby={labelId}
            onKeyDown={onListKeyDown}
            className="max-h-72 overflow-y-auto"
          >
            <div
              role="option"
              aria-selected={value.length === 0}
              tabIndex={-1}
              className={cn(ROW, 'font-semibold')}
              onClick={() => onChange([])}
              onKeyDown={(e) => onRowKeyDown(e, () => onChange([]))}
              data-option="__all__"
            >
              <CheckBox checked={value.length === 0} />
              {allLabel}
            </div>
            {sections.map((section, si) => {
              const items = section.items.map((o) => {
                const checked = selectedSet.has(o.value);
                return (
                  <div
                    key={o.value}
                    role="option"
                    aria-selected={checked}
                    tabIndex={-1}
                    title={o.title}
                    className={ROW}
                    onClick={() => toggle(o.value)}
                    onKeyDown={(e) => onRowKeyDown(e, () => toggle(o.value))}
                    data-option={o.value}
                  >
                    <CheckBox checked={checked} />
                    {o.icon}
                    <span className="min-w-0 truncate">{o.label}</span>
                  </div>
                );
              });
              if (section.group === undefined) {
                return (
                  <div key={`s${String(si)}`} role="group" aria-label={label} className="mt-1 border-t border-border pt-1">
                    {items}
                  </div>
                );
              }
              const headingId = `${id}-g${String(si)}`;
              return (
                <div
                  key={`s${String(si)}`}
                  role="group"
                  aria-labelledby={headingId}
                  className="mt-1 border-t border-border pt-1"
                >
                  <div
                    id={headingId}
                    className="px-2 pb-0.5 pt-1 text-2xs font-bold uppercase tracking-wider text-text-subtle"
                  >
                    {section.group}
                  </div>
                  {items}
                </div>
              );
            })}
          </div>
          {visible.length === 0 ? (
            <p className="px-2 py-1.5 text-xs text-text-muted" role="status">
              No matches
            </p>
          ) : null}
        </PopoverContent>
      </Popover>
    </div>
  );
}

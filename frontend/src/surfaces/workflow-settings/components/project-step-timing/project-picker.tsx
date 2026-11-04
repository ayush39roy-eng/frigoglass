import * as React from 'react';
import { Search } from 'lucide-react';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PriorityBandPill } from '@/components/shared/priority-band-pill';
import { cn } from '@/lib/utils';

import type { StepTimingProjectOption } from '../../hooks/use-step-timing-projects';

/**
 * P32-R04: searchable project combobox for the Workflow page's step timing.
 * Matches name, code, hub or status (case-insensitive). The list is bounded
 * (`MAX_RESULTS`) rather than virtualized: it never puts all ~236 projects in
 * the DOM — typing narrows it (the `search-picker.tsx` convention).
 */

const MAX_RESULTS = 50;

export function ProjectPicker({
  options,
  selectedId,
  onSelect,
  loading = false,
}: {
  options: readonly StepTimingProjectOption[];
  selectedId: string | null;
  onSelect: (option: StepTimingProjectOption) => void;
  loading?: boolean;
}): React.JSX.Element {
  const [query, setQuery] = React.useState('');
  const [open, setOpen] = React.useState(false);
  const [active, setActive] = React.useState(0);
  const inputId = React.useId();
  const listId = React.useId();
  const hintId = React.useId();

  const q = query.trim().toLowerCase();
  const all = React.useMemo(
    () =>
      q === ''
        ? options
        : options.filter((o) =>
            [o.name, o.code ?? '', o.hub, o.status ?? ''].some((v) => v.toLowerCase().includes(q)),
          ),
    [options, q],
  );
  const matches = all.slice(0, MAX_RESULTS);
  const shown = open && matches.length > 0;
  const selected = selectedId === null ? null : (options.find((o) => o.id === selectedId) ?? null);

  const choose = (option: StepTimingProjectOption) => {
    onSelect(option);
    setQuery('');
    setActive(0);
    setOpen(false);
  };

  return (
    <div className="relative w-full max-w-xl">
      <Label htmlFor={inputId} className="mb-1 block text-xs font-semibold text-text">
        Project
      </Label>
      <div className="relative">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-text-subtle" aria-hidden="true" />
        <Input
          id={inputId}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={shown}
          aria-controls={shown ? listId : undefined}
          aria-activedescendant={shown ? `${listId}-${String(active)}` : undefined}
          aria-describedby={hintId}
          className="pl-8"
          placeholder={
            loading ? 'Loading projects…' : selected ? `${selected.name} — type to pick another` : 'Search projects by name, code or hub'
          }
          value={query}
          disabled={loading && options.length === 0}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              if (!open) setOpen(true);
              else if (matches.length > 0) setActive((a) => (a + 1) % matches.length);
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              if (matches.length > 0) setActive((a) => (a - 1 + matches.length) % matches.length);
            } else if (e.key === 'Enter') {
              const m = shown ? matches[active] : undefined;
              if (m) {
                e.preventDefault();
                choose(m);
              }
            } else if (e.key === 'Escape') {
              if (open) e.preventDefault();
              setOpen(false);
            }
          }}
          data-testid="step-timing-project-picker"
        />
      </div>
      <p id={hintId} className="mt-1 text-2xs text-text-muted" aria-live="polite">
        {loading
          ? 'Loading projects…'
          : open && all.length > MAX_RESULTS
            ? `Showing ${String(MAX_RESULTS)} of ${String(all.length)} projects — type to narrow.`
            : open && all.length === 0
              ? 'No project matches.'
              : `${String(options.length)} projects in the current hub filter.`}
      </p>
      {shown ? (
        <ul
          id={listId}
          role="listbox"
          aria-label="Projects"
          className="absolute z-30 mt-1 max-h-72 w-full overflow-y-auto rounded-md border border-border bg-surface p-1 shadow-overlay"
        >
          {matches.map((m, i) => (
            <li
              key={m.id}
              id={`${listId}-${String(i)}`}
              role="option"
              aria-selected={m.id === selectedId}
              data-active={i === active || undefined}
              className={cn(
                'flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs',
                i === active ? 'bg-primary-subtle text-primary-subtle-fg' : 'text-text',
              )}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(m);
              }}
              onMouseEnter={() => setActive(i)}
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate font-medium">
                  {m.name}
                  {m.code ? <span className="ml-1 font-normal text-text-subtle tabular-nums">{m.code}</span> : null}
                </span>
                <span className="block truncate text-2xs text-text-muted">
                  {m.hub}
                  {m.status ? ` · ${m.status}` : ''}
                </span>
              </span>
              {m.priority ? <PriorityBandPill priority={m.priority} /> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

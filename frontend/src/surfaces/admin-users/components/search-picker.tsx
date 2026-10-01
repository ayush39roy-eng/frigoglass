import * as React from 'react';

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

/**
 * Small, accessible type-to-filter combobox — the Project Access tab's
 * project and user pickers (P10-T03). Deliberately NOT virtualized: results
 * only render once the query narrows them below a small cap, the same
 * bounded-by-search convention `comment-composer.tsx`'s `@mention` list
 * already uses in this codebase, rather than ever dumping all 236 projects
 * or every user into the DOM at once (CLAUDE.md: virtualize lists over 100
 * rows — here, never render that many to begin with).
 */
export interface SearchPickerOption {
  id: string;
  label: string;
  sublabel?: string | undefined;
}

export function SearchPicker({
  label,
  placeholder,
  options,
  onSelect,
  disabled = false,
  maxResults = 20,
}: {
  label: string;
  placeholder: string;
  options: SearchPickerOption[];
  onSelect: (option: SearchPickerOption) => void;
  disabled?: boolean;
  maxResults?: number;
}): React.JSX.Element {
  const [query, setQuery] = React.useState('');
  const [active, setActive] = React.useState(0);
  const inputId = React.useId();
  const listId = React.useId();

  const q = query.trim().toLowerCase();
  const matches =
    q === ''
      ? []
      : options
          .filter((o) => o.label.toLowerCase().includes(q) || o.sublabel?.toLowerCase().includes(q))
          .slice(0, maxResults);
  const open = matches.length > 0;

  const choose = (option: SearchPickerOption) => {
    onSelect(option);
    setQuery('');
    setActive(0);
  };

  return (
    <div className="relative">
      <Label htmlFor={inputId} className="sr-only">
        {label}
      </Label>
      <Input
        id={inputId}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open ? `${listId}-${String(active)}` : undefined}
        placeholder={placeholder}
        value={query}
        disabled={disabled}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={(e) => {
          if (!open) return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setActive((a) => (a + 1) % matches.length);
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActive((a) => (a - 1 + matches.length) % matches.length);
          } else if (e.key === 'Enter') {
            const m = matches[active];
            if (m) {
              e.preventDefault();
              choose(m);
            }
          } else if (e.key === 'Escape') {
            setQuery('');
          }
        }}
      />
      {open ? (
        <ul
          id={listId}
          role="listbox"
          aria-label={label}
          className="absolute z-20 mt-1 max-h-56 w-full overflow-y-auto rounded-md border border-border bg-surface p-1 shadow-overlay"
        >
          {matches.map((m, i) => (
            <li
              key={m.id}
              id={`${listId}-${String(i)}`}
              role="option"
              aria-selected={i === active}
              className={cn(
                'cursor-pointer rounded px-2 py-1.5 text-xs',
                i === active ? 'bg-primary-subtle text-primary-subtle-fg' : 'text-text',
              )}
              onMouseDown={(e) => {
                e.preventDefault();
                choose(m);
              }}
            >
              <span className="block font-medium">{m.label}</span>
              {m.sublabel ? <span className="block text-2xs text-text-subtle">{m.sublabel}</span> : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

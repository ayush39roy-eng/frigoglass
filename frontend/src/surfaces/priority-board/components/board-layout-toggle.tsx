import * as React from 'react';
import { LayoutGrid, List } from 'lucide-react';

import { cn } from '@/lib/utils';

import type { BoardLayout } from '../lib/board-layout';

/** P21-T05: Cards | List segmented control (`aria-pressed` buttons in a labelled group). */
export function BoardLayoutToggle({
  value,
  onChange,
}: {
  value: BoardLayout;
  onChange: (next: BoardLayout) => void;
}): React.JSX.Element {
  const options: { value: BoardLayout; label: string; icon: React.ReactNode }[] = [
    { value: 'cards', label: 'Cards', icon: <LayoutGrid className="size-3.5" aria-hidden="true" /> },
    { value: 'list', label: 'List', icon: <List className="size-3.5" aria-hidden="true" /> },
  ];
  return (
    <div
      role="group"
      aria-label="Board layout"
      className="inline-flex h-8 items-center gap-0.5 rounded-pill border border-border-strong bg-surface p-0.5"
      data-testid="board-layout-toggle"
    >
      {options.map((o) => {
        const on = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(o.value)}
            className={cn(
              'inline-flex h-7 items-center gap-1 rounded-pill px-2.5 text-xs font-medium',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              on ? 'bg-primary text-primary-fg' : 'text-text-muted hover:bg-surface-raised hover:text-text',
            )}
          >
            {o.icon}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

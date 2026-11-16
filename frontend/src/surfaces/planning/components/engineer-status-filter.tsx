import * as React from 'react';

import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

import type { EngineerStatusFilter } from '../api/types';

/**
 * P38-T06 (ADR 0053 §6): the roster's Show filter. Active is the default, so
 * inactive engineers are hidden until the user asks for them. The value is the
 * `GET /engineers?status=` the server filters on; nothing is filtered here.
 */
const PILL = 'gap-0.5 divide-x-0 rounded-pill border-border bg-surface-sunken p-0.5';
const PILL_ITEM = 'rounded-pill data-[state=on]:shadow-sm';

export function EngineerStatusFilterControl({
  value,
  onChange,
  idSuffix,
}: {
  value: EngineerStatusFilter;
  onChange: (next: EngineerStatusFilter) => void;
  /** Distinguishes the Overview and Engineers-tab copies for tests. */
  idSuffix: string;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-1.5" data-testid={`engineer-status-filter-${idSuffix}`}>
      <span className="text-2xs font-semibold text-text-muted" aria-hidden="true">
        Show
      </span>
      <ToggleGroup
        type="single"
        value={value}
        onValueChange={(v) => {
          if (v === 'active' || v === 'inactive' || v === 'all') onChange(v);
        }}
        aria-label="Show engineers"
        size="sm"
        className={PILL}
      >
        <ToggleGroupItem value="active" className={PILL_ITEM}>
          Active
        </ToggleGroupItem>
        <ToggleGroupItem value="inactive" className={PILL_ITEM}>
          Inactive
        </ToggleGroupItem>
        <ToggleGroupItem value="all" className={PILL_ITEM}>
          All
        </ToggleGroupItem>
      </ToggleGroup>
    </div>
  );
}

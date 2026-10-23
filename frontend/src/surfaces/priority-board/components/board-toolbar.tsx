import * as React from 'react';
import { FilterX, Search } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { MultiChipFilter } from '@/components/shared/multi-chip-filter';
import { CATEGORY_CHIP_OPTIONS, TYPE_CHIP_OPTIONS } from '@/lib/multi-select-filter';
import { UI_PROJECT_STATUSES } from '@/types/enums';

import {
  ALL,
  EMPTY_TOOLBAR,
  SEARCH_MAX,
  leaderOptionLabel,
  type BoardToolbarState,
  type LeaderOption,
} from '../lib/toolbar-state';

/**
 * P13-T12 (API_CONTRACT_P13 §6): the Priority board's toolbar — a search box
 * and Category / Type / Status / Leader filters (P31: Category and Type are
 * multi-select chip rows; inside the Matrix they live in its View panel). Every value is sent to
 * `GET /priority-board`; nothing is filtered in the browser, and the column
 * counts and D/L weeks are the server's for the filtered set. Hub and country
 * are the global header filter, so they are not repeated here.
 */

function ToolbarSelect({
  label,
  value,
  onChange,
  options,
  disabled,
  compact = false,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  options: { value: string; label: string }[];
  disabled?: boolean;
  compact?: boolean;
}): React.JSX.Element {
  const id = React.useId();
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id} className={cn('text-2xs text-text-muted', compact && 'sr-only')}>
        {label}
      </Label>
      <Select value={value} onValueChange={onChange} disabled={disabled ?? false}>
        <SelectTrigger id={id} className="h-8 w-40 rounded-pill">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>All</SelectItem>
          {options.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              {opt.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

export interface BoardToolbarProps {
  value: BoardToolbarState;
  onChange: (next: BoardToolbarState) => void;
  /** Leader options from the served facets; `null` hides the Leader filter
   *  (e.g. the caller cannot read the facets). */
  leaders: LeaderOption[] | null;
  /** P21-T05: inside the Prioritization Matrix, Category / Type / Status come
   *  from the shared View panel, so only Search and Leader are shown here. */
  embedded?: boolean;
  /** P21-T05: the Cards | List layout control, shown at the end of the toolbar. */
  layoutToggle?: React.ReactNode;
  /** Rendered inside the Matrix View panel (no bottom margin, no growth). */
  inPanel?: boolean;
  /** The panel is stuck: visible labels hidden (kept for screen readers). */
  compact?: boolean;
}

export function BoardToolbar({
  value,
  onChange,
  leaders,
  embedded = false,
  layoutToggle,
  inPanel = false,
  compact = false,
}: BoardToolbarProps): React.JSX.Element {
  const searchId = React.useId();
  const set = (key: 'search' | 'status_' | 'leader') => (next: string) => onChange({ ...value, [key]: next });
  const active =
    value.search.trim() !== '' ||
    (!embedded && (value.category.length > 0 || value.type.length > 0 || value.status_ !== ALL)) ||
    value.leader !== ALL;

  return (
    <div role="search" aria-label="Filter the priority board" className={cn('flex flex-wrap items-end gap-3', !inPanel && 'mb-3')} data-testid="board-toolbar" data-in-panel={inPanel ? 'true' : undefined}>
      <div className={cn('flex flex-col gap-1', compact ? 'w-44' : 'min-w-[12rem] flex-1 sm:max-w-xs')}>
        <Label htmlFor={searchId} className={cn('text-2xs text-text-muted', compact && 'sr-only')}>
          Search
        </Label>
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-3 top-1/2 size-3.5 -translate-y-1/2 text-text-subtle"
            aria-hidden="true"
          />
          <Input
            id={searchId}
            type="search"
            value={value.search}
            maxLength={SEARCH_MAX}
            onChange={(e) => set('search')(e.target.value)}
            placeholder="Project name or code"
            className="h-8 rounded-pill pl-8"
          />
        </div>
      </div>
      {embedded ? null : (
        <>
          <ToolbarSelect
            label="Status"
            value={value.status_}
            onChange={set('status_')}
            options={UI_PROJECT_STATUSES.map((s) => ({ value: s, label: s }))}
          />
          {/* P31: multi-select category / type "tabs" (repeated server params). */}
          <div className="order-last flex w-full flex-col gap-2" data-testid="board-chip-filters">
            <MultiChipFilter
              label="Category"
              options={CATEGORY_CHIP_OPTIONS}
              value={value.category}
              onChange={(next) => onChange({ ...value, category: next })}
              data-testid="board-category-chips"
            />
            <MultiChipFilter
              label="Type"
              options={TYPE_CHIP_OPTIONS}
              value={value.type}
              onChange={(next) => onChange({ ...value, type: next })}
              data-testid="board-type-chips"
            />
          </div>
        </>
      )}
      {leaders ? (
        <ToolbarSelect
          compact={compact}
          label="Leader"
          value={value.leader}
          onChange={set('leader')}
          options={leaders.map((l) => ({ value: l.id, label: leaderOptionLabel(l) }))}
        />
      ) : null}
      {active ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onChange(embedded ? { ...value, search: '', leader: ALL } : EMPTY_TOOLBAR)}
        >
          <FilterX />
          Clear filters
        </Button>
      ) : null}
      {layoutToggle ? <div className={cn(!inPanel && 'ml-auto')}>{layoutToggle}</div> : null}
    </div>
  );
}

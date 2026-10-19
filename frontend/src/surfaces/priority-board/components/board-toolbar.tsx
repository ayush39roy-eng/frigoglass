import * as React from 'react';
import { FilterX, Search } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { PROJECT_CATEGORIES, PROJECT_STATUSES, PROJECT_TYPE_LABELS, PROJECT_TYPES } from '@/types/enums';

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
 * and Category / Type / Status / Leader filters. Every value is sent to
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
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  options: { value: string; label: string }[];
  disabled?: boolean;
}): React.JSX.Element {
  const id = React.useId();
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id} className="text-2xs text-text-muted">
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
}

export function BoardToolbar({ value, onChange, leaders }: BoardToolbarProps): React.JSX.Element {
  const searchId = React.useId();
  const set = (key: keyof BoardToolbarState) => (next: string) => onChange({ ...value, [key]: next });
  const active =
    value.search.trim() !== '' ||
    value.category !== ALL ||
    value.type !== ALL ||
    value.status_ !== ALL ||
    value.leader !== ALL;

  return (
    <div role="search" aria-label="Filter the priority board" className="mb-3 flex flex-wrap items-end gap-3" data-testid="board-toolbar">
      <div className="flex min-w-[12rem] flex-1 flex-col gap-1 sm:max-w-xs">
        <Label htmlFor={searchId} className="text-2xs text-text-muted">
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
      <ToolbarSelect
        label="Category"
        value={value.category}
        onChange={set('category')}
        options={PROJECT_CATEGORIES.map((c) => ({ value: c, label: c }))}
      />
      <ToolbarSelect
        label="Type"
        value={value.type}
        onChange={set('type')}
        options={PROJECT_TYPES.map((t) => ({ value: t, label: `${t} · ${PROJECT_TYPE_LABELS[t]}` }))}
      />
      <ToolbarSelect
        label="Status"
        value={value.status_}
        onChange={set('status_')}
        options={PROJECT_STATUSES.map((s) => ({ value: s, label: s }))}
      />
      {leaders ? (
        <ToolbarSelect
          label="Leader"
          value={value.leader}
          onChange={set('leader')}
          options={leaders.map((l) => ({ value: l.id, label: leaderOptionLabel(l) }))}
        />
      ) : null}
      {active ? (
        <Button variant="ghost" size="sm" onClick={() => onChange(EMPTY_TOOLBAR)}>
          <FilterX />
          Clear filters
        </Button>
      ) : null}
    </div>
  );
}

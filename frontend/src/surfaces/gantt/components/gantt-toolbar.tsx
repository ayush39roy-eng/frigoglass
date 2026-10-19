import * as React from 'react';
import { BarChart3, FilterX, Search, Trees } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  PROJECT_CATEGORIES,
  PROJECT_STATUSES,
  PROJECT_TYPES,
  PROJECT_TYPE_LABELS,
  type ProjectCategory,
  type ProjectPriority,
  type ProjectStatus,
  type ProjectType,
} from '@/types/enums';

import type { GanttFacets, GanttSort } from '../api/types';
import {
  ALL,
  DEFAULT_GANTT_FILTERS,
  SEARCH_MAX_LENGTH,
  hasActiveFilters,
  type GanttFilterState,
} from '../lib/gantt-filters';

/**
 * P13-T13 Gantt toolbar (API_CONTRACT_P13 §7; mock-up image 12): search,
 * Category / Type / Status / Leader / Step filters, sort, P1–P4 / Queue tabs.
 * Every filter is a SERVER param — this component only edits the filter state;
 * it never narrows rows itself.
 */

const SORT_LABELS: Record<GanttSort, string> = {
  priority: 'Priority (high to low)',
  name: 'Project name',
  start: 'Start week',
  end: 'End week',
};

const PRIORITY_TABS: { value: ProjectPriority; label: string }[] = [
  { value: 'P1', label: 'P1' },
  { value: 'P2', label: 'P2' },
  { value: 'P3', label: 'P3' },
  { value: 'P4', label: 'P4' },
  { value: 'Q', label: 'In Queue' },
];

/** ADR 0028: names are served; an id with no name is labelled as such. */
function leaderLabel(leader: { id: string; name: string | null }): string {
  return leader.name ?? `Leader (name unavailable) · ${leader.id.slice(-4)}`;
}

function ToolbarSelect({
  label,
  value,
  onChange,
  options,
  allLabel,
  className,
}: {
  label: string;
  value: string | null;
  onChange: (next: string | null) => void;
  options: readonly { value: string; label: string }[];
  allLabel: string;
  className?: string;
}): React.JSX.Element {
  const id = React.useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-2xs text-text-muted">
        {label}
      </label>
      <Select value={value ?? ALL} onValueChange={(next) => onChange(next === ALL ? null : next)}>
        <SelectTrigger id={id} className={className ?? 'h-8 w-36'} aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={ALL}>{allLabel}</SelectItem>
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

export interface GanttToolbarProps {
  filters: GanttFilterState;
  onChange: (next: GanttFilterState) => void;
  /** Leader / Step options from the served facets; `undefined` (no dashboard
   *  read, or still loading) hides those two filters. */
  facets: GanttFacets | undefined;
}

export function GanttFilterBar({ filters, onChange, facets }: GanttToolbarProps): React.JSX.Element {
  const searchId = React.useId();
  const set = <K extends keyof GanttFilterState>(key: K, value: GanttFilterState[K]): void =>
    onChange({ ...filters, [key]: value });

  return (
    <div className="flex flex-wrap items-end gap-3" data-testid="gantt-filter-bar">
      <div className="flex flex-col gap-1">
        <label htmlFor={searchId} className="text-2xs text-text-muted">
          Search
        </label>
        <div className="relative">
          <Search
            className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-text-subtle"
            aria-hidden="true"
          />
          <Input
            id={searchId}
            type="search"
            value={filters.q}
            maxLength={SEARCH_MAX_LENGTH}
            placeholder="Project name or code"
            onChange={(e) => set('q', e.currentTarget.value)}
            className="h-8 w-52 pl-7 text-xs"
          />
        </div>
      </div>
      <ToolbarSelect
        label="Category"
        allLabel="All categories"
        value={filters.category}
        onChange={(v) => set('category', v as ProjectCategory | null)}
        options={PROJECT_CATEGORIES.map((c) => ({ value: c, label: c }))}
        className="h-8 w-32"
      />
      <ToolbarSelect
        label="Type"
        allLabel="All types"
        value={filters.type}
        onChange={(v) => set('type', v as ProjectType | null)}
        options={PROJECT_TYPES.map((t) => ({ value: t, label: `${t} — ${PROJECT_TYPE_LABELS[t]}` }))}
        className="h-8 w-32"
      />
      <ToolbarSelect
        label="Status"
        allLabel="All statuses"
        value={filters.status}
        onChange={(v) => set('status', v as ProjectStatus | null)}
        options={PROJECT_STATUSES.map((s) => ({ value: s, label: s }))}
        className="h-8 w-40"
      />
      {facets ? (
        <>
          <ToolbarSelect
            label="Leader"
            allLabel="All leaders"
            value={filters.leaderEngineerId}
            onChange={(v) => set('leaderEngineerId', v)}
            options={facets.leaders.map((l) => ({ value: l.id, label: leaderLabel(l) }))}
            className="h-8 w-44"
          />
          <ToolbarSelect
            label="Current step"
            allLabel="All steps"
            value={filters.currentStep}
            onChange={(v) => set('currentStep', v)}
            options={facets.steps.map((s) => ({ value: s.code, label: `${s.code} · ${s.name}` }))}
            className="h-8 w-48"
          />
        </>
      ) : null}
      <ToolbarSelect
        label="Sort"
        allLabel={SORT_LABELS.priority}
        value={filters.sort === 'priority' ? null : filters.sort}
        onChange={(v) => set('sort', (v ?? 'priority') as GanttSort)}
        options={(['name', 'start', 'end'] as const).map((s) => ({ value: s, label: SORT_LABELS[s] }))}
        className="h-8 w-44"
      />
      {hasActiveFilters(filters) ? (
        <Button
          variant="ghost"
          size="sm"
          onClick={() => onChange({ ...DEFAULT_GANTT_FILTERS, sort: filters.sort })}
        >
          <FilterX aria-hidden="true" />
          Clear filters
        </Button>
      ) : null}
    </div>
  );
}

/** The P1–P4 / In Queue tabs (`priority` server param; "All" sends none). */
export function PriorityTabs({
  value,
  onChange,
}: {
  value: ProjectPriority | null;
  onChange: (next: ProjectPriority | null) => void;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-2xs text-text-muted" id="gantt-priority-tabs-label">
        Priority
      </span>
      <ToggleGroup
        type="single"
        size="sm"
        aria-labelledby="gantt-priority-tabs-label"
        value={value ?? ALL}
        onValueChange={(next) => {
          // Radix emits "" on re-click of the active item: keep a selection.
          if (next === '') return;
          onChange(next === ALL ? null : (next as ProjectPriority));
        }}
      >
        <ToggleGroupItem value={ALL}>All</ToggleGroupItem>
        {PRIORITY_TABS.map((t) => (
          <ToggleGroupItem key={t.value} value={t.value}>
            {t.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

/** Forest (compact) view and Hide stats — pressed-state toggles. */
export function ViewToggles({
  forest,
  onForestChange,
  hideStats,
  onHideStatsChange,
}: {
  forest: boolean;
  onForestChange: (next: boolean) => void;
  hideStats: boolean;
  onHideStatsChange: (next: boolean) => void;
}): React.JSX.Element {
  return (
    <div className="flex items-end gap-1">
      <Button
        type="button"
        variant={forest ? 'primary' : 'secondary'}
        size="sm"
        aria-pressed={forest}
        onClick={() => onForestChange(!forest)}
        title="Compact rows: one line per project"
      >
        <Trees aria-hidden="true" />
        Forest view
      </Button>
      <Button
        type="button"
        variant={hideStats ? 'primary' : 'secondary'}
        size="sm"
        aria-pressed={hideStats}
        onClick={() => onHideStatsChange(!hideStats)}
        title="Hide the summary and the weekly PDD / OEM counts"
      >
        <BarChart3 aria-hidden="true" />
        Hide stats
      </Button>
    </div>
  );
}

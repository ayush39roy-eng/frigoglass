import { priorityBandName } from '@/components/shared/priority-band-meta';
import * as React from 'react';
import { BarChart3, ChevronsDownUp, ChevronsUpDown, FilterX, Search, Trees } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { MultiSelectDropdown } from '@/components/shared/multi-select-dropdown';
import { HubFilterSelect } from '@/components/shared/hub-filter/hub-filter-select';
import { TYPE_CHIP_OPTIONS, useCategoryChipOptions } from '@/lib/multi-select-filter';
import {
  UI_PROJECT_STATUSES,
  type ProjectCategory,
  type ProjectPriority,
  type ProjectStatus,
  type ProjectType,
} from '@/types/enums';

import type { GanttFacets, GanttSort } from '../api/types';
import { SEARCH_MAX_LENGTH, type GanttFilterState } from '../lib/gantt-filters';
import { stepColor } from '../lib/step-colors';

/**
 * The Timeline toolbar. P40-T01 (owner ask 2026-11-17): ONE compact row —
 * Search, then the multi-select dropdowns Hub, Category, Type, Status, Leader,
 * Step and Priority, then Sort, Forest view, Expand / Collapse, the legend &
 * stats toggle and Download. The field names are kept for screen readers (each
 * dropdown's accessible name is its label) while the trigger shows the
 * selection ("All statuses", "2 statuses"), so the row needs no label line.
 *
 * Every filter is a SERVER param (repeated, ORed within a filter, ANDed
 * across): this component only edits the filter state, it never narrows rows.
 * Hub is the global hub / country filter (ADR 0020 / 0025), the same store as
 * the header's.
 */

const SORT_LABELS: Record<GanttSort, string> = {
  priority: 'Priority (high to low)',
  name: 'Project name',
  start: 'Start week',
  end: 'End week',
};

const PRIORITY_OPTIONS: { value: ProjectPriority; label: string }[] = [
  { value: 'P1', label: 'P1' },
  { value: 'P2', label: 'P2' },
  { value: 'P3', label: 'P3' },
  { value: 'P4', label: 'P4' },
  { value: 'Q', label: priorityBandName('Q') },
];

const STATUS_OPTIONS = UI_PROJECT_STATUSES.map((s) => ({ value: s, label: s }));

/** ADR 0028: names are served; an id with no name is labelled as such. */
function leaderLabel(leader: { id: string; name: string | null }): string {
  return leader.name ?? `Leader (name unavailable) · ${leader.id.slice(-4)}`;
}

/** A small step-colour swatch in the Step options (P40-T01). */
function StepSwatch({ code }: { code: string }): React.JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="size-2.5 shrink-0 rounded-sm"
      style={{ background: stepColor(code).fill }}
    />
  );
}

const TRIGGER = 'h-7 w-[5.5rem] px-2';

export interface GanttToolbarProps {
  filters: GanttFilterState;
  onChange: (next: GanttFilterState) => void;
  /** Leader / Step options from the served facets; `undefined` (no dashboard
   *  read, or still loading) hides those two filters. */
  facets: GanttFacets | undefined;
  /** True when any toolbar filter OR the hub selection is set. */
  anyActive: boolean;
  /** Clears every toolbar filter and the hub selection; keeps the sort. */
  onClearAll: () => void;
}

export function GanttFilterBar({
  filters,
  onChange,
  facets,
  anyActive,
  onClearAll,
}: GanttToolbarProps): React.JSX.Element {
  const categoryOptions = useCategoryChipOptions();
  const searchId = React.useId();
  const sortId = React.useId();
  const set = <K extends keyof GanttFilterState>(key: K, value: GanttFilterState[K]): void =>
    onChange({ ...filters, [key]: value });

  return (
    <div className="contents" data-testid="gantt-filter-bar">
      <div className="relative">
        <label htmlFor={searchId} className="sr-only">
          Search
        </label>
        <Search
          className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-text-subtle"
          aria-hidden="true"
        />
        <Input
          id={searchId}
          type="search"
          value={filters.q}
          maxLength={SEARCH_MAX_LENGTH}
          placeholder="Search"
          onChange={(e) => set('q', e.currentTarget.value)}
          className="h-7 w-32 pl-7 text-xs"
        />
      </div>
      <HubFilterSelect variant="toolbar" />
      <MultiSelectDropdown<ProjectCategory>
        label="Category"
        hideLabel
        emptySummary="Category"
        allLabel="All categories"
        value={filters.category}
        onChange={(v) => set('category', v)}
        options={categoryOptions.map((o) => ({ value: o.value as ProjectCategory, label: o.label, title: o.title }))}
        triggerClassName="h-7 w-24 px-2"
        data-testid="gantt-category-filter"
      />
      <MultiSelectDropdown<ProjectType>
        label="Type"
        hideLabel
        emptySummary="Type"
        allLabel="All types"
        value={filters.type}
        onChange={(v) => set('type', v)}
        options={TYPE_CHIP_OPTIONS.map((o) => ({ value: o.value, label: o.label, title: o.title }))}
        summarize={(sel) => (sel.length === 1 ? (sel[0]?.value ?? '') : `${String(sel.length)} types`)}
        triggerClassName={TRIGGER}
        data-testid="gantt-type-filter"
      />
      <MultiSelectDropdown<ProjectStatus>
        label="Status"
        hideLabel
        emptySummary="Status"
        allLabel="All statuses"
        value={filters.status}
        onChange={(v) => set('status', v)}
        options={STATUS_OPTIONS}
        triggerClassName={TRIGGER}
        data-testid="gantt-status-filter"
      />
      {facets ? (
        <>
          <MultiSelectDropdown
            label="Leader"
            hideLabel
            emptySummary="Leader"
            allLabel="All leaders"
            value={filters.leaderEngineerId}
            onChange={(v) => set('leaderEngineerId', v)}
            options={facets.leaders.map((l) => ({ value: l.id, label: leaderLabel(l) }))}
            triggerClassName={TRIGGER}
            data-testid="gantt-leader-filter"
          />
          <MultiSelectDropdown
            label="Current step"
            hideLabel
            emptySummary="Step"
            allLabel="All steps"
            value={filters.currentStep}
            onChange={(v) => set('currentStep', v)}
            options={facets.steps.map((s) => ({
              value: s.code,
              label: `${s.code} · ${s.name}`,
              icon: <StepSwatch code={s.code} />,
            }))}
            summarize={(sel) => (sel.length === 1 ? (sel[0]?.value ?? '') : `${String(sel.length)} steps`)}
            triggerClassName={TRIGGER}
            data-testid="gantt-step-filter"
          />
        </>
      ) : null}
      <MultiSelectDropdown<ProjectPriority>
        label="Priority"
        hideLabel
        emptySummary="Priority"
        allLabel="All priorities"
        value={filters.priority}
        onChange={(v) => set('priority', v)}
        options={PRIORITY_OPTIONS}
        summarize={(sel) => sel.map((o) => o.value).join(', ')}
        triggerClassName={TRIGGER}
        data-testid="gantt-priority-filter"
      />
      <label htmlFor={sortId} className="sr-only">
        Sort
      </label>
      <Select value={filters.sort} onValueChange={(next) => set('sort', next as GanttSort)}>
        <SelectTrigger id={sortId} className="h-7 w-28 text-xs" aria-label="Sort" title="Sort">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {(['priority', 'name', 'start', 'end'] as const).map((s) => (
            <SelectItem key={s} value={s}>
              {SORT_LABELS[s]}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {anyActive ? (
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 px-0 text-danger"
          onClick={onClearAll}
          aria-label="Clear filters"
          title="Clear all filters (search, hub and every dropdown)"
        >
          <FilterX aria-hidden="true" />
        </Button>
      ) : null}
    </div>
  );
}

/** Forest view, Expand / Collapse all and the legend & stats toggle —
 *  compact icon buttons, each with an accessible name and a tooltip. */
export function ViewToggles({
  forest,
  onForestChange,
  showDetails,
  onShowDetailsChange,
  onExpandAll,
  onCollapseAll,
  canExpand,
  canCollapse,
}: {
  forest: boolean;
  onForestChange: (next: boolean) => void;
  showDetails: boolean;
  onShowDetailsChange: (next: boolean) => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
  canExpand: boolean;
  canCollapse: boolean;
}): React.JSX.Element {
  return (
    <div className="flex items-center gap-1" role="group" aria-label="View">
      <Button
        type="button"
        variant={forest ? 'primary' : 'secondary'}
        size="sm"
        className="h-7 px-2"
        aria-pressed={forest}
        onClick={() => onForestChange(!forest)}
        title="Forest view: one thin line per project, names only"
        aria-label="Forest view"
      >
        <Trees aria-hidden="true" />
        Forest
      </Button>
      <Button
        variant="secondary"
        size="sm"
        className="h-7 w-7 px-0"
        onClick={onExpandAll}
        disabled={!canExpand}
        aria-label="Expand all"
        title={forest ? 'Expand all (not in Forest view)' : 'Expand all: show every step row'}
      >
        <ChevronsUpDown aria-hidden="true" />
      </Button>
      <Button
        variant="secondary"
        size="sm"
        className="h-7 w-7 px-0"
        onClick={onCollapseAll}
        disabled={!canCollapse}
        aria-label="Collapse all"
        title="Collapse all"
      >
        <ChevronsDownUp aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant={showDetails ? 'primary' : 'secondary'}
        size="sm"
        className="h-7 w-7 px-0"
        aria-pressed={showDetails}
        aria-label="Legend & stats"
        onClick={() => onShowDetailsChange(!showDetails)}
        title="Legend & stats: the summary, the step-colour legend and the weekly PDD / OEM counts"
      >
        <BarChart3 aria-hidden="true" />
      </Button>
    </div>
  );
}

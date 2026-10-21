import * as React from 'react';

import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { CURRENT_WEEK, WITHIN_YEAR_WEEK } from '@/lib/domain-constants';

import type { CapacityView } from '../lib/pick-figures';

/**
 * The client's two header toggles (P19-T01, Days enabled in P19-T05):
 *
 *   Weeks | Days         the unit every capacity and load figure is shown in
 *   YTD 2026 | Full year the horizon (served `*_remaining` vs `*_year` fields)
 *
 * Both are ONE view state owned by `CapacityPage` (`CapacityView`); this only
 * renders it, so all four combinations are just the two fields together. "YTD
 * 2026" is the client's label for the remaining-year figures (their id is
 * `from_today`): capacity from the current week to W52.
 *
 * Days shows the SERVED day fields (API_CONTRACT_P19 §1): the server multiplies
 * served weeks by each hub's (or lab region's) served working days per week.
 * The browser never multiplies (I19). Booked % is unit-free and unchanged.
 */
const PILL =
  'gap-0.5 divide-x-0 rounded-pill border-dash-hairline bg-dash-alt p-0.5';
const PILL_ITEM = 'rounded-pill data-[state=on]:shadow-sm';

export interface CapacityToolbarProps {
  view: CapacityView;
  onViewChange: (view: CapacityView) => void;
  disabled?: boolean;
}

export function CapacityToolbar({ view, onViewChange, disabled = false }: CapacityToolbarProps): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-s2" data-testid="capacity-toolbar">
      <ToggleGroup
        type="single"
        value={view.unit}
        onValueChange={(v) => {
          if (v === 'weeks' || v === 'days') onViewChange({ ...view, unit: v });
        }}
        disabled={disabled}
        aria-label="Display unit"
        size="sm"
        className={PILL}
      >
        <ToggleGroupItem value="weeks" className={PILL_ITEM} title="Show capacity and load in weeks">
          Weeks
        </ToggleGroupItem>
        <ToggleGroupItem
          value="days"
          className={PILL_ITEM}
          title="Show capacity and load in working days (served per hub calendar)"
          data-testid="capacity-days-toggle"
        >
          Days
        </ToggleGroupItem>
      </ToggleGroup>

      <ToggleGroup
        type="single"
        value={view.horizon}
        onValueChange={(v) => {
          if (v === 'year' || v === 'remaining') onViewChange({ ...view, horizon: v });
        }}
        disabled={disabled}
        aria-label="Capacity horizon"
        size="sm"
        className={PILL}
      >
        <ToggleGroupItem
          value="remaining"
          className={PILL_ITEM}
          title={`Remaining year: week ${String(CURRENT_WEEK)} to week ${String(WITHIN_YEAR_WEEK)}`}
        >
          YTD 2026
        </ToggleGroupItem>
        <ToggleGroupItem value="year" className={PILL_ITEM} title="Full year: weeks 1 to 52">
          Full year
        </ToggleGroupItem>
      </ToggleGroup>
    </div>
  );
}

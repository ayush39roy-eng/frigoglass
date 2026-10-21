import * as React from 'react';

import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { CURRENT_WEEK, WITHIN_YEAR_WEEK } from '@/lib/domain-constants';

import type { CapacityHorizon } from '../lib/pick-figures';

/**
 * The client's two header toggles (P19-T01, mock-up parity):
 *
 *   Weeks | Days         the unit every figure is shown in
 *   YTD 2026 | Full year the horizon (served `*_remaining` vs `*_year` fields)
 *
 * The horizon is the page's ONE source of truth (`CapacityPage` owns the state);
 * this only renders it. "YTD 2026" is the client's label for the remaining-year
 * figures (their id is `from_today`): capacity from the current week to W52.
 *
 * "Days" needs each hub's `weekdays_per_week` to turn weeks into days. The
 * capacity endpoint does not serve it (it lives on the hub work calendar, ADR
 * 0008), and a constant invented in the browser would break I19. So the toggle
 * is rendered but disabled with a tooltip, and the page shows weeks only. The
 * backend change that enables it is recorded in docs/MEMORY.md (P19-T01).
 */
const PILL =
  'gap-0.5 divide-x-0 rounded-pill border-dash-hairline bg-dash-alt p-0.5';
const PILL_ITEM = 'rounded-pill data-[state=on]:shadow-sm';

export interface CapacityToolbarProps {
  horizon: CapacityHorizon;
  onHorizonChange: (horizon: CapacityHorizon) => void;
  disabled?: boolean;
}

export function CapacityToolbar({ horizon, onHorizonChange, disabled = false }: CapacityToolbarProps): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-s2" data-testid="capacity-toolbar">
      <ToggleGroup type="single" value="weeks" aria-label="Display unit" size="sm" className={PILL}>
        <ToggleGroupItem value="weeks" className={PILL_ITEM}>
          Weeks
        </ToggleGroupItem>
        <Tooltip>
          <TooltipTrigger asChild>
            {/* aria-disabled (not `disabled`) keeps the item focusable, so the tooltip
                that explains why is reachable by keyboard. Selecting it does nothing:
                the group's value is fixed to "weeks". */}
            <ToggleGroupItem
              value="days"
              aria-disabled="true"
              className={`${PILL_ITEM} cursor-not-allowed opacity-60`}
              onClick={(e) => {
                e.preventDefault();
              }}
              data-testid="capacity-days-toggle"
            >
              Days
            </ToggleGroupItem>
          </TooltipTrigger>
          <TooltipContent>
            Days needs each hub&rsquo;s working days per week, which the capacity service does not serve yet. Figures are
            shown in weeks.
          </TooltipContent>
        </Tooltip>
      </ToggleGroup>

      <ToggleGroup
        type="single"
        value={horizon}
        onValueChange={(v) => {
          if (v === 'year' || v === 'remaining') onHorizonChange(v);
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

import * as React from 'react';
import { Play, Wand2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { CURRENT_WEEK, WITHIN_YEAR_WEEK } from '@/lib/domain-constants';

import type { CapacityBasis } from '../../api/types';
import type { CapacityUnit } from '../../lib/figures';

/**
 * Capacity Planning header actions (P19-T04, the client's header):
 * [YTD 2026 | Full year] picks the served `remaining` / `year` field,
 * [Weeks | Days] picks the served `capacity_weeks` / `capacity_days` field,
 * "Apply logic" and "Auto-assign projects" open their dialogs (the existing
 * Apply Logic panel and the OQ #10 Auto-assign notice).
 */
const PILL = 'gap-0.5 divide-x-0 rounded-pill border-border bg-surface-sunken p-0.5';
const PILL_ITEM = 'rounded-pill data-[state=on]:shadow-sm';

export interface PlanningToolbarProps {
  basis: CapacityBasis;
  onBasisChange: (basis: CapacityBasis) => void;
  unit: CapacityUnit;
  onUnitChange: (unit: CapacityUnit) => void;
  onApplyLogic: () => void;
  onAutoAssign: () => void;
}

export function PlanningToolbar({ basis, onBasisChange, unit, onUnitChange, onApplyLogic, onAutoAssign }: PlanningToolbarProps): React.JSX.Element {
  return (
    <div className="flex max-w-full flex-wrap items-center gap-2" data-testid="planning-toolbar">
      <ToggleGroup
        type="single"
        value={basis}
        onValueChange={(v) => {
          if (v === 'year' || v === 'remaining') onBasisChange(v);
        }}
        aria-label="Capacity basis"
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
      <ToggleGroup
        type="single"
        value={unit}
        onValueChange={(v) => {
          if (v === 'weeks' || v === 'days') onUnitChange(v);
        }}
        aria-label="Display unit"
        size="sm"
        className={PILL}
      >
        <ToggleGroupItem value="weeks" className={PILL_ITEM}>
          Weeks
        </ToggleGroupItem>
        <ToggleGroupItem value="days" className={PILL_ITEM} title="Days use each hub's working days per week (served)">
          Days
        </ToggleGroupItem>
      </ToggleGroup>
      <Button type="button" size="sm" onClick={onApplyLogic} aria-haspopup="dialog">
        <Play />
        Apply logic
      </Button>
      <Button type="button" size="sm" variant="secondary" onClick={onAutoAssign} aria-haspopup="dialog">
        <Wand2 />
        Auto-assign projects
      </Button>
    </div>
  );
}

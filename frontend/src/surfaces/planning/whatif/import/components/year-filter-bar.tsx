import * as React from 'react';
import { CalendarRange } from 'lucide-react';

import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

import { useImportPlan } from '../import-store';
import type { ImportSimulateResponse } from '../import-types';
import { useEffectiveYear } from '../use-year-filter';
import { yearOptions } from '../year-filter';

/**
 * The Results "Year" segmented filter (P32-R05 C2): All · 2026 · 2027 · After 2027 · Not
 * placed. One shared store key for the Executive, Gantt and Projects tabs.
 */
export function YearFilterBar({
  result,
}: {
  result: Pick<ImportSimulateResponse, 'base_year' | 'breakdowns'>;
}): React.JSX.Element {
  const setYear = useImportPlan((s) => s.setYearFilter);
  const value = useEffectiveYear(result);
  const options = React.useMemo(() => yearOptions(result), [result]);
  const labelId = React.useId();
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-s2" data-testid="import-year-filter">
      <span id={labelId} className="inline-flex items-center gap-1 text-2xs font-bold uppercase tracking-wider text-text-subtle">
        <CalendarRange className="size-3.5" aria-hidden="true" />
        Year
      </span>
      <ToggleGroup
        type="single"
        size="sm"
        value={value}
        onValueChange={(v) => {
          if (v) setYear(v);
        }}
        aria-labelledby={labelId}
        className="max-w-full flex-wrap"
      >
        {options.map((o) => (
          <ToggleGroupItem key={o.key} value={o.key} title={o.label} data-year={o.key}>
            {o.short}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  );
}

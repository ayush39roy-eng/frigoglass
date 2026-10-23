import * as React from 'react';
import { FilterX } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { MultiChipFilter } from '@/components/shared/multi-chip-filter';
import { CATEGORY_CHIP_OPTIONS_WITH_UNMAPPED, TYPE_CHIP_OPTIONS_WITH_UNMAPPED } from '@/lib/multi-select-filter';

import type { DashboardSelectionState } from '../lib/selection';

/**
 * P31: the Dashboard-wide category / type selection, always visible under the
 * header in both views, so it can be read and edited without the charts. The
 * donut slices and the register's chips edit the same URL state; every
 * Dashboard figure is re-served for it.
 */
export function DashboardSelectionBar({ selection }: { selection: DashboardSelectionState }): React.JSX.Element {
  return (
    <section
      aria-label="Dashboard filters: category and project type"
      className="mb-s5 flex flex-wrap items-start gap-x-s6 gap-y-s2 rounded-xl border border-dash-hairline bg-surface px-s4 py-s2 shadow-dashCard"
      data-testid="dashboard-selection-bar"
    >
      <MultiChipFilter
        label="Category"
        options={CATEGORY_CHIP_OPTIONS_WITH_UNMAPPED}
        value={selection.categories}
        onChange={selection.setCategories}
        data-testid="dashboard-category-chips"
      />
      <MultiChipFilter
        label="Type"
        options={TYPE_CHIP_OPTIONS_WITH_UNMAPPED}
        value={selection.types}
        onChange={selection.setTypes}
        data-testid="dashboard-type-chips"
      />
      {selection.active ? (
        <Button type="button" variant="ghost" size="sm" className="h-7" onClick={selection.clear}>
          <FilterX aria-hidden="true" />
          Clear
        </Button>
      ) : null}
    </section>
  );
}

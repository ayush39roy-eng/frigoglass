import * as React from 'react';
import { LayoutList, Telescope } from 'lucide-react';

import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { cn } from '@/lib/utils';

import { isDashboardView, type DashboardView } from '../../lib/view-mode';

/**
 * The Dashboard header's Executive | Detailed segmented control (P28, ADR 0039
 * §2) — the same pill ToggleGroup chrome as `CountrySegmented` beside it, so
 * the header reads as one family of controls. Radix `type="single"` gives the
 * radiogroup semantics (role=radiogroup / role=radio + aria-checked) and the
 * roving-tabindex keyboard behaviour; focus stays on the pressed item across a
 * view switch because the toggle itself never unmounts.
 */
export function DashboardViewToggle({
  view,
  onChange,
  className,
}: {
  view: DashboardView;
  onChange: (view: DashboardView) => void;
  className?: string;
}): React.JSX.Element {
  const onValueChange = (next: string): void => {
    // Radix lets a single-select group be emptied by re-clicking the active
    // item; keep the current choice instead (same guard as CountrySegmented).
    if (next === '' || !isDashboardView(next) || next === view) return;
    onChange(next);
  };

  return (
    <ToggleGroup
      type="single"
      value={view}
      onValueChange={onValueChange}
      aria-label="Dashboard view"
      data-testid="dashboard-view-toggle"
      className={cn(
        'h-9 max-w-full divide-x-0 overflow-x-auto rounded-pill border-[1.5px] border-dash-hairline bg-surface p-0.5 shadow-dashCard',
        className,
      )}
    >
      <ToggleGroupItem
        value="executive"
        data-testid="dashboard-view-executive"
        className="h-full rounded-pill px-s3 text-2xs font-semibold text-text-muted data-[state=on]:text-primary-fg"
      >
        <Telescope aria-hidden="true" />
        Executive
      </ToggleGroupItem>
      <ToggleGroupItem
        value="detailed"
        data-testid="dashboard-view-detailed"
        className="h-full rounded-pill px-s3 text-2xs font-semibold text-text-muted data-[state=on]:text-primary-fg"
      >
        <LayoutList aria-hidden="true" />
        Detailed
      </ToggleGroupItem>
    </ToggleGroup>
  );
}

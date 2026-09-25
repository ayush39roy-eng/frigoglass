import * as React from 'react';
import { CalendarRange, ZoomIn } from 'lucide-react';

import { Label } from '@/components/ui/label';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';

import type { GanttZoom } from '../lib/gantt-coordinates';

/**
 * Two zoom levels (`dataviz-gantt` SKILL): "weeks" (default, ~full horizon fits)
 * and "days" (wider, for inspecting step boundaries). Zoom is a pure
 * rendering-layer concern — it changes `weekWidthPx` only, never the data query.
 */
export function ZoomControl({
  value,
  onChange,
}: {
  value: GanttZoom;
  onChange: (next: GanttZoom) => void;
}): React.JSX.Element {
  const id = React.useId();
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id} className="text-2xs text-text-muted">
        Zoom
      </Label>
      <ToggleGroup
        id={id}
        type="single"
        size="sm"
        value={value}
        onValueChange={(next) => {
          if (next === 'weeks' || next === 'days') onChange(next);
        }}
      >
        <ToggleGroupItem value="weeks" aria-label="Weeks zoom">
          <CalendarRange />
          Weeks
        </ToggleGroupItem>
        <ToggleGroupItem value="days" aria-label="Days zoom">
          <ZoomIn />
          Days
        </ToggleGroupItem>
      </ToggleGroup>
    </div>
  );
}

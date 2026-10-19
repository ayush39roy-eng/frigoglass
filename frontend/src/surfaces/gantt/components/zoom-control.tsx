import * as React from 'react';
import { ZoomIn, ZoomOut } from 'lucide-react';

import { Button } from '@/components/ui/button';

import { ZOOM_MAX_PX, ZOOM_MIN_PX, ZOOM_STEP_PX, clampZoomPx } from '../lib/gantt-coordinates';

/**
 * P13-T13 (API_CONTRACT_P13 §7): a px zoom, 16–48 px per week, replacing the
 * two-level Weeks / Days toggle (the mock-up's "− 24px +"). Zoom is a pure
 * rendering-layer concern (`dataviz-gantt` SKILL) — it changes `weekWidthPx`
 * only, never the data query.
 */
export function ZoomControl({
  value,
  onChange,
}: {
  value: number;
  onChange: (next: number) => void;
}): React.JSX.Element {
  const id = React.useId();
  const px = clampZoomPx(value);
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-2xs text-text-muted">
        Zoom
      </label>
      <div className="flex h-8 items-center gap-1 rounded-md border border-border bg-surface px-1">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-6"
          aria-label="Zoom out"
          disabled={px <= ZOOM_MIN_PX}
          onClick={() => onChange(clampZoomPx(px - ZOOM_STEP_PX))}
        >
          <ZoomOut aria-hidden="true" />
        </Button>
        <input
          id={id}
          type="range"
          min={ZOOM_MIN_PX}
          max={ZOOM_MAX_PX}
          step={ZOOM_STEP_PX}
          value={px}
          aria-valuetext={`${String(px)} pixels per week`}
          onChange={(e) => onChange(clampZoomPx(Number(e.currentTarget.value)))}
          className="h-1 w-24 cursor-pointer accent-primary"
        />
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-6"
          aria-label="Zoom in"
          disabled={px >= ZOOM_MAX_PX}
          onClick={() => onChange(clampZoomPx(px + ZOOM_STEP_PX))}
        >
          <ZoomIn aria-hidden="true" />
        </Button>
        <span className="tnum w-9 text-right text-2xs font-semibold text-text" aria-hidden="true">
          {px}px
        </span>
      </div>
    </div>
  );
}

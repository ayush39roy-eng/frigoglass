import * as React from 'react';

import { formatPlanWeek } from '@/lib/format';

import { barGeometry, type WeekScale } from '../lib/gantt-coordinates';

/**
 * P40-T03c (ADR 0054): the "Pinned" mark on a bar segment the active run placed
 * on typed weeks (served `step.pinned`). A small diamond on the segment's start
 * edge, in the text colour with a surface ring so it reads on every step
 * colour; the hover title names it. Geometry is `barGeometry` of the served
 * planned weeks — nothing is derived.
 */
export function PinnedSegmentMarker({
  startWeek,
  endWeek,
  scale,
  cy,
  size = 4,
  fmt = formatPlanWeek,
}: {
  startWeek: number | null;
  endWeek: number | null;
  scale: WeekScale;
  /** Vertical centre, px (the bar's middle). */
  cy: number;
  /** Half the diagonal, px. */
  size?: number;
  fmt?: ((week: number) => string) | undefined;
}): React.JSX.Element | null {
  const geom = barGeometry(startWeek, endWeek, scale);
  if (!geom || startWeek == null || endWeek == null) return null;
  const cx = geom.x + Math.min(size + 1, geom.width / 2);
  return (
    <g data-testid="gantt-pin-marker">
      <title>{`Pinned: typed weeks ${fmt(startWeek)}–${fmt(endWeek)}`}</title>
      <path
        d={`M ${String(cx)} ${String(cy - size)} L ${String(cx + size)} ${String(cy)} L ${String(cx)} ${String(
          cy + size,
        )} L ${String(cx - size)} ${String(cy)} Z`}
        fill="hsl(var(--color-text))"
        stroke="hsl(var(--color-surface))"
        strokeWidth={1.25}
      />
    </g>
  );
}

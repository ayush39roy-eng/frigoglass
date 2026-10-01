import * as React from 'react';

import type { WorkflowStepKind } from '@/types/enums';

import {
  barGeometry,
  delayConnectorGeometry,
  type WeekScale,
} from '../lib/gantt-coordinates';

/**
 * Domain component (`frontend-builder` SKILL — never sourced externally): the
 * Gantt bar set for one row.
 *
 * - **Solid bar** = planned (`planned_start_week` / `planned_end_week` from the
 *   active `ScheduleRun` snapshot).
 * - **Hatched bar** (45° SVG `<pattern>`) = actual + delay (`actual_*_week` from
 *   the live `ProjectWorkflowStep`, or the delayed project span).
 * - **Red connector** = delay magnitude, drawn from the planned end edge to the
 *   delayed end edge. The one place red shows a magnitude, not a status.
 *
 * - **Hollow bar** (P9, ADR 0007) = an `elapsed` step: books nobody, occupies
 *   calendar weeks. Outlined in the planned colour with a light, hatch-free
 *   fill so it reads as "time passes here" rather than "someone is booked".
 * - **No bar at all** = a `skipped` step (0-week lead time, or a lab step on
 *   a project without certification testing) — it occupies nothing.
 *
 * Every x / width here is `barGeometry(...)` / `delayConnectorGeometry(...)` of
 * server week numbers mapped through the week→pixel `scale`. No position is ever
 * computed by summing `duration_weeks`.
 */

export const GANTT_HATCH_PATTERN_ID = 'gantt-hatch-pattern';

export function GanttHatchDefs(): React.JSX.Element {
  return (
    <defs>
      <pattern
        id={GANTT_HATCH_PATTERN_ID}
        patternUnits="userSpaceOnUse"
        width={5}
        height={5}
        patternTransform="rotate(45)"
      >
        <rect width={5} height={5} fill="hsl(var(--color-gantt-actual) / 0.35)" />
        <line
          x1={0}
          y1={0}
          x2={0}
          y2={5}
          stroke="hsl(var(--color-gantt-actual-hatch))"
          strokeWidth={1.4}
        />
      </pattern>
    </defs>
  );
}

export interface GanttBarGroupProps {
  scale: WeekScale;
  /** Row top in px (within the timeline content coordinate space). */
  y: number;
  /** Row height in px. */
  rowHeight: number;
  planned: { startWeek: number; endWeek: number } | null;
  actual: { startWeek: number; endWeek: number } | null;
  /** Delayed end week (planned end + delay, or actual end). Drives the connector. */
  plannedEndWeek: number | null;
  delayedEndWeek: number | null;
  frozen: boolean;
  /** Accessible description shown as an SVG `<title>` on hover / to AT. */
  title: string;
  /** Slightly thinner bars for the compact step rows. */
  compact?: boolean;
  /** Step kind (ADR 0007) — `elapsed` renders hollow. Project rows omit it. */
  kind?: WorkflowStepKind | undefined;
  /** A skipped step renders no bar at all. */
  skipped?: boolean | undefined;
}

export function GanttBarGroup({
  scale,
  y,
  rowHeight,
  planned,
  actual,
  plannedEndWeek,
  delayedEndWeek,
  frozen,
  title,
  compact = false,
  kind,
  skipped = false,
}: GanttBarGroupProps): React.JSX.Element | null {
  if (skipped) return null;
  const elapsed = kind === 'elapsed';
  const plannedGeom = planned ? barGeometry(planned.startWeek, planned.endWeek, scale) : null;
  const actualGeom = actual ? barGeometry(actual.startWeek, actual.endWeek, scale) : null;
  const connector = delayConnectorGeometry(plannedEndWeek, delayedEndWeek, scale);

  if (!plannedGeom && !actualGeom) return null;

  const barH = compact ? 10 : 16;
  const plannedY = y + (rowHeight - barH) / 2 - (actualGeom ? 3 : 0);
  const actualY = y + (rowHeight - barH) / 2 + (plannedGeom ? 4 : 0);
  const connectorY = y + rowHeight / 2;

  return (
    <g>
      <title>{title}</title>
      {plannedGeom ? (
        <rect
          x={plannedGeom.x}
          y={plannedY}
          width={plannedGeom.width}
          height={barH}
          rx={2}
          data-bar={elapsed ? 'elapsed' : 'planned'}
          fill={
            elapsed
              ? 'hsl(var(--color-gantt-planned) / 0.12)'
              : frozen
                ? 'hsl(var(--color-gantt-planned-frozen))'
                : 'hsl(var(--color-gantt-planned))'
          }
          stroke={
            elapsed
              ? 'hsl(var(--color-gantt-planned))'
              : frozen
                ? 'hsl(var(--color-gantt-planned))'
                : 'none'
          }
          strokeWidth={elapsed || frozen ? 1.5 : 0}
          strokeDasharray={frozen ? '3 2' : undefined}
        />
      ) : null}
      {actualGeom ? (
        <rect
          x={actualGeom.x}
          y={actualY}
          width={actualGeom.width}
          height={barH}
          rx={2}
          fill={`url(#${GANTT_HATCH_PATTERN_ID})`}
          stroke="hsl(var(--color-gantt-actual-hatch))"
          strokeWidth={1}
        />
      ) : null}
      {connector ? (
        <g>
          <line
            x1={connector.x}
            y1={connectorY}
            x2={connector.x + connector.width}
            y2={connectorY}
            stroke="hsl(var(--color-gantt-delay))"
            strokeWidth={2}
          />
          <path
            d={`M ${String(connector.x + connector.width - 5)} ${String(connectorY - 3)} L ${String(
              connector.x + connector.width,
            )} ${String(connectorY)} L ${String(connector.x + connector.width - 5)} ${String(
              connectorY + 3,
            )} Z`}
            fill="hsl(var(--color-gantt-delay))"
          />
        </g>
      ) : null}
    </g>
  );
}

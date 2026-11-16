import * as React from 'react';

import { formatPlanWeek } from '@/lib/format';

import { barGeometry, delayConnectorGeometry, type WeekScale } from '../lib/gantt-coordinates';
import { stepColor, stepHatchId, stepTint } from '../lib/step-colors';
import { stepBarTitle } from '../lib/step-row-text';
import type { GanttProjectRow } from '../api/types';

/**
 * P40-T01 (owner ask 2026-11-17, after the client's old Charter tool): a
 * project's single execution line, coloured per step. Each non-skipped step is
 * one segment at its SERVED planned weeks (solid in the step colour; an
 * `elapsed` step is a light tint with a step-colour outline), and its served
 * actual weeks are a hatch of the same colour. Steps that run in parallel
 * overlap on the line, later steps on top, each with a thin surface-coloured
 * edge so the overlap stays visible. A frozen project gets a dashed outline
 * round its planned span; the red delay connector runs from the planned end
 * to the delayed end, as before.
 *
 * Every x / width is `barGeometry` of served week numbers. Nothing here sums a
 * duration or moves a step.
 */

export interface GanttProjectLineProps {
  project: GanttProjectRow;
  scale: WeekScale;
  rowHeight: number;
  /** Forest view: a thin line, no step letters. */
  compact?: boolean;
  planned: { startWeek: number; endWeek: number } | null;
  plannedEndWeek: number | null;
  delayedEndWeek: number | null;
  /** Hover text for the whole line. */
  title: string;
  fmt?: ((week: number) => string) | undefined;
}

/** Min px width for the step letter inside a segment. */
const LETTER_MIN_PX = 14;

export function GanttProjectLine({
  project,
  scale,
  rowHeight,
  compact = false,
  planned,
  plannedEndWeek,
  delayedEndWeek,
  title,
  fmt = formatPlanWeek,
}: GanttProjectLineProps): React.JSX.Element | null {
  const steps = React.useMemo(
    () => [...project.steps].filter((s) => !s.skipped).sort((a, b) => a.sequence_order - b.sequence_order),
    [project.steps],
  );
  const hasActual = steps.some((s) => s.actual_start_week != null && s.actual_end_week != null);
  const hasPlanned = steps.some((s) => s.planned_start_week != null && s.planned_end_week != null);
  if (!hasActual && !hasPlanned) return null;

  const barH = compact ? 8 : 16;
  const actualH = compact ? 6 : 12;
  const both = hasActual && hasPlanned;
  const plannedY = (rowHeight - barH) / 2 - (both ? (compact ? 2 : 4) : 0);
  const actualY = (rowHeight - actualH) / 2 + (both ? (compact ? 3 : 6) : 0);
  const spanGeom = planned ? barGeometry(planned.startWeek, planned.endWeek, scale) : null;
  const connector = delayConnectorGeometry(plannedEndWeek, delayedEndWeek, scale);
  const connectorY = rowHeight / 2;

  return (
    <g data-testid="gantt-project-line" data-frozen={project.frozen || undefined}>
      <title>{title}</title>
      {steps.map((s) => {
        const color = stepColor(s.step_id, s.sequence_order);
        const geom = barGeometry(s.planned_start_week, s.planned_end_week, scale);
        if (!geom || s.planned_start_week == null || s.planned_end_week == null) return null;
        const elapsed = s.kind === 'elapsed';
        const showLetter = !compact && geom.width >= LETTER_MIN_PX;
        return (
          <g key={`p-${s.step_id}-${String(s.sequence_order)}`}>
            <title>
              {`${color.letter} · ${stepBarTitle(
                s,
                { startWeek: s.planned_start_week, endWeek: s.planned_end_week },
                null,
                fmt,
              )}`}
            </title>
            <rect
              x={geom.x}
              y={plannedY}
              width={geom.width}
              height={barH}
              rx={compact ? 2 : 3}
              data-bar={elapsed ? 'elapsed' : 'planned'}
              data-step={s.step_id}
              data-step-slot={color.slot}
              className="gantt-bar-grow"
              fill={elapsed ? stepTint(color, 0.18) : color.fill}
              stroke={elapsed ? color.fill : 'hsl(var(--color-surface))'}
              strokeWidth={elapsed ? 1.25 : 0.75}
            />
            {showLetter ? (
              <text
                x={geom.x + geom.width / 2}
                y={plannedY + barH / 2}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={9}
                fontWeight={800}
                fill={elapsed ? 'hsl(var(--color-text))' : color.ink}
                pointerEvents="none"
                className="gantt-bar-label"
                data-testid="gantt-step-letter"
                aria-hidden="true"
              >
                {color.letter}
              </text>
            ) : null}
          </g>
        );
      })}
      {steps.map((s) => {
        const geom = barGeometry(s.actual_start_week, s.actual_end_week, scale);
        if (!geom) return null;
        const color = stepColor(s.step_id, s.sequence_order);
        return (
          <rect
            key={`a-${s.step_id}-${String(s.sequence_order)}`}
            x={geom.x}
            y={actualY}
            width={geom.width}
            height={actualH}
            rx={2}
            data-bar="actual"
            data-step={s.step_id}
            data-step-slot={color.slot}
            className="gantt-bar-grow"
            fill={`url(#${stepHatchId(color.slot)})`}
            stroke={color.fill}
            strokeWidth={1}
          />
        );
      })}
      {project.frozen && spanGeom ? (
        <rect
          x={spanGeom.x - 1}
          y={plannedY - 1.5}
          width={spanGeom.width + 2}
          height={barH + 3}
          rx={4}
          fill="none"
          stroke="hsl(var(--color-text))"
          strokeWidth={1.25}
          strokeDasharray="3 2"
          data-testid="gantt-frozen-outline"
        />
      ) : null}
      {connector ? (
        <g data-testid="gantt-delay-connector">
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
            )} ${String(connectorY)} L ${String(connector.x + connector.width - 5)} ${String(connectorY + 3)} Z`}
            fill="hsl(var(--color-gantt-delay))"
          />
        </g>
      ) : null}
    </g>
  );
}

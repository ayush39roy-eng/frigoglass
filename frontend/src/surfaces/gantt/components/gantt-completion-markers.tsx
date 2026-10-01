import * as React from 'react';

import { formatWeek } from '@/lib/format';

import { completionMarkerX, slipBracketGeometry, type WeekScale } from '../lib/gantt-coordinates';
import { GANTT_MARKER_TEST_IDS, expectedLabel, slipLabel } from '../lib/completion-labels';

/**
 * The two per-project completion lines (P9 — DOMAIN_RULES "Expected vs
 * projected completion", Invariant I16):
 *
 *   EXPECTED completion  — `expected_end_week`: solid violet line, flag cap at
 *                          the top. "Expected (target)" when the project has a
 *                          `target_end_week`, else "Expected (process-derived)"
 *                          — the unconstrained finish the scheduler stored.
 *   WILL BE COMPLETED    — `projected_end_week`: dash-dot teal line, dot cap at
 *                          the bottom. The active run's `end_week + delay`.
 *
 * Two hues that are not red (red = delay magnitude), and two dash patterns +
 * two end-caps, so colour is never the only signal. When both exist a thin
 * bracket joins them, labelled with the API's `slip_weeks` (`+N wk` late /
 * `−N wk` early), tinted by sign — text carries the sign too.
 *
 * Every x here is `completionMarkerX(week)` of a server week number. Nothing
 * is computed from durations, and the slip label is never `projected −
 * expected` re-derived client-side.
 */


export interface GanttCompletionMarkersProps {
  scale: WeekScale;
  rowHeight: number;
  projectName: string;
  targetEndWeek: number | null;
  expectedEndWeek: number | null;
  projectedEndWeek: number | null;
  slipWeeks: number | null;
}



export function GanttCompletionMarkers({
  scale,
  rowHeight,
  projectName,
  targetEndWeek,
  expectedEndWeek,
  projectedEndWeek,
  slipWeeks,
}: GanttCompletionMarkersProps): React.JSX.Element | null {
  if (expectedEndWeek === null && projectedEndWeek === null) return null;

  const expectedX = expectedEndWeek === null ? null : completionMarkerX(expectedEndWeek, scale);
  const projectedX = projectedEndWeek === null ? null : completionMarkerX(projectedEndWeek, scale);
  const bracket = slipBracketGeometry(expectedEndWeek, projectedEndWeek, scale);

  const parts: string[] = [projectName];
  if (expectedEndWeek !== null) {
    parts.push(`${expectedLabel(targetEndWeek)} ${formatWeek(expectedEndWeek)}`);
  }
  if (projectedEndWeek !== null) parts.push(`will be completed ${formatWeek(projectedEndWeek)}`);
  if (slipWeeks !== null) parts.push(`slip ${slipLabel(slipWeeks)}`);
  const description = parts.join(' · ');

  const slipTint =
    slipWeeks === null || slipWeeks === 0
      ? 'hsl(var(--color-text-muted))'
      : slipWeeks > 0
        ? 'hsl(var(--color-danger))'
        : 'hsl(var(--color-success))';

  const bracketY = 3;

  return (
    <g role="img" aria-label={description} data-testid="gantt-completion-markers">
      <title>{description}</title>

      {expectedX !== null ? (
        <g data-testid={GANTT_MARKER_TEST_IDS.expected} data-week={expectedEndWeek}>
          <line
            x1={expectedX}
            y1={0}
            x2={expectedX}
            y2={rowHeight}
            stroke="hsl(var(--color-gantt-expected))"
            strokeWidth={2}
          />
          {/* flag cap — a shape cue that survives greyscale */}
          <path
            d={`M ${String(expectedX)} 0 L ${String(expectedX + 6)} 3 L ${String(expectedX)} 6 Z`}
            fill="hsl(var(--color-gantt-expected))"
          />
        </g>
      ) : null}

      {projectedX !== null ? (
        <g data-testid={GANTT_MARKER_TEST_IDS.projected} data-week={projectedEndWeek}>
          <line
            x1={projectedX}
            y1={0}
            x2={projectedX}
            y2={rowHeight}
            stroke="hsl(var(--color-gantt-projected))"
            strokeWidth={2}
            strokeDasharray="5 2 1.5 2"
          />
          {/* dot cap */}
          <circle
            cx={projectedX}
            cy={rowHeight - 3}
            r={2.5}
            fill="hsl(var(--color-gantt-projected))"
          />
        </g>
      ) : null}

      {bracket && slipWeeks !== null ? (
        <g data-testid={GANTT_MARKER_TEST_IDS.slip} data-slip={slipWeeks}>
          <line
            x1={bracket.x}
            y1={bracketY}
            x2={bracket.x + bracket.width}
            y2={bracketY}
            stroke={slipTint}
            strokeWidth={1}
          />
          <line x1={bracket.x} y1={bracketY - 2} x2={bracket.x} y2={bracketY + 2} stroke={slipTint} strokeWidth={1} />
          <line
            x1={bracket.x + bracket.width}
            y1={bracketY - 2}
            x2={bracket.x + bracket.width}
            y2={bracketY + 2}
            stroke={slipTint}
            strokeWidth={1}
          />
          <text
            x={bracket.x + bracket.width / 2}
            y={bracketY + 9}
            fontSize={8}
            fontWeight={600}
            textAnchor="middle"
            fill={slipTint}
            className="tabular-nums"
          >
            {slipLabel(slipWeeks)}
          </text>
        </g>
      ) : null}
    </g>
  );
}

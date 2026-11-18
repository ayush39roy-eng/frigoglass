import * as React from 'react';

import { formatInteger, formatWeek } from '@/lib/format';

import { STEP_COLORS, STEP_LETTERS, type StepCode } from '../lib/step-colors';

/**
 * P40-T03c (P40-T01 item 4; the old tool's per-step count chips): how many
 * projects of the filtered set are in each step in the current week — the
 * SERVED `current_step_counts` (step id → projects), one chip per step in its
 * step colour, PDD then OEM. Nothing is counted here; a step with no served
 * count is not shown.
 */
export function StepCountChips({
  counts,
  week,
  names,
}: {
  counts: Readonly<Record<string, number>>;
  /** The served `current_week` the counts were taken at. */
  week: number | null;
  /** Served step names by step id (from the rows), for the tooltip. */
  names?: ReadonlyMap<string, string>;
}): React.JSX.Element | null {
  const groups = (['PDD', 'OEM'] as const)
    .map((wf) => ({
      wf,
      chips: STEP_LETTERS.map((l) => `${wf}-${l}` as StepCode).filter((code) => (counts[code] ?? 0) > 0),
    }))
    .filter((g) => g.chips.length > 0);
  if (groups.length === 0) return null;
  const when = week == null ? 'this week' : formatWeek(week);
  return (
    <div
      className="flex flex-wrap items-center gap-x-3 gap-y-1"
      role="group"
      aria-label={`Projects in each step, ${when}`}
      data-testid="gantt-step-counts"
    >
      <span className="text-2xs font-semibold text-text-muted">In each step, {when}</span>
      {groups.map(({ wf, chips }) => (
        <ul key={wf} className="flex flex-wrap items-center gap-1" aria-label={`${wf} steps`}>
          {chips.map((code) => {
            const c = STEP_COLORS[code];
            const n = counts[code] ?? 0;
            const name = names?.get(code);
            const label = `${code}${name ? ` ${name}` : ''}: ${formatInteger(n)} ${n === 1 ? 'project' : 'projects'}`;
            return (
              <li
                key={code}
                className="flex items-center gap-1 rounded-sm border border-border bg-surface px-1 py-px text-[0.625rem] leading-4 text-text"
                title={label}
                data-step={code}
                data-count={n}
              >
                <span
                  aria-hidden="true"
                  className="grid h-3 min-w-3 place-items-center rounded-[3px] px-0.5 text-[0.5625rem] font-extrabold leading-none"
                  style={{ background: c.fill, color: c.ink }}
                >
                  {c.letter}
                </span>
                <span aria-hidden="true" className="font-semibold tabular-nums">
                  {formatInteger(n)}
                </span>
                <span className="sr-only">{label}</span>
              </li>
            );
          })}
        </ul>
      ))}
    </div>
  );
}

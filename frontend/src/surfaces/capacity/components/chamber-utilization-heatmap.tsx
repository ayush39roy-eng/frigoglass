import * as React from 'react';

import { cn } from '@/lib/utils';
import { formatWeek } from '@/lib/format';

import type { ChamberWeekLoad, ScheduleRunSummary } from '../api/types';

/**
 * Chamber × week utilization heatmap — the equipment half of the "global
 * resource utilization matrix (engineers × weeks, chambers × weeks)"
 * (`docs/PROJECT_AND_STACK.md` §2). Chambers are equipment, not personal data,
 * so this side renders in full; the engineer half is withheld pending GDPR
 * sign-off (see `<EngineerUtilizationPlaceholder>` / OPEN_QUESTIONS #8 / P4-T08).
 *
 * Every cell value is the per-week concurrent-project `count` taken verbatim
 * from `GET /capacity/utilization-matrix` — nothing is recomputed. Per ADR 0003
 * only `max_concurrent` gates booking; `efficiency` / `weeks_per_chamber` are
 * report-only and do not appear here.
 *
 * Colour is never the sole signal: every non-empty cell shows its numeric count,
 * every cell has an `aria-label` spelling out "N of M concurrent projects", and
 * the legend pairs each swatch with text. Chamber count is well under the
 * 100-row virtualization threshold (seed + realistic scale ≈ 8–12 chambers); if
 * that ever changes, virtualize the rows (CLAUDE.md).
 */

type CellState = 'empty' | 'partial' | 'full' | 'over';

const CELL_CLASS: Record<CellState, string> = {
  empty: 'bg-surface-sunken text-text-subtle',
  partial: 'bg-primary/15 text-text',
  full: 'bg-warning-subtle text-warning-subtle-fg font-semibold',
  over: 'bg-danger-subtle text-danger-subtle-fg font-semibold ring-1 ring-inset ring-danger',
};

function cellState(count: number, max: number): CellState {
  if (count <= 0) return 'empty';
  if (count > max) return 'over';
  if (count >= max) return 'full';
  return 'partial';
}

export interface ChamberUtilizationHeatmapProps {
  chambers: ChamberWeekLoad[];
  activeRun: ScheduleRunSummary | null | undefined;
}

function weekRange(
  chambers: ChamberWeekLoad[],
  activeRun: ScheduleRunSummary | null | undefined,
): number[] {
  if (activeRun && activeRun.horizon_weeks > activeRun.current_week) {
    return Array.from(
      { length: activeRun.horizon_weeks - activeRun.current_week + 1 },
      (_, i) => activeRun.current_week + i,
    );
  }
  let min = Infinity;
  let max = -Infinity;
  for (const chamber of chambers) {
    for (const key of Object.keys(chamber.week_counts)) {
      const w = Number(key);
      if (!Number.isFinite(w)) continue;
      if (w < min) min = w;
      if (w > max) max = w;
    }
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [];
  return Array.from({ length: max - min + 1 }, (_, i) => min + i);
}

export function ChamberUtilizationHeatmap({
  chambers,
  activeRun,
}: ChamberUtilizationHeatmapProps): React.JSX.Element {
  const weeks = weekRange(chambers, activeRun);
  const gridTemplate = `minmax(9rem, max-content) repeat(${weeks.length}, 2rem)`;

  return (
    <div className="space-y-3">
      <div
        className="overflow-x-auto rounded-lg border border-border"
        tabIndex={0}
        role="group"
        aria-label="Chamber utilization by week — scrollable"
      >
        <div role="table" aria-label="Chamber utilization by week" className="min-w-max text-2xs">
          <div
            role="row"
            className="grid border-b border-border bg-surface-sunken"
            style={{ gridTemplateColumns: gridTemplate }}
          >
            <div
              role="columnheader"
              className="sticky left-0 z-10 bg-surface-sunken px-2 py-1.5 font-semibold text-text-muted"
            >
              Chamber
            </div>
            {weeks.map((w) => (
              <div
                key={w}
                role="columnheader"
                className="px-0 py-1.5 text-center font-medium tabular-nums text-text-muted"
                title={formatWeek(w)}
              >
                {w}
              </div>
            ))}
          </div>

          {chambers.map((chamber) => (
            <div
              key={chamber.chamber_id}
              role="row"
              className="grid border-b border-border last:border-0"
              style={{ gridTemplateColumns: gridTemplate }}
            >
              <div
                role="rowheader"
                className="sticky left-0 z-10 flex items-center gap-1.5 bg-surface px-2 py-1"
              >
                <span className="font-medium text-text">{chamber.code}</span>
                <span className="text-text-subtle">{chamber.lab_region}</span>
                <span className="ml-auto rounded-sm border border-border-strong px-1 text-text-muted">
                  max {chamber.max_concurrent}
                </span>
              </div>
              {weeks.map((w) => {
                const count = chamber.week_counts[String(w)] ?? 0;
                const state = cellState(count, chamber.max_concurrent);
                return (
                  <div
                    key={w}
                    role="cell"
                    aria-label={`${chamber.code}, ${formatWeek(w)}: ${String(count)} of ${String(
                      chamber.max_concurrent,
                    )} concurrent projects`}
                    title={`${chamber.code} · ${formatWeek(w)} · ${String(count)}/${String(
                      chamber.max_concurrent,
                    )}`}
                    className={cn(
                      'flex items-center justify-center border-l border-border/60 py-1 tabular-nums',
                      CELL_CLASS[state],
                    )}
                  >
                    {count > 0 ? count : ''}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>

      <dl className="flex flex-wrap gap-x-4 gap-y-1 text-2xs text-text-muted">
        <div className="flex items-center gap-1.5">
          <span className="size-3 rounded-sm bg-surface-sunken ring-1 ring-inset ring-border" aria-hidden="true" />
          <dt>Idle (0 booked)</dt>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="size-3 rounded-sm bg-primary/15" aria-hidden="true" />
          <dt>Below max concurrent</dt>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="size-3 rounded-sm bg-warning-subtle" aria-hidden="true" />
          <dt>At max concurrent</dt>
        </div>
        <div className="flex items-center gap-1.5">
          <span className="size-3 rounded-sm bg-danger-subtle ring-1 ring-inset ring-danger" aria-hidden="true" />
          <dt>Over max (booking gate breached — frozen conflict)</dt>
        </div>
      </dl>
    </div>
  );
}

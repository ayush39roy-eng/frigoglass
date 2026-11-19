import * as React from 'react';
import { CircleSlash, Hourglass } from 'lucide-react';

import { BAND_OUTCOME_META } from '@/components/shared/schedule-outcome-meta';
import { Badge } from '@/components/ui/badge';
import { WITHIN_YEAR_WEEK } from '@/lib/domain-constants';
import { useCurrentWeek, usePlanYearLabels } from '@/lib/plan-clock';

import type { GanttProjectRow } from '../api/types';
import { STEP_COLORS, STEP_LETTERS, stepTint, type StepCode } from '../lib/step-colors';

/** Hatch swatch (CSS) matching the SVG actual-bar pattern. */
function hatch(slotVar: string): React.CSSProperties {
  return {
    backgroundImage: `repeating-linear-gradient(45deg, hsl(var(${slotVar})) 0 2px, hsl(var(${slotVar}) / 0.28) 2px 5px)`,
    borderColor: `hsl(var(${slotVar}))`,
  };
}

/**
 * P40-T01: which colour is which step. One row per workflow present in the
 * view (PDD, OEM), one chip per step: the colour, the step letter and the
 * SERVED step name (read from the rows' `step_name`, never typed here).
 */
export function StepColorLegend({ rows }: { rows: readonly GanttProjectRow[] }): React.JSX.Element | null {
  const names = React.useMemo(() => {
    const out = new Map<string, string>();
    for (const r of rows) for (const st of r.steps) if (!out.has(st.step_id)) out.set(st.step_id, st.step_name);
    return out;
  }, [rows]);
  const workflows = (['PDD', 'OEM'] as const).filter((wf) => STEP_LETTERS.some((l) => names.has(`${wf}-${l}`)));
  if (workflows.length === 0) return null;
  return (
    <div className="flex flex-col gap-1" data-testid="gantt-step-legend" role="group" aria-label="Step colours">
      {workflows.map((wf) => (
        <div key={wf} className="flex items-start gap-1">
        <span className="w-9 shrink-0 pt-px text-2xs font-bold text-text" aria-hidden="true">{wf}</span>
        <ul className="flex flex-wrap items-center gap-1" aria-label={`${wf} steps`} data-testid={`gantt-step-legend-${wf.toLowerCase()}`}>
          {STEP_LETTERS.map((l) => {
            const code = `${wf}-${l}` as StepCode;
            const name = names.get(code);
            if (name === undefined) return null;
            const c = STEP_COLORS[code];
            return (
              <li
                key={code}
                className="flex min-w-0 items-center gap-1 rounded-sm border border-border bg-surface px-1 py-px text-[0.625rem] leading-4 text-text"
                title={`${code} · ${name}`}
                data-step={code}
                data-step-slot={c.slot}
              >
                <span
                  aria-hidden="true"
                  className="grid h-3 min-w-3 place-items-center rounded-[3px] px-0.5 text-[0.5625rem] font-extrabold leading-none"
                  style={{ background: c.fill, color: c.ink }}
                >
                  {l}
                </span>
                <span className="max-w-32 truncate">{name}</span>
              </li>
            );
          })}
        </ul>
        </div>
      ))}
    </div>
  );
}

/**
 * Legend for the timeline marks. Every colour is paired with text — colour is
 * never the sole signal (`ui-ux-pro-max` SKILL). P40-T01: bars take their
 * STEP's colour (`StepColorLegend`); the marks below are drawn in it.
 */
export function GanttLegend({ rows = [] }: { rows?: readonly GanttProjectRow[] }): React.JSX.Element {
  const years = usePlanYearLabels();
  // P37: the served calendar week (ADR 0052 §4: "now" markers use it).
  const currentWeek = useCurrentWeek();
  const sample = STEP_COLORS['PDD-A'];
  return (
    <div className="flex flex-col gap-2" data-testid="gantt-legend">
    <StepColorLegend rows={rows} />
    <dl className="flex flex-wrap gap-x-4 gap-y-1.5 text-2xs text-text-muted">
      <div className="flex items-center gap-1.5">
        <span className="h-2.5 w-5 rounded-sm" style={{ background: sample.fill }} aria-hidden="true" />
        <dt>Planned (schedule run), solid in the step colour</dt>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="h-2.5 w-5 rounded-sm border" style={hatch(`--step-${String(sample.slot)}`)} aria-hidden="true" />
        <dt>Actual / delayed, hatched in the step colour</dt>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="h-0.5 w-5 bg-gantt-delay" aria-hidden="true" />
        <dt>Delay magnitude</dt>
      </div>
      <div className="flex items-center gap-1.5">
        <span
          className="h-2.5 w-5 rounded-sm border"
          style={{ background: stepTint(sample, 0.18), borderColor: sample.fill }}
          aria-hidden="true"
        />
        <dt>Elapsed step (books nobody), tinted</dt>
      </div>
      <div className="flex items-center gap-1.5">
        <span
          className="inline-flex h-3.5 items-center rounded-sm border border-dashed border-border-strong px-1 text-[0.625rem] leading-none text-text-subtle"
          aria-hidden="true"
        >
          n/a
        </span>
        <dt>Skipped step (no lead time)</dt>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="relative inline-block h-3.5 w-1" aria-hidden="true">
          <span className="absolute inset-y-0 left-0 w-0.5 bg-gantt-expected" />
          <span className="absolute left-0 top-0 h-0 w-0 border-y-[3px] border-l-[5px] border-y-transparent border-l-gantt-expected" />
        </span>
        <dt>Expected completion (target, or process-derived when no target is set)</dt>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="relative inline-block h-3.5 w-1" aria-hidden="true">
          <span className="absolute inset-y-0 left-0 w-0.5 border-l-2 border-dashed border-gantt-projected" />
          <span className="absolute -left-px bottom-0 size-1.5 rounded-full bg-gantt-projected" />
        </span>
        <dt>Will be completed (active run + delay)</dt>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-[0.625rem] font-semibold text-text-muted" aria-hidden="true">
          +N wk
        </span>
        <dt>Slip between the two (red late, green early)</dt>
      </div>
      <div className="flex items-center gap-1.5">
        <span
          className="h-3 w-0.5 border-l-2 border-dashed border-gantt-marker-year"
          aria-hidden="true"
        />
        <dt>Week {WITHIN_YEAR_WEEK} — year-end of {years.planYear}</dt>
      </div>
      <div className="flex items-center gap-1.5">
        <span
          className="h-3 w-5 rounded-sm border border-gantt-marker-year/40 bg-gantt-marker-year/10"
          aria-hidden="true"
        />
        <dt>
          {years.spilloverYear} and later (shaded) — work past week {WITHIN_YEAR_WEEK} is spillover, flagged in the
          Status column
        </dt>
      </div>
      {currentWeek !== null ? (
        <div className="flex items-center gap-1.5">
          <span className="h-3 w-0.5 border-l-2 border-gantt-marker-now" aria-hidden="true" />
          <dt>Week {currentWeek} — now</dt>
        </div>
      ) : null}
      <div className="flex items-center gap-1.5">
        <span className="h-2.5 w-5 rounded-sm border-[1.25px] border-dashed border-text" aria-hidden="true" />
        <dt>Frozen project (dashed outline)</dt>
      </div>
      {/* P42 (ADR 0056): the two outcomes that do not count toward the year. */}
      <div className="flex items-center gap-1.5">
        <Badge tone={BAND_OUTCOME_META.QUEUED.tone} aria-hidden="true">
          <Hourglass />
          {BAND_OUTCOME_META.QUEUED.label}
        </Badge>
        <dt>P3 in queue — planned with spare capacity, not counted this year</dt>
      </div>
      <div className="flex items-center gap-1.5">
        <Badge tone={BAND_OUTCOME_META.NOT_SCHEDULED_PRIORITY.tone} aria-hidden="true">
          <CircleSlash />
          P4
        </Badge>
        <dt>Not scheduled (P4) — never planned, no bars</dt>
      </div>
    </dl>
    </div>
  );
}

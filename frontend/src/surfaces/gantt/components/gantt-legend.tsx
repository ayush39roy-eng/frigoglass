import * as React from 'react';

import { CURRENT_WEEK, WITHIN_YEAR_WEEK } from '@/lib/domain-constants';

/**
 * Legend for the timeline marks. Every colour is paired with text — colour is
 * never the sole signal (`ui-ux-pro-max` SKILL).
 */
export function GanttLegend(): React.JSX.Element {
  return (
    <dl className="flex flex-wrap gap-x-4 gap-y-1.5 text-2xs text-text-muted">
      <div className="flex items-center gap-1.5">
        <span className="h-2.5 w-5 rounded-sm bg-gantt-planned" aria-hidden="true" />
        <dt>Planned (schedule run)</dt>
      </div>
      <div className="flex items-center gap-1.5">
        <span
          className="h-2.5 w-5 rounded-sm border border-gantt-actual bg-gantt-actual/30"
          aria-hidden="true"
        />
        <dt>Actual / delayed</dt>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="h-0.5 w-5 bg-gantt-delay" aria-hidden="true" />
        <dt>Delay magnitude</dt>
      </div>
      <div className="flex items-center gap-1.5">
        <span
          className="h-2.5 w-5 rounded-sm border border-gantt-planned bg-gantt-planned/10"
          aria-hidden="true"
        />
        <dt>Elapsed step (books nobody)</dt>
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
        <dt>Week {WITHIN_YEAR_WEEK} — year-end</dt>
      </div>
      <div className="flex items-center gap-1.5">
        <span className="h-3 w-0.5 border-l-2 border-gantt-marker-now" aria-hidden="true" />
        <dt>Week {CURRENT_WEEK} — now</dt>
      </div>
    </dl>
  );
}

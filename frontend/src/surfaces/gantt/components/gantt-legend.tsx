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

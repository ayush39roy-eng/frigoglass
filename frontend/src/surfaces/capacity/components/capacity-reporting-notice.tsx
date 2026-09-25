import * as React from 'react';
import { Info } from 'lucide-react';

/**
 * The honest-framing callout the Capacity surface must carry (P4-T03 hard
 * constraint; mirrors the module docstring of `backend/api/routers/capacity.py`
 * and ADR 0002 / ADR 0003).
 *
 * Load figures come from the active schedule run's booked steps (Invariants
 * I6 / I7). Capacity-*supply* figures are the backend's own FTE-/efficiency-
 * scaled REPORTING estimate — the scheduler applies neither. So a reader must
 * not conclude "load > capacity ⇒ the scheduler overbooked" or "headroom ⇒ the
 * scheduler will use it".
 */
export function CapacityReportingNotice(): React.JSX.Element {
  return (
    <aside
      className="flex gap-3 rounded-lg border border-border bg-surface-sunken p-3 text-xs text-text-muted"
      aria-label="How to read the load and capacity figures on this surface"
    >
      <Info className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden="true" />
      <div className="space-y-1.5">
        <p className="font-semibold text-text">How to read these figures</p>
        <p>
          <span className="font-medium text-text">Load</span> (design-load weeks, lab-load units) is
          taken verbatim from the active schedule run&rsquo;s booked steps &mdash; the sum of design
          step durations, and of lab step durations &times; 0.5, per hub (Invariants I6 / I7).
        </p>
        <p>
          <span className="font-medium text-text">Capacity</span> (design-capacity weeks,
          lab-capacity units) is a <span className="font-medium text-text">reporting estimate</span>:
          engineer capacity is scaled by FTE and chamber capacity by efficiency. The scheduler
          itself applies <span className="font-medium text-text">neither</span> FTE nor
          chamber-efficiency scaling (ADR&nbsp;0002, ADR&nbsp;0003) &mdash; it books whole weeks and
          gates lab steps only on a chamber&rsquo;s max concurrent count.
        </p>
        <p>
          So on this surface, load exceeding capacity does{' '}
          <span className="font-medium text-text">not</span> mean the scheduler overbooked anyone,
          and spare capacity does <span className="font-medium text-text">not</span> mean the
          scheduler will use it. The two figures are computed different ways and are shown side by
          side for planning context only.
        </p>
      </div>
    </aside>
  );
}

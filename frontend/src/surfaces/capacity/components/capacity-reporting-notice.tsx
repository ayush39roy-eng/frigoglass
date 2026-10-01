import * as React from 'react';
import { Info } from 'lucide-react';

/**
 * The honest-framing callout the Capacity surface must carry (P4-T03 hard
 * constraint; revised for ADR 0007 / 0008 in P9-T04).
 *
 * Load figures come from the active schedule run's booked steps (Invariants
 * I6 / I7). Supply figures are the CLIENT'S formulas (working calendar × FTE;
 * chamber working weeks × efficiency × platforms), computed server-side. The
 * scheduler still books whole engineer-weeks regardless of FTE (ADR 0002) and
 * gates chambers on platform count only (ADR 0008) — so a reader must not
 * conclude "load > capacity ⇒ the scheduler overbooked" or "headroom ⇒ the
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
          <span className="font-medium text-text">Load</span> (engineer-weeks, chamber-weeks) is
          taken verbatim from the active schedule run&rsquo;s booked steps &mdash; the sum of
          design-step lead times per hub, and of lab-step lead times (&times;&nbsp;1.0) per lab
          region (Invariants I6 / I7, ADR&nbsp;0007). The <span className="font-medium text-text">estimated</span>{' '}
          load beside it is the projects&rsquo; hand-entered figure, for comparison only.
        </p>
        <p>
          <span className="font-medium text-text">Capacity</span> is the client&rsquo;s own supply
          formula (ADR&nbsp;0008): a hub work calendar gives working weeks per engineer, scaled by
          Σ&nbsp;FTE; each chamber&rsquo;s downtime and efficiency give efficient lab weeks, summed
          per region. The scheduler itself applies{' '}
          <span className="font-medium text-text">neither</span> FTE nor downtime when it books
          (ADR&nbsp;0002 / 0008) &mdash; it books whole weeks and gates lab steps only on a
          chamber&rsquo;s platform count.
        </p>
        <p>
          So on this surface, load exceeding capacity does{' '}
          <span className="font-medium text-text">not</span> mean the scheduler overbooked anyone,
          and spare capacity does <span className="font-medium text-text">not</span> mean the
          scheduler will use it. The two figures are computed different ways and are shown side by
          side for planning context, exactly as in the client&rsquo;s workbook.
        </p>
      </div>
    </aside>
  );
}

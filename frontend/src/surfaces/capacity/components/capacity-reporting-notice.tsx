import * as React from 'react';

import { CardInfo } from '@/components/ui/card-info';

/**
 * The honest-framing callout the Capacity surface must carry (P4-T03 hard
 * constraint; revised for ADR 0007 / 0008 in P9-T04).
 *
 * Load figures come from the active schedule run's booked steps (Invariants
 * I6 / I7). Supply figures are the CLIENT'S formulas (working calendar × FTE;
 * chamber working weeks × efficiency × platforms), computed server-side.
 * Since ADR 0032 (2026-10-21, superseding ADR 0002) the scheduler applies FTE
 * as SPEED: a design step spans `ceil(work / fte)` calendar weeks of its
 * leader, while load stays in WORK weeks, so load and FTE-scaled supply are in
 * the same unit. It still ignores the work calendar's holidays and chamber
 * downtime / efficiency, and gates chambers on platform count only (ADR 0008)
 * — so a reader must still not conclude "load > capacity ⇒ the scheduler
 * overbooked" or "headroom ⇒ the scheduler will use it".
 *
 * RESHAPED 2026-10-01 (client text cleanup), NOT reduced. This used to render
 * a four-paragraph `<aside>` wall above the first card — the single largest
 * block of body copy in the app, sitting between the page title and any data.
 * The client asked for "page title, one subtitle line, then cards", with every
 * other piece of text "part of something". All three paragraphs survive
 * VERBATIM, now inside a `<CardInfo>` popover whose trigger lives in the
 * PageHeader's actions row beside the Download button — i.e. still on the page
 * unconditionally (P4-T03's "must carry" is about the surface always offering
 * this framing, and the affordance renders for every query state, including
 * while the three panels are still pending), still keyboard reachable, still
 * announced with the same name it had as a landmark, but no longer shouted.
 *
 * Why the PageHeader and not the load card's header: all three paragraphs frame
 * the WHOLE surface, not one card — paragraph 3 ("load exceeding capacity does
 * not mean the scheduler overbooked anyone") is the conclusion a reader must
 * carry to every figure here, including the class-breakdown and utilization
 * cards. Attaching it to one card would have implied it only governs that card,
 * and would have made the callout disappear whenever that one query failed.
 * The per-card affordances (`hub-summary-table.tsx`, `class-breakdown-panel.tsx`)
 * carry the definitions specific to their own
 * figures instead.
 */
export function CapacityReportingNotice(): React.JSX.Element {
  return (
    <CardInfo label="How to read these figures">
      <p>
        <span className="font-medium text-text">Load</span> (engineer-weeks, chamber-weeks) is
        taken verbatim from the active schedule run&rsquo;s booked steps &mdash; the sum of
        design-step weeks of work per hub, and of lab-step lead times (&times;&nbsp;1.0) per lab
        region (Invariants I6 / I7, ADR&nbsp;0007). Work weeks, not calendar weeks: a design step
        led at 0.5&nbsp;FTE counts its 4 weeks of work even though it spans 8 calendar weeks. The{' '}
        <span className="font-medium text-text">estimated</span> load beside it is the
        projects&rsquo; hand-entered figure, for comparison only.
      </p>
      <p>
        <span className="font-medium text-text">Capacity</span> is the client&rsquo;s own supply
        formula (ADR&nbsp;0008): a hub work calendar gives working weeks per engineer, scaled by
        Σ&nbsp;FTE; each chamber&rsquo;s downtime and efficiency give efficient lab weeks, summed
        per region. The scheduler applies FTE as{' '}
        <span className="font-medium text-text">speed</span> (ADR&nbsp;0032): a leader at
        0.5&nbsp;FTE takes twice as many calendar weeks for the same work. It does{' '}
        <span className="font-medium text-text">not</span> apply holidays or chamber downtime
        when it books (ADR&nbsp;0008) &mdash; it gates lab steps only on a chamber&rsquo;s
        platform count.
      </p>
      <p>
        So on this surface, load exceeding capacity does{' '}
        <span className="font-medium text-text">not</span> mean the scheduler overbooked anyone,
        and spare capacity does <span className="font-medium text-text">not</span> mean the
        scheduler will use it. The two figures are computed different ways and are shown side by
        side for planning context, exactly as in the client&rsquo;s workbook.
      </p>
    </CardInfo>
  );
}

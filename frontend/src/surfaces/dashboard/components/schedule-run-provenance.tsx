import * as React from 'react';

import {
  ScheduleRunProvenance as SharedScheduleRunProvenance,
} from '@/components/shared/schedule-run-provenance';
import { formatWeek } from '@/lib/format';

import type { ScheduleRunSummary } from '../api/types';

/**
 * Dashboard binding of the shared `<ScheduleRunProvenance>` (lifted to
 * `@/components/shared` in P4-T03). Supplies the within-year counting-method
 * explanation verbatim from `DOMAIN_RULES.md` (`not left_out AND
 * last_step_end + delay <= week 52`), the Commercialized-counts-as-delivered
 * note (the backend `_excluded_outcome` resolution — the "+1" side of the
 * P2-T10 "10-vs-11"), and the Invariant I9 "not recomputed in your browser"
 * statement. The shared spine names the exact active run version.
 */

const WITHIN_YEAR_WEEK = 52;

export interface ScheduleRunProvenanceProps {
  scheduleRunVersion: number | null;
  activeRun: ScheduleRunSummary | null | undefined;
}

export function ScheduleRunProvenance({
  scheduleRunVersion,
  activeRun,
}: ScheduleRunProvenanceProps): React.JSX.Element {
  return (
    <SharedScheduleRunProvenance scheduleRunVersion={scheduleRunVersion} activeRun={activeRun}>
      <span className="block space-y-1">
        <span className="block">
          A project is counted as <strong>completing within the year</strong> when it is not left
          out and its last scheduled step ends — plus any applied delay — on or before{' '}
          {formatWeek(WITHIN_YEAR_WEEK)} (<code>DOMAIN_RULES.md</code>). Projects with{' '}
          <strong>Commercialized</strong> status are counted as already delivered this year.
        </span>
        <span className="block">
          <strong>Spillover</strong> = scheduled but not completing by {formatWeek(WITHIN_YEAR_WEEK)}
          . <strong>Left out</strong> = no feasible window before the 78-week horizon.
        </span>
        <span className="block">
          Every number on this surface traces to a single field on the schedule-run response. None
          of it is recalculated in your browser (Invariant I9).
        </span>
      </span>
    </SharedScheduleRunProvenance>
  );
}

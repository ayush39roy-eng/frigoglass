import * as React from 'react';

import { Badge } from '@/components/ui/badge';
import { BoltCard } from '@/components/ui/bolt-card';
import { CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/shared/empty-state';

import type { ScheduleRunSummary, UtilizationMatrix } from '../api/types';
import { CapacityInfo } from './capacity-info';
import { ChamberUtilizationHeatmap } from './chamber-utilization-heatmap';
import { EngineerUtilizationPlaceholder } from './engineer-utilization-placeholder';

/**
 * "A global resource utilization matrix (engineers × weeks, chambers × weeks)"
 * (`docs/PROJECT_AND_STACK.md` §2).
 *
 * Only the CHAMBER side renders (equipment — not personal data). The engineer
 * side is withheld pending GDPR sign-off; `data.engineers` is intentionally not
 * read here (OPEN_QUESTIONS #8 / P4-T08).
 */

export interface ChamberUtilizationPanelProps {
  data: UtilizationMatrix;
  activeRun: ScheduleRunSummary | null | undefined;
}

export function ChamberUtilizationPanel({
  data,
  activeRun,
}: ChamberUtilizationPanelProps): React.JSX.Element {
  const runBadge =
    data.schedule_run_version === null ? null : `Run v${String(data.schedule_run_version)}`;

  return (
    <BoltCard>
      <CardHeader className="flex-wrap gap-y-s2">
        <CardTitle>Resource utilization matrix</CardTitle>
        <div className="flex flex-wrap items-center gap-s2">
          {runBadge ? (
            <Badge tone="neutral" className="rounded-pill">
              {runBadge}
            </Badge>
          ) : null}
          <CapacityInfo label="What this matrix shows">
            <p>
              Concurrent project count per chamber per week, verbatim from the active schedule run.
            </p>
            <p>
              Only <strong className="text-text">max concurrent</strong> (a chamber&rsquo;s
              platform count) gates booking (ADR&nbsp;0003 / 0008); efficiency and downtime are
              supply-reporting inputs and do not appear here. A cell over max means the booking
              gate was breached by a frozen or anchored step &mdash; see the legend.
            </p>
          </CapacityInfo>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <section className="space-y-2">
          <div className="flex items-baseline justify-between gap-3">
            <h3 className="label-caps text-text-muted">Chambers × weeks</h3>
          </div>
          {!data.has_active_schedule_run ? (
            <EmptyState
              title="No schedule computed yet"
              description="Chamber utilization by week appears once the schedule is calculated."
              className="rounded-dash border-solid border-dash-hairline bg-dash-alt"
            />
          ) : data.chambers.length === 0 ? (
            <EmptyState
              title="No chambers in scope"
              description="There are no lab chambers in your hub scope's lab region(s)."
              className="rounded-dash border-solid border-dash-hairline bg-dash-alt"
            />
          ) : (
            <ChamberUtilizationHeatmap chambers={data.chambers} activeRun={activeRun} />
          )}
        </section>

        <section className="space-y-2 border-t border-dash-hairline pt-4">
          <h3 className="label-caps text-text-muted">Engineers × weeks</h3>
          <EngineerUtilizationPlaceholder />
        </section>
      </CardContent>
    </BoltCard>
  );
}

import * as React from 'react';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState } from '@/components/shared/empty-state';

import type { ScheduleRunSummary, UtilizationMatrix } from '../api/types';
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
    <Card>
      <CardHeader>
        <CardTitle>Resource utilization matrix</CardTitle>
        {runBadge ? <Badge tone="neutral">{runBadge}</Badge> : null}
      </CardHeader>
      <CardContent className="space-y-5">
        <section className="space-y-2">
          <div className="flex items-baseline justify-between gap-3">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">
              Chambers × weeks
            </h3>
            <p className="text-2xs text-text-muted">
              Concurrent project count per chamber per week, verbatim from the active schedule run.
            </p>
          </div>
          {!data.has_active_schedule_run ? (
            <EmptyState
              title="No schedule computed yet"
              description="Chamber utilization by week appears once the schedule is calculated."
            />
          ) : data.chambers.length === 0 ? (
            <EmptyState
              title="No chambers in scope"
              description="There are no lab chambers in your hub scope's lab region(s)."
            />
          ) : (
            <ChamberUtilizationHeatmap chambers={data.chambers} activeRun={activeRun} />
          )}
        </section>

        <section className="space-y-2 border-t border-border pt-4">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-text-muted">
            Engineers × weeks
          </h3>
          <EngineerUtilizationPlaceholder />
        </section>
      </CardContent>
    </Card>
  );
}

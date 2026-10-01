import * as React from 'react';
import { RefreshCw, Snowflake } from 'lucide-react';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

import type { StagePatchRequest, WorkspaceResponse } from '../api/types';
import type { RecalcState } from '../hooks/use-recalc-flow';
import { CompletionStrip } from './completion-strip';
import { RecalcStatus, RecalculateButton } from './recalc-status';
import { StageRow } from './stage-row';

/**
 * Progress (DOMAIN_RULES "Per-stage progress capture"). The roll-up bar is the
 * server's duration-weighted `progress_pct` (I12) — never recomputed. A stage
 * save PATCHes one stage, the server marks the project stale, and the banner
 * offers Recalculate: a progress edit never triggers a solve (ADR 0006).
 */
export interface ProgressPanelProps {
  data: WorkspaceResponse;
  canWrite: boolean;
  onSaveStage: (stepId: string, body: StagePatchRequest) => Promise<unknown>;
  recalc: { state: RecalcState; start: () => void; busy: boolean };
}

export function ProgressPanel({ data, canWrite, onSaveStage, recalc }: ProgressPanelProps): React.JSX.Element {
  const stages = [...data.stages].sort((a, b) => a.sequence_order - b.sequence_order);
  // P9-R03: `progress_pct` is null when there is nothing to weight (Σ duration 0).
  // That is "no progress recorded", which is not the same statement as 0%.
  const pct = data.progress_pct === null ? null : Math.max(0, Math.min(100, data.progress_pct));
  // DOMAIN_RULES remediation ruling 3: stage progress cannot be edited on a frozen
  // project (the PATCH returns 409 PROJECT_FROZEN). Stored progress stays visible,
  // read-only. `frozen` still wins over stage progress (ADR 0006).
  const frozen = data.project.frozen;
  const canEditStages = canWrite && !frozen;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Progress</CardTitle>
        <span className="text-2xs text-text-muted">
          {data.schedule.has_active_run && data.schedule.run_version !== null
            ? `Planned weeks from schedule run v${String(data.schedule.run_version)}`
            : 'No active schedule run'}
        </span>
      </CardHeader>
      <CardContent className="space-y-3">
        {data.schedule.schedule_stale ? (
          <div
            role="status"
            data-testid="progress-stale-banner"
            className="flex flex-wrap items-center gap-2 rounded-lg border border-warning/50 bg-warning-subtle px-3 py-2 text-2xs text-warning-subtle-fg"
          >
            <RefreshCw className="size-3.5 shrink-0" aria-hidden="true" />
            <span className="flex-1">
              <strong>Progress updated. Schedule is now stale.</strong> The dates below still come from the previous
              run; recalculate to re-plan with the new progress.
            </span>
            {canWrite ? <RecalculateButton onClick={recalc.start} busy={recalc.busy} variant="secondary" /> : null}
          </div>
        ) : null}
        <RecalcStatus state={recalc.state} />

        {frozen ? (
          <div
            role="note"
            data-testid="progress-frozen-notice"
            className="flex items-center gap-2 rounded-lg border border-accent/30 bg-accent/10 px-3 py-2 text-2xs text-accent-subtle-fg"
          >
            <Snowflake className="size-3.5 shrink-0 text-accent" aria-hidden="true" />
            <span>
              <strong>This project is frozen.</strong> Unfreeze on the Gantt to record stage progress — the stages
              below are locked to their stored values.
            </span>
          </div>
        ) : null}

        <div className="space-y-1">
          <div className="flex items-baseline justify-between text-2xs text-text-muted">
            <span>Project progress (weighted by stage duration)</span>
            <span className="font-mono text-sm font-semibold text-text" data-testid="progress-pct">
              {pct === null ? 'No progress recorded' : `${String(pct)}%`}
            </span>
          </div>
          {pct === null ? null : (
            <div
              className="h-2.5 overflow-hidden rounded-pill bg-surface-sunken"
              role="progressbar"
              aria-label="Project progress, weighted by stage duration"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
            >
              <div className="h-full rounded-pill bg-primary" style={{ width: `${String(pct)}%` }} />
            </div>
          )}
        </div>

        <CompletionStrip schedule={data.schedule} targetEndWeek={data.project.target_end_week} projectName={data.project.name} />

        <ol className="rounded-lg border border-border" aria-label="Workflow stages">
          {stages.map((stage) => (
            <StageRow key={stage.step_id} stage={stage} canWrite={canEditStages} onSave={onSaveStage} />
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}

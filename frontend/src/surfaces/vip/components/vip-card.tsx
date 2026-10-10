import * as React from 'react';
import { Link } from 'react-router-dom';
import { Pin, PinOff, Sparkles } from 'lucide-react';

import { PriorityBandPill } from '@/components/shared/priority-band-pill';
import { HealthChip, ProjectedFinishChip } from '@/components/shared/project-outcome-chips';
import { TrackingStatusChip } from '@/components/shared/tracking-status-chip';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { CategoryTag } from '@/components/ui/category-tag';
import { apiErrorMessage } from '@/lib/api/error-messages';
import { formatDecimal, formatWeek } from '@/lib/format';
import { cn } from '@/lib/utils';
import { stageStatusLabel } from '@/types/enums';

import type { VipProject } from '../api';

export interface VipCardProps {
  project: VipProject;
  /** Registration write (ADR 0022 §4): show the pin / unpin control. */
  canPin: boolean;
  pinBusy: boolean;
  pinError: unknown;
  onTogglePin: (project: VipProject) => void;
}

function week(value: number | null): string {
  return value === null ? '—' : formatWeek(value);
}

/**
 * One ranked VIP project (ADR 0022 §5). Rank, the pinned/auto marker and every
 * figure are served from the active run; nothing is ranked or computed here.
 */
export function VipCard({ project, canPin, pinBusy, pinError, onTogglePin }: VipCardProps): React.JSX.Element {
  const pinned = project.selection === 'pinned';
  const progress = project.progress_pct;

  return (
    <article
      className="flex h-full gap-3 rounded-dash border-[1.5px] border-dash-hairline bg-surface p-3 shadow-dashCard"
      aria-label={`Rank ${String(project.rank)}: ${project.name}`}
      data-testid="vip-card"
      data-project-id={project.project_id}
      data-selection={project.selection}
    >
      <div className="flex w-8 shrink-0 flex-col items-center gap-1">
        <span className="font-display text-lg font-bold tabular-nums text-text" data-numeric="" data-testid="vip-rank">
          {project.rank}
        </span>
        <span className="sr-only">{pinned ? 'Pinned' : 'Automatic'}</span>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex items-start justify-between gap-2">
          <h3 className="min-w-0 text-sm font-semibold leading-snug text-text">
            <Link
              to={`/projects/${project.project_id}`}
              className="line-clamp-2 rounded-sm underline-offset-2 hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              title={`${project.name} — open in Project Workspace`}
            >
              {project.name}
            </Link>
          </h3>
          <Badge
            tone={pinned ? 'primary' : 'outline'}
            className="shrink-0"
            data-testid="vip-selection"
            title={pinned ? 'Pinned as VIP by a planner' : 'Selected automatically by priority and score'}
          >
            {pinned ? <Pin aria-hidden="true" /> : <Sparkles aria-hidden="true" />}
            {pinned ? 'Pinned' : 'Auto'}
          </Badge>
        </div>

        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-2xs text-text-muted">
          {project.priority ? <PriorityBandPill priority={project.priority} /> : <span>No priority</span>}
          {project.category ? <CategoryTag category={project.category} /> : null}
          <span>
            Score{' '}
            <span className="font-mono font-semibold tabular-nums text-text" data-numeric="">
              {project.score === null ? '—' : formatDecimal(project.score)}
            </span>
          </span>
          <span aria-hidden="true">·</span>
          <span data-testid="vip-expected-projected">
            Expected{' '}
            <span className="font-mono font-semibold tabular-nums text-text" data-numeric="">
              {week(project.expected_end_week)}
            </span>{' '}
            · Projected{' '}
            <span className="font-mono font-semibold tabular-nums text-text" data-numeric="">
              {week(project.projected_end_week)}
            </span>
          </span>
        </p>

        <div className="flex flex-wrap items-center gap-1">
          <ProjectedFinishChip projectedEndWeek={project.projected_end_week} withinYear={project.within_year} />
          <HealthChip health={project.health} />
          <TrackingStatusChip status={project.tracking_status} />
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between gap-2 text-2xs text-text-muted">
            <span className="min-w-0 truncate" data-testid="vip-current-stage">
              {project.current_stage
                ? `${project.current_stage.step_name} · ${stageStatusLabel(project.current_stage.status)}`
                : 'No open stage'}
            </span>
            <span className="shrink-0 font-mono font-semibold tabular-nums text-text" data-numeric="" data-testid="vip-progress">
              {progress === null ? '—' : `${String(progress)} %`}
            </span>
          </div>
          {progress !== null ? (
            <div
              className="h-1.5 overflow-hidden rounded-full bg-surface-sunken"
              role="progressbar"
              aria-label={`${project.name} progress`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={progress}
            >
              <div className="h-full rounded-full bg-primary" style={{ width: `${String(Math.max(0, Math.min(100, progress)))}%` }} />
            </div>
          ) : null}
        </div>

        {canPin ? (
          <div className="flex items-center justify-end gap-2 border-t border-dash-hairline pt-2">
            {pinError ? (
              <p role="alert" className="mr-auto text-2xs text-danger">
                {apiErrorMessage(pinError, 'The VIP pin could not be changed.')}
              </p>
            ) : null}
            <Button
              type="button"
              size="sm"
              variant={pinned ? 'ghost' : 'soft'}
              disabled={pinBusy}
              onClick={() => onTogglePin(project)}
              aria-label={pinned ? `Unpin ${project.name}` : `Pin ${project.name} as VIP`}
              className={cn('h-7')}
              data-testid="vip-pin-toggle"
            >
              {pinned ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}
              {pinned ? 'Unpin' : 'Pin as VIP'}
            </Button>
          </div>
        ) : null}
      </div>
    </article>
  );
}

import * as React from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Info, RefreshCw } from 'lucide-react';

import { PriorityBandPill } from '@/components/shared/priority-band-pill';
import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { PROJECT_TYPE_LABELS } from '@/types/enums';

import type { WorkspaceResponse } from '../api/types';
import type { RecalcState } from '../hooks/use-recalc-flow';
import { personLabel, WITHHELD } from '../lib/people';
import { HealthBadge } from './health-badge';
import { RecalcStatus, RecalculateButton } from './recalc-status';

/**
 * Sticky header (docs/PROJECT_AND_STACK.md §2): name + ID, hub, category,
 * type, priority, health (server `health`, I13), leader and "Recalculate
 * schedule". The leader is `null` while OQ#8 withholds named-engineer data.
 */
export function WorkspaceHeader({
  data,
  canRecalculate,
  recalc,
}: {
  data: WorkspaceResponse;
  canRecalculate: boolean;
  recalc: { state: RecalcState; start: () => void; busy: boolean };
}): React.JSX.Element {
  const p = data.project;
  return (
    <header
      className="sticky top-0 z-20 -mx-gutter mb-stack border-b border-border bg-canvas/95 px-gutter py-s3 backdrop-blur-0"
      data-testid="workspace-header"
    >
      <div className="flex flex-wrap items-start justify-between gap-s3">
        <div className="min-w-0 space-y-1.5">
          <Link to="/timeline" className="inline-flex items-center gap-1 text-2xs text-text-muted hover:text-primary">
            <ArrowLeft className="size-3" aria-hidden="true" />
            Timeline
          </Link>
          {/* Health (and staleness, when present) is the single most important fact
              about a project — it sits beside the name, at name-line prominence,
              rather than level with the descriptive metadata chips below. */}
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h1 className="truncate text-h1 tracking-tight text-text" title={p.name}>
              {p.name}
            </h1>
            <HealthBadge health={data.health} size="lg" />
            {data.schedule.schedule_stale ? (
              <Badge
                tone="warning"
                className="gap-1 text-xs font-semibold"
                title="Progress or settings changed since the active schedule run — see Recalculate below"
                data-testid="header-stale-badge"
              >
                <RefreshCw className="size-3.5" aria-hidden="true" />
                Stale
              </Badge>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-1.5 text-2xs text-text-muted">
            <span className="font-mono" title={p.id}>
              ID {p.external_code ?? p.id.slice(0, 8)}
            </span>
            <span aria-hidden="true">·</span>
            <span>{p.hub}</span>
            {p.category ? <Badge tone="outline">{p.category}</Badge> : null}
            {p.type ? <Badge tone="neutral">{PROJECT_TYPE_LABELS[p.type]}</Badge> : null}
            {p.priority ? <PriorityBandPill priority={p.priority} /> : null}
            <span aria-hidden="true">·</span>
            <span>
              Leader:{' '}
              {p.leader_engineer_name !== null ? personLabel(p.leader_engineer_name) : (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button type="button" className="inline-flex items-center gap-0.5 underline decoration-dotted underline-offset-2" data-testid="leader-withheld">
                      {WITHHELD}
                      <Info className="size-3" aria-hidden="true" />
                    </button>
                  </TooltipTrigger>
                  <TooltipContent className="max-w-xs">
                    Named engineer data is withheld until the data-protection review (OPEN_QUESTIONS #8) is resolved.
                  </TooltipContent>
                </Tooltip>
              )}
            </span>
          </div>
        </div>
        {canRecalculate ? (
          <div className="flex flex-col items-end gap-1">
            <RecalculateButton onClick={recalc.start} busy={recalc.busy} />
            <RecalcStatus state={recalc.state} />
          </div>
        ) : null}
      </div>
    </header>
  );
}

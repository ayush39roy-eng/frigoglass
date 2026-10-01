import * as React from 'react';
import { Ban, CircleCheck, CircleDashed, CirclePause, CircleX, TriangleAlert } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';

import type { WorkspaceHealth } from '../api/types';
import { HEALTH_META } from '../lib/health-meta';

const ICON: Record<WorkspaceHealth, React.ComponentType<{ className?: string }>> = {
  on_track: CircleCheck,
  at_risk: TriangleAlert,
  off_track: CircleX,
  left_out: Ban,
  blocked: CirclePause, // ⏸ (remediation ruling 5)
  unscheduled: CircleDashed,
};

/**
 * Health badge — icon + label + tone, from the server's `health` (I13).
 * `size="lg"` is used once, in the sticky header, where health is the single
 * most important fact about a project and must outweigh the surrounding
 * metadata chips (hub, category, type, priority) rather than sit level with them.
 */
export function HealthBadge({
  health,
  size = 'sm',
}: {
  health: WorkspaceHealth;
  size?: 'sm' | 'lg';
}): React.JSX.Element {
  const meta = HEALTH_META[health];
  const Icon = ICON[health];
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button type="button" className="rounded-sm" aria-label={`Health: ${meta.label}. ${meta.description}`} data-testid="health-badge" data-health={health}>
          <Badge
            tone={meta.tone}
            className={size === 'lg' ? 'gap-1.5 px-2.5 py-1 text-xs font-semibold [&_svg]:size-4' : 'text-xs'}
          >
            <Icon aria-hidden="true" />
            {meta.label}
          </Badge>
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">{meta.description} Derived from the active schedule run, never entered.</TooltipContent>
    </Tooltip>
  );
}

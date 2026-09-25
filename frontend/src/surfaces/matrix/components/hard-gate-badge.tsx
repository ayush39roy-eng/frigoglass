import * as React from 'react';
import { ShieldAlert } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import type { HardGateReason } from '@/types/enums';

/**
 * Hard-gate annotation for a scoring-grid row.
 *
 * `docs/DOMAIN_RULES.md` "Hard gates (override band, force P1)": a project with
 * any active hard gate is pinned to P1 regardless of its `normalized_pct`.
 *
 * IMPORTANT — this is NOT a client-side calculation. "P1" here is a fixed rule
 * constant surfaced *because* `row.hard_gates` is non-empty; no band is derived
 * from a score in the browser (Invariant I9). The backend's `suggested_band`
 * currently reflects only the score formula — the P1 override itself is applied
 * by the (deferred) "Apply Priorities" action — so the UI states the override
 * explicitly rather than letting it look silent.
 */
export function HardGateBadge({ gates }: { gates: HardGateReason[] }): React.JSX.Element | null {
  if (gates.length === 0) return null;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="inline-flex">
          <Badge tone="danger" data-testid="hard-gate-badge">
            <ShieldAlert aria-hidden="true" />
            Hard gate → P1
          </Badge>
        </span>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-left">
        <span className="block font-semibold">Forced to band P1 by hard gate</span>
        <span className="mt-1 block">
          Per <code>DOMAIN_RULES.md</code>, an active hard gate overrides the score band and pins
          this project to P1 when priorities are applied:
        </span>
        <ul className="mt-1 list-disc pl-4">
          {gates.map((g) => (
            <li key={g}>{g}</li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}

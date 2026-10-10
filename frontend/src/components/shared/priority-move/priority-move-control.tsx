import * as React from 'react';
import { ChevronDown } from 'lucide-react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { cn } from '@/lib/utils';
import { usePermission } from '@/stores/session';
import { PROJECT_PRIORITIES, type ProjectPriority } from '@/types/enums';

import { PRIORITY_BAND_STYLES, PRIORITY_BAND_TITLE } from '../priority-band-meta';
import { PriorityBandPill } from '../priority-band-pill';
import { MOVE_COPY } from './move-copy';
import { usePriorityMoveHost, type PriorityMoveTarget } from './priority-move-context';

function isPriority(value: string): value is ProjectPriority {
  return (PROJECT_PRIORITIES as readonly string[]).includes(value);
}

export interface PriorityMoveControlProps extends PriorityMoveTarget {
  className?: string;
}

/**
 * The priority pill as a dropdown (ADR 0015): pick P1–P4 or Q to move the
 * project; the surrounding `<PriorityMoveProvider>` confirms, calls
 * `POST /projects/{id}/priority` and follows the recalculation.
 *
 * Shown only when the session has `project_registration.write` (the permission
 * the endpoint checks, ADR 0015 §3). Without it, or outside a provider, this
 * renders the existing read-only `<PriorityBandPill>`. The server still
 * enforces hub scope and project grants.
 */
export function PriorityMoveControl({ className, ...target }: PriorityMoveControlProps): React.JSX.Element | null {
  const host = usePriorityMoveHost();
  const canWrite = usePermission('project_registration').write;
  const { priority, projectName } = target;

  if (!host || !canWrite) {
    return priority ? <PriorityBandPill priority={priority} className={className} /> : null;
  }

  const style = priority ? PRIORITY_BAND_STYLES[priority] : null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={host.busy}
          aria-label={`Priority ${priority ?? 'not set'} for ${projectName}. Change priority`}
          title={host.busy ? 'A priority move is being recalculated' : 'Change priority (recalculates the timeline)'}
          className={cn(
            'inline-flex shrink-0 items-center gap-1 rounded-sm px-1.5 py-0.5 text-2xs font-semibold leading-none text-text',
            'ring-1 ring-inset ring-border-strong/60 transition-colors hover:ring-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            'disabled:cursor-not-allowed disabled:opacity-60',
            style ? style.tint : 'bg-surface-sunken',
            className,
          )}
          data-testid="priority-move-trigger"
        >
          {style ? <span className={cn('size-1.5 shrink-0 rounded-full', style.dot)} aria-hidden="true" /> : null}
          {style ? style.label : 'Set priority'}
          <ChevronDown className="size-3 text-text-muted" aria-hidden="true" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel>Move priority</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={priority ?? ''}
          onValueChange={(value) => {
            if (isPriority(value) && value !== priority) host.requestMove(target, value);
          }}
        >
          {PROJECT_PRIORITIES.map((p) => (
            <DropdownMenuRadioItem key={p} value={p} className="text-xs">
              <span className={cn('size-2 shrink-0 rounded-full', PRIORITY_BAND_STYLES[p].dot)} aria-hidden="true" />
              {PRIORITY_BAND_TITLE[p]}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <p className="px-2 py-1 text-2xs text-text-muted">{MOVE_COPY.formHint}</p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

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
import { isPriorityNotApplicable, NOT_APPLICABLE_LABEL, NOT_APPLICABLE_TOOLTIP } from '@/lib/priority-applicability';
import { cn } from '@/lib/utils';
import { usePermission } from '@/stores/session';
import { PROJECT_PRIORITIES, type ProjectPriority } from '@/types/enums';

import { PRIORITY_BAND_STYLES, PRIORITY_BAND_TITLE, priorityBandName } from '../priority-band-meta';
import { NotApplicablePriorityPill, PriorityBandPill } from '../priority-band-pill';
import { MOVE_COPY } from './move-copy';
import { usePriorityMoveHost, type PriorityMoveTarget } from './priority-move-context';

function isPriority(value: string): value is ProjectPriority {
  return (PROJECT_PRIORITIES as readonly string[]).includes(value);
}

export interface PriorityMoveControlProps extends PriorityMoveTarget {
  className?: string;
  /** P57-T02: served `priority_applicable`, when the payload carries it (wins over `status`). */
  priorityApplicable?: boolean | null | undefined;
  /** P59 (owner 2026-11-23): extra hover text, e.g. "Calculated from score: P2"
   *  (the score's band is not drawn beside the set priority). */
  hint?: string | null | undefined;
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
export function PriorityMoveControl({
  className,
  priorityApplicable,
  hint,
  ...target
}: PriorityMoveControlProps): React.JSX.Element | null {
  const host = usePriorityMoveHost();
  const canWrite = usePermission('project_registration').write;
  const { priority, projectName } = target;

  // P57 (ADR 0067): Commercialized / Cancelled take no priority. The control is
  // shown as "Not applicable", disabled; the stored priority is never moved here.
  if (isPriorityNotApplicable(target.status, priorityApplicable)) {
    if (!host || !canWrite) return <NotApplicablePriorityPill className={className} />;
    return (
      <span title={NOT_APPLICABLE_TOOLTIP} className="inline-flex">
        <button
          type="button"
          disabled
          aria-label={`Priority ${NOT_APPLICABLE_LABEL} for ${projectName}. ${NOT_APPLICABLE_TOOLTIP}`}
          className={cn(
            'inline-flex shrink-0 cursor-not-allowed items-center gap-1 rounded-sm bg-surface-sunken px-1.5 py-0.5 text-2xs font-semibold leading-none text-text-muted ring-1 ring-inset ring-border',
            className,
          )}
          data-testid="priority-move-not-applicable"
        >
          {NOT_APPLICABLE_LABEL}
        </button>
      </span>
    );
  }

  if (!host || !canWrite) {
    return priority ? (
      <PriorityBandPill
        priority={priority}
        className={className}
        {...(hint ? { title: `${PRIORITY_BAND_TITLE[priority]}. ${hint}` } : {})}
      />
    ) : null;
  }

  const style = priority ? PRIORITY_BAND_STYLES[priority] : null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={host.busy}
          aria-label={`Priority ${priority ?? 'not set'} for ${projectName}. Change priority`}
          title={
            host.busy
              ? 'A priority move is being recalculated'
              : `Change priority (recalculates the timeline)${hint ? `. ${hint}` : ''}`
          }
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
            <DropdownMenuRadioItem key={p} value={p} className="text-xs" title={PRIORITY_BAND_TITLE[p]}>
              <span className={cn('size-2 shrink-0 rounded-full', PRIORITY_BAND_STYLES[p].dot)} aria-hidden="true" />
              {priorityBandName(p)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
        <DropdownMenuSeparator />
        <p className="px-2 py-1 text-2xs text-text-muted">{MOVE_COPY.formHint}</p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

import * as React from 'react';

import {
  effectivePriority,
  isPriorityNotApplicable,
  NOT_APPLICABLE_LABEL,
  NOT_APPLICABLE_SHORT_LABEL,
  NOT_APPLICABLE_TOOLTIP,
} from '@/lib/priority-applicability';
import { cn } from '@/lib/utils';
import type { ProjectPriority } from '@/types/enums';

import { PRIORITY_BAND_STYLES, PRIORITY_BAND_TITLE } from './priority-band-meta';

/**
 * Priority band indicator (P1 highest urgency → Q lowest / unscored).
 *
 * Colour comes from the `--color-band-*` semantic tokens and is ALWAYS paired with the
 * text label + a shape dot — colour is never the sole signal (ui-ux-pro-max SKILL,
 * tokens.css comment). Readable in a black-and-white export.
 *
 * This renders whichever priority the API returns (`effective_priority`). It does not
 * derive the band from a score — that is Invariant I9 territory and lives server-side.
 */

export interface PriorityBandPillProps extends React.HTMLAttributes<HTMLSpanElement> {
  priority: ProjectPriority;
  /** Hide the text label (dot + tint only). Still exposes the label to assistive tech. */
  iconOnly?: boolean;
}

export function PriorityBandPill({
  priority,
  iconOnly = false,
  className,
  ...props
}: PriorityBandPillProps): React.JSX.Element {
  const style = PRIORITY_BAND_STYLES[priority];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-2xs font-semibold leading-none text-text',
        style.tint,
        className,
      )}
      title={PRIORITY_BAND_TITLE[priority]}
      {...props}
    >
      <span className={cn('size-1.5 shrink-0 rounded-full', style.dot)} aria-hidden="true" />
      {iconOnly ? <span className="sr-only">{PRIORITY_BAND_TITLE[priority]}</span> : style.label}
    </span>
  );
}

export interface NotApplicablePriorityPillProps extends React.HTMLAttributes<HTMLSpanElement> {
  /** "N/A" instead of "Not applicable" (tight cells). The full label stays the accessible name. */
  short?: boolean;
}

/**
 * P57 (ADR 0067): the neutral pill of a Commercialized / Cancelled project —
 * no band colour, never a P1–P4 / Q label. The stored priority is not shown.
 */
export function NotApplicablePriorityPill({
  short = false,
  className,
  ...props
}: NotApplicablePriorityPillProps): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-sm bg-surface-sunken px-1.5 py-0.5 text-2xs font-semibold leading-none text-text-muted ring-1 ring-inset ring-border',
        className,
      )}
      title={NOT_APPLICABLE_TOOLTIP}
      data-testid="priority-not-applicable"
      {...props}
    >
      {short ? NOT_APPLICABLE_SHORT_LABEL : NOT_APPLICABLE_LABEL}
    </span>
  );
}

export interface ProjectPriorityPillProps {
  /** The served project status (Commercialized / Cancelled → "Not applicable"). */
  status: string | null | undefined;
  priority: ProjectPriority | null | undefined;
  /** P57-T02: served `priority_applicable`, when the payload carries it (wins over `status`). */
  priorityApplicable?: boolean | null | undefined;
  /** Rendered when the project is applicable but has no priority (default: nothing). */
  fallback?: React.ReactNode;
  short?: boolean;
  className?: string;
  /** P59: extra hover text after the band's own title (e.g. "Calculated from score: P2"). */
  hint?: string | null | undefined;
}

/**
 * P57 (ADR 0067): a project's priority as displayed everywhere — the band pill,
 * or the neutral "Not applicable" pill for Commercialized / Cancelled.
 */
export function ProjectPriorityPill({
  status,
  priority,
  priorityApplicable,
  fallback = null,
  short = false,
  className,
  hint,
}: ProjectPriorityPillProps): React.JSX.Element | null {
  if (isPriorityNotApplicable(status, priorityApplicable)) {
    return <NotApplicablePriorityPill short={short} className={className} />;
  }
  const effective = effectivePriority(status, priority, priorityApplicable);
  if (effective) {
    return (
      <PriorityBandPill
        priority={effective}
        className={className}
        {...(hint ? { title: `${PRIORITY_BAND_TITLE[effective]}. ${hint}` } : {})}
      />
    );
  }
  return <>{fallback}</>;
}

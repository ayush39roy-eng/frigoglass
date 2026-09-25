import * as React from 'react';

import { cn } from '@/lib/utils';
import type { ProjectPriority } from '@/types/enums';

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

const BAND_STYLES: Record<ProjectPriority, { dot: string; tint: string; label: string }> = {
  P1: { dot: 'bg-band-p1', tint: 'bg-band-p1/12', label: 'P1' },
  P2: { dot: 'bg-band-p2', tint: 'bg-band-p2/12', label: 'P2' },
  P3: { dot: 'bg-band-p3', tint: 'bg-band-p3/12', label: 'P3' },
  P4: { dot: 'bg-band-p4', tint: 'bg-band-p4/12', label: 'P4' },
  Q: { dot: 'bg-band-q', tint: 'bg-band-q/12', label: 'Q' },
};

const BAND_TITLE: Record<ProjectPriority, string> = {
  P1: 'Priority band P1 — highest',
  P2: 'Priority band P2',
  P3: 'Priority band P3',
  P4: 'Priority band P4 — lowest scored',
  Q: 'Queue — not yet scored',
};

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
  const style = BAND_STYLES[priority];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-sm px-1.5 py-0.5 text-2xs font-semibold leading-none text-text',
        style.tint,
        className,
      )}
      title={BAND_TITLE[priority]}
      {...props}
    >
      <span className={cn('size-1.5 shrink-0 rounded-full', style.dot)} aria-hidden="true" />
      {iconOnly ? <span className="sr-only">{BAND_TITLE[priority]}</span> : style.label}
    </span>
  );
}

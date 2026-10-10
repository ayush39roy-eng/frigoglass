import * as React from 'react';

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

import * as React from 'react';
import { ArrowUpFromLine } from 'lucide-react';

import { PriorityBandPill } from '@/components/shared/priority-band-pill';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { ProjectPriority } from '@/types/enums';

/**
 * P25 (ADR 0036): the SUGGESTED band, as served (Matrix grid, Compare, Priority board, Workspace). When the hub's P1 capacity
 * fill promoted the project (`capacity_fill`), it reads "P1 · capacity fill" in
 * a distinct outlined variant with a fill icon, plus a secondary line with the
 * served score band. The tooltip is the served `capacity_fill_reason`, shown
 * verbatim. A candidate that was not promoted keeps its normal chip and shows
 * its served reason in the tooltip only. Nothing is derived here (I9).
 */
export interface SuggestedBandChipProps {
  band: ProjectPriority;
  /** Served; undefined from a pre-P25 API (treated as false). */
  capacityFill?: boolean | undefined;
  reason?: string | null | undefined;
  scoreBand?: ProjectPriority | null | undefined;
  /** Hide the "score band" line (tight cells). */
  compact?: boolean;
  /** List rows: the fill variant reads "P1" with its icon and outline (the full label stays the
   *  accessible name and the tooltip). Implies `compact`. */
  dense?: boolean;
  /**
   * P58 (owner bug 2026-11-23): show a visible "Suggested" label ("Sugg." when `dense`) and an
   * outlined pill, for places with no column header saying what the band is (the Priority
   * board card and list row). Without it the score's band reads exactly like the project's
   * set priority, so after a priority move the card still seemed to show the old priority.
   */
  labelled?: boolean;
}

/**
 * P59 (owner 2026-11-23): where a row shows the project's SET priority, the
 * score's calculated band is not drawn beside it; it is this hover text on the
 * priority control instead. Served values only (I9).
 */
export function calculatedBandText(
  band: ProjectPriority | null | undefined,
  opts: { capacityFill?: boolean | null | undefined; scoreBand?: ProjectPriority | null | undefined } = {},
): string | null {
  if (!band) return null;
  if (opts.capacityFill === true) {
    return `Calculated from score: ${band} (capacity fill${opts.scoreBand ? `; score band ${opts.scoreBand}` : ''})`;
  }
  return `Calculated from score: ${band}`;
}

/** The tooltip of a labelled suggested band: what it is, and that it is not the priority. */
function suggestedBandTitle(band: ProjectPriority): string {
  return `Suggested band ${band}, from the project's score. It is not the project's priority; change that with the priority control.`;
}

export function SuggestedBandChip({ labelled = false, ...props }: SuggestedBandChipProps): React.JSX.Element {
  if (!labelled) return <BandChip {...props} />;
  const title = suggestedBandTitle(props.band);
  return (
    <span className="inline-flex items-center gap-1" data-testid="band-chip-suggested">
      <span className="text-2xs leading-none text-text-muted" title={title} data-testid="band-chip-suggested-label">
        {props.dense ? (
          <abbr title={title} className="no-underline">
            Sugg.
          </abbr>
        ) : (
          'Suggested'
        )}
      </span>
      <BandChip {...props} outlined />
    </span>
  );
}

function BandChip({
  band,
  capacityFill,
  reason,
  scoreBand,
  compact = false,
  dense = false,
  outlined = false,
}: Omit<SuggestedBandChipProps, 'labelled'> & { outlined?: boolean }): React.JSX.Element {
  // P58: a labelled chip is outlined so it never looks like the set-priority pill.
  const pill = outlined ? (
    <PriorityBandPill
      priority={band}
      className="bg-transparent ring-1 ring-inset ring-border-strong/60"
      title={suggestedBandTitle(band)}
    />
  ) : (
    <PriorityBandPill priority={band} />
  );
  if (capacityFill === true) {
    const name = `Suggested band P1 by capacity fill${scoreBand ? `, score band ${scoreBand}` : ''}`;
    const chip = (
      <span className="inline-flex flex-col items-start gap-0.5" data-testid="band-chip-capacity-fill">
        <span className="inline-flex items-center gap-1 rounded-sm border-[1.5px] border-band-p1 bg-surface px-1.5 py-0.5 text-2xs font-semibold leading-none text-text">
          <ArrowUpFromLine className="size-3 shrink-0 text-band-p1" aria-hidden="true" />
          {dense ? 'P1' : 'P1 · capacity fill'}
        </span>
        {scoreBand && !compact && !dense ? (
          <span className="text-[10px] leading-none text-text-muted" data-testid="band-chip-score-band">
            score band {scoreBand}
          </span>
        ) : null}
      </span>
    );
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={name}
            className="rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {chip}
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs text-left" data-testid="band-chip-reason">
          {reason ?? 'Promoted to P1 by the hub’s capacity fill.'}
        </TooltipContent>
      </Tooltip>
    );
  }
  if (reason) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={`Suggested band ${band}`}
            className={cn('rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring')}
            data-testid="band-chip-with-reason"
          >
            {pill}
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs text-left" data-testid="band-chip-reason">
          {reason}
        </TooltipContent>
      </Tooltip>
    );
  }
  return pill;
}

import * as React from 'react';
import { CircleDashed } from 'lucide-react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/**
 * P26 (ADR 0037): a subtle "incomplete" marker for a scored project that has no
 * score on some ACTIVE dimensions (served `missing_dimension_keys`). Each missing
 * one counts 0 points; the score shown is still the server's. A focusable
 * button so the tooltip (the unscored dimensions, by label) is reachable by
 * keyboard; its accessible name carries the same list. Renders nothing when the
 * list is empty.
 */
export function IncompleteScoreMarker({
  missingLabels,
  compact = false,
  className,
}: {
  /** Icon only (dense grids); the word stays in the accessible name and tooltip. */
  compact?: boolean;
  /** Labels of the unscored active dimensions, display order. */
  missingLabels: readonly string[];
  className?: string;
}): React.JSX.Element | null {
  if (missingLabels.length === 0) return null;
  const n = missingLabels.length;
  const summary = `Incomplete: ${String(n)} ${n === 1 ? 'dimension' : 'dimensions'} not scored (${missingLabels.join(', ')}); each counts 0 points`;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(
            'inline-flex items-center gap-0.5 rounded-sm text-2xs font-medium text-text-muted',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            className,
          )}
          aria-label={summary}
          data-testid="incomplete-marker"
        >
          <CircleDashed className="size-3.5" aria-hidden="true" />
          {compact ? null : <span aria-hidden="true">incomplete</span>}
        </button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs text-left">
        <span className="block font-semibold">Incomplete score</span>
        <span className="block text-text-inverse/80">Not scored yet (each counts 0 points):</span>
        <ul className="mt-0.5 list-disc pl-4">
          {missingLabels.map((label) => (
            <li key={label}>{label}</li>
          ))}
        </ul>
      </TooltipContent>
    </Tooltip>
  );
}

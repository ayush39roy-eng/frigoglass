import * as React from 'react';

import { PriorityBandPill } from '@/components/shared/priority-band-pill';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatInteger } from '@/lib/format';

import { BAND_THRESHOLDS, type PriorityMatrixRow } from '../api/types';
import { HardGateBadge } from './hard-gate-badge';

/**
 * The prioritization score cell (`frontend-builder` SKILL names this as an
 * explicitly domain-specific component — built here, not sourced).
 *
 * Every value shown is read verbatim from one `PriorityMatrixRow` field:
 *   - `normalized_pct`  — backend: round(weighted_score / (280 × 5) × 100)
 *   - `weighted_score`  — backend: Σ(dimension_score × weight)
 *   - `suggested_band`  — backend: banded from `normalized_pct`
 * Nothing is recomputed here (Invariant I9). The threshold table is shown as
 * static rule copy so the band is *legible*, not to derive it.
 */

function BandDerivationTooltip({
  pct,
  weighted,
}: {
  pct: number;
  weighted: number | null;
}): React.JSX.Element {
  return (
    <TooltipContent className="max-w-xs text-left">
      <span className="block">
        Weighted score <strong>{weighted === null ? '—' : formatInteger(weighted)}</strong> ·
        normalized <strong>{pct}%</strong> (both computed server-side).
      </span>
      <span className="mt-1 block font-semibold">Band thresholds (DOMAIN_RULES.md)</span>
      <ul className="mt-0.5">
        {BAND_THRESHOLDS.map((t, i) => {
          const label =
            i === BAND_THRESHOLDS.length - 1 ? `below ${BAND_THRESHOLDS[i - 1]?.min ?? 0}%` : `≥ ${t.min}%`;
          return (
            <li key={t.band}>
              {label} → {t.band}
            </li>
          );
        })}
      </ul>
    </TooltipContent>
  );
}

export function ScoreCell({ row }: { row: PriorityMatrixRow }): React.JSX.Element {
  if (!row.has_score || row.normalized_pct === null || row.suggested_band === null) {
    return (
      <span className="inline-flex items-center gap-1 text-2xs text-text-subtle" data-testid="score-cell-unscored">
        Not scored
      </span>
    );
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5" data-testid="score-cell">
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            className="inline-flex items-baseline gap-1 rounded-sm underline decoration-dotted underline-offset-2"
          >
            <span className="tnum text-sm font-semibold text-text" data-numeric="">
              {row.normalized_pct}%
            </span>
            <span className="tnum text-2xs text-text-muted" data-numeric="">
              ({row.weighted_score === null ? '—' : formatInteger(row.weighted_score)})
            </span>
          </button>
        </TooltipTrigger>
        <BandDerivationTooltip pct={row.normalized_pct} weighted={row.weighted_score} />
      </Tooltip>
      <PriorityBandPill priority={row.suggested_band} />
      <HardGateBadge gates={row.hard_gates} />
    </span>
  );
}

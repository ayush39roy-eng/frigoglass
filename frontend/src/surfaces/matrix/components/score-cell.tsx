import * as React from 'react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { formatInteger } from '@/lib/format';

import { BAND_THRESHOLDS, POINTS_RULE_COPY, type PriorityMatrixRow } from '../api/types';
import { formatOutOf100, rowBand, rowNormalizedScore } from '../lib/row-scores';
import { HardGateBadge } from './hard-gate-badge';
import { SuggestedBandChip } from './suggested-band-chip';

/**
 * The prioritization score cell (`frontend-builder` SKILL names this as an
 * explicitly domain-specific component — built here, not sourced).
 *
 * Every value shown is read verbatim from one `PriorityMatrixRow` field:
 *   - `normalized_pct`  — backend: round(weighted_score / total_weight × 100),
 *     shown out of 100 ("91/100", P21)
 *   - `weighted_score`  — backend: Σ points (score/5 × weight)
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
        normalized <strong>{formatOutOf100(pct)}</strong> (both computed server-side).
      </span>
      <span className="mt-1 block">{POINTS_RULE_COPY}</span>
      <span className="mt-1 block font-semibold">Band thresholds (DOMAIN_RULES.md)</span>
      <ul className="mt-0.5">
        {BAND_THRESHOLDS.map((t, i) => {
          const label =
            i === BAND_THRESHOLDS.length - 1
              ? `below ${String(BAND_THRESHOLDS[i - 1]?.min ?? 0)}/100`
              : `≥ ${String(t.min)}/100`;
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
  const score = rowNormalizedScore(row);
  const band = rowBand(row);
  if (!row.has_score || score === null || band === null || band === 'Unscored') {
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
            aria-label={`Score ${formatOutOf100(score)}, band ${band}`}
          >
            <span className="tnum text-sm font-semibold text-text" data-numeric="" data-testid="score-out-of-100">
              {formatOutOf100(score)}
            </span>
          </button>
        </TooltipTrigger>
        <BandDerivationTooltip pct={score} weighted={row.weighted_score} />
      </Tooltip>
      <SuggestedBandChip
        band={band}
        capacityFill={row.capacity_fill}
        reason={row.capacity_fill_reason}
        scoreBand={row.score_band}
      />
      <HardGateBadge gates={row.hard_gates} />
    </span>
  );
}

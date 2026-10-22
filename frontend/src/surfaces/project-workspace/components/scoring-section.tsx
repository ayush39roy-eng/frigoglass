import * as React from 'react';
import { Pencil, Save, X } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { SuggestedBandChip } from '@/components/shared/suggested-band-chip';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ApiError } from '@/lib/api/client';
import { SCORING_SCALE, scoringAnchor } from '@/lib/domain-constants';
import { IncompleteScoreMarker } from '@/components/shared/incomplete-score-marker';
import { usePermission } from '@/stores/session';
import { formatInteger } from '@/lib/format';
import { queryKeys } from '@/lib/query-keys';
import { HARD_GATE_REASONS, type HardGateReason } from '@/types/enums';
import { updatePriorityScore } from '@/surfaces/matrix/api/matrix-api';
import { POINTS_RULE_COPY, type DimensionScoreMap, type PriorityScoreUpdateRequest } from '@/surfaces/matrix/api/types';
import { changedScores, scoresFromDimensionScores, toRequestBody } from '@/surfaces/matrix/components/score-edit-schema';
import { rowMissingLabels } from '@/surfaces/matrix/lib/row-scores';
import {
  FetchedScoringModelProvider,
  formatWeight,
  modelFromDimensionScores,
  useScoringModel,
  type ScoringModelEntry,
} from '@/surfaces/matrix/scoring-model';

import type { WorkspacePriorityScore } from '../api/types';

/**
 * The project's scoring dimensions + the three P1-forcing hard gates, with the
 * deck's 1 / 5 anchors where the deck describes a dimension. P26 (ADR 0037):
 * the rows are the served ACTIVE dimensions (`dimension_scores`, display order;
 * for an unscored project the served table of `GET /priorities/dimensions`),
 * never a fixed list. Weighted score, normalised % and band are the server's
 * (I9) — shown, never computed. Saves through the Matrix's
 * `PUT /priorities/{id}` (same endpoint, same RBAC: Matrix write) with only the
 * dimensions changed here (`{scores, hard_gates}`; "Not scored" clears).
 */
export function ScoringSection(props: {
  projectId: string;
  score: WorkspacePriorityScore | null;
  canWrite: boolean;
}): React.JSX.Element {
  // The served table needs Matrix read; a Workspace viewer without it reads the score's own list.
  const matrixRead = usePermission('matrix').read;
  return (
    <FetchedScoringModelProvider enabled={matrixRead || props.canWrite}>
      <ScoringSectionInner {...props} />
    </FetchedScoringModelProvider>
  );
}

function ScoringSectionInner({
  projectId,
  score,
  canWrite,
}: {
  projectId: string;
  score: WorkspacePriorityScore | null;
  canWrite: boolean;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const model = useScoringModel();
  const served = new Map(model.dimensions.map((d) => [d.key, d]));
  // The project's own served list first (its active dimensions), else the served table.
  const dims: ScoringModelEntry[] = score
    ? modelFromDimensionScores(score.dimension_scores).map((d) => ({ ...d, scaled_weight: served.get(d.key)?.scaled_weight ?? null }))
    : [...model.dimensions];
  const base: DimensionScoreMap = score ? scoresFromDimensionScores(score.dimension_scores) : {};
  const missing = score
    ? rowMissingLabels({ has_score: score.weighted_score !== null, missing_dimension_keys: score.missing_dimension_keys, dimension_scores: score.dimension_scores })
    : [];
  const [editing, setEditing] = React.useState(false);
  const [scores, setScores] = React.useState<DimensionScoreMap>(base);
  const [gates, setGates] = React.useState<HardGateReason[]>(score?.hard_gates ?? []);
  const [error, setError] = React.useState<string | null>(null);

  const save = useMutation({
    mutationFn: (body: PriorityScoreUpdateRequest) => updatePriorityScore(projectId, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projectWorkspace(projectId) });
      void queryClient.invalidateQueries({ queryKey: ['priority-matrix'] });
      // P21-T05 / P25-T04: the board cards show the served score and suggested band too.
      void queryClient.invalidateQueries({ queryKey: ['priority-board'] });
      setEditing(false);
    },
    onError: (err) => {
      setError(
        err instanceof ApiError && err.isForbidden
          ? 'Your role cannot edit prioritization scores.'
          : err instanceof ApiError
            ? (err.detail ?? 'The scores could not be saved.')
            : 'The scores could not be saved.',
      );
    },
  });

  return (
    <section aria-labelledby="ws-scoring-heading" className="space-y-2" data-testid="scoring-section">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="ws-scoring-heading" className="label-caps text-text-muted">
          Prioritization scoring
        </h3>
        {score ? (
          <span className="flex items-center gap-2 text-2xs text-text-muted" data-numeric="">
            {/* P9-R03: all three derived figures are nullable server-side (not yet
                computed). Each shows "—" / "No band" on its own; nothing is derived here. */}
            Weighted{' '}
            <strong className="text-text" data-testid="score-weighted">
              {score.weighted_score === null ? '—' : formatInteger(score.weighted_score)}
            </strong>{' '}
            · normalised{' '}
            <strong className="text-text" data-testid="score-normalized">
              {score.normalized_pct === null ? '—' : `${String(score.normalized_pct)}%`}
            </strong>
            {score.suggested_band === null ? (
              <span className="text-text-subtle" data-testid="score-band-none">
                No band
              </span>
            ) : (
              // P25-T04: the served suggested band (after the hub's P1 capacity fill), same chip as the Matrix.
              <span data-testid="score-suggested-band">
                <SuggestedBandChip
                  band={score.suggested_band}
                  capacityFill={score.capacity_fill}
                  reason={score.capacity_fill_reason}
                  scoreBand={score.score_band}
                />
              </span>
            )}
          </span>
        ) : (
          <span className="text-2xs text-text-subtle">Not scored yet</span>
        )}
        {missing.length > 0 ? (
          <p className="basis-full text-2xs text-text-muted" data-testid="score-incomplete">
            <IncompleteScoreMarker missingLabels={missing} /> {missing.length} of {dims.length} dimensions not scored
          </p>
        ) : null}
        {score?.capacity_fill_reason ? (
          <p className="basis-full text-2xs text-text-muted" data-testid="score-fill-reason">
            {score.capacity_fill_reason}
          </p>
        ) : null}
        {canWrite && !editing ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setScores(base);
              setGates(score?.hard_gates ?? []);
              setError(null);
              setEditing(true);
            }}
          >
            <Pencil />
            {score ? 'Edit scores' : 'Score this project'}
          </Button>
        ) : null}
      </div>

      {/* Pre-existing axe finding at 390 (scrollable-region-focusable), fixed in P25-T04: the
          scrolling table region is labelled and keyboard-focusable. */}
      <div
        className="overflow-x-auto rounded-dash border-[1.5px] border-border bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        role="region"
        aria-label="Dimension scores"
        tabIndex={0}
      >
        <table className="w-full border-collapse text-sm" aria-label="Scoring dimensions">
          <thead className="bg-surface-sunken text-2xs font-bold uppercase tracking-wider text-text-subtle">
            <tr>
              <th scope="col" className="px-3 py-3 text-left">Dimension</th>
              <th scope="col" className="px-3 py-3 text-right">Weight</th>
              <th scope="col" className="px-3 py-3 text-center">Score</th>
              <th scope="col" className="px-3 py-3 text-left">1 = … · 5 = …</th>
            </tr>
          </thead>
          <tbody>
            {dims.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-3 py-3 text-2xs text-text-muted">
                  The scoring dimensions are not available to your role here; open the Prioritization Matrix to score.
                </td>
              </tr>
            ) : null}
            {dims.map((d) => {
              const anchor = scoringAnchor(d.key);
              const id = `ws-score-${d.key}`;
              const current = editing ? (scores[d.key] ?? null) : (base[d.key] ?? null);
              return (
                <tr key={d.key} className="border-t border-border/70 transition-colors hover:bg-primary-subtle/30">
                  <th scope="row" className="px-3 py-2.5 text-left font-bold text-text">
                    {editing ? <label htmlFor={id}>{d.label}</label> : d.label}
                  </th>
                  <td className="px-2 py-1 text-right text-text-muted" data-numeric="">
                    {formatWeight(d.weight, d.scaled_weight)}
                  </td>
                  <td className="px-2 py-1 text-center" data-numeric="">
                    {editing ? (
                      <select
                        id={id}
                        value={current === null ? '' : String(current)}
                        onChange={(e) => {
                          const raw = e.target.value;
                          setScores((prev) => ({ ...prev, [d.key]: raw === '' ? null : Number(raw) }));
                        }}
                        className="h-7 rounded border border-border-strong bg-surface px-1 text-xs text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <option value="">– Not scored</option>
                        {SCORING_SCALE.map((s) => (
                          <option key={s.score} value={s.score}>
                            {s.score} — {s.label}
                          </option>
                        ))}
                      </select>
                    ) : current !== null ? (
                      <span className="font-mono font-semibold text-text">{current}</span>
                    ) : (
                      <span className="text-text-subtle" title="Not scored">
                        –<span className="sr-only">Not scored</span>
                      </span>
                    )}
                  </td>
                  <td className="px-2 py-1 text-2xs text-text-muted">
                    {anchor ? `1 = ${anchor.low} · 5 = ${anchor.high}` : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="text-2xs text-text-subtle">{POINTS_RULE_COPY}</p>

      <fieldset className="space-y-1">
        <legend className="text-2xs font-semibold text-text-muted">Hard gates (force P1)</legend>
        {HARD_GATE_REASONS.map((g) => (
          <label key={g} className="flex items-center gap-2 text-xs text-text">
            <Checkbox
              checked={(editing ? gates : (score?.hard_gates ?? [])).includes(g)}
              disabled={!editing}
              onCheckedChange={(next) => setGates((prev) => (next === true ? [...new Set([...prev, g])] : prev.filter((x) => x !== g)))}
            />
            {g}
          </label>
        ))}
      </fieldset>

      {error ? (
        <p role="alert" className="text-2xs text-danger">
          {error}
        </p>
      ) : null}
      {editing ? (
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>
            <X />
            Cancel
          </Button>
          <Button type="button" size="sm" disabled={save.isPending} onClick={() => save.mutate(toRequestBody(changedScores(base, scores), gates))}>
            <Save />
            {save.isPending ? 'Saving…' : 'Save scores'}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

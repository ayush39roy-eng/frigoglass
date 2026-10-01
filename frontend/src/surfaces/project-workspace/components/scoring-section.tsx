import * as React from 'react';
import { Pencil, Save, X } from 'lucide-react';
import { useMutation, useQueryClient } from '@tanstack/react-query';

import { PriorityBandPill } from '@/components/shared/priority-band-pill';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ApiError } from '@/lib/api/client';
import { SCORING_ANCHORS, SCORING_SCALE } from '@/lib/domain-constants';
import { formatInteger } from '@/lib/format';
import { queryKeys } from '@/lib/query-keys';
import { HARD_GATE_REASONS, type HardGateReason } from '@/types/enums';
import { updatePriorityScore } from '@/surfaces/matrix/api/matrix-api';
import { DIMENSIONS, type DimensionField, type PriorityScoreUpdateRequest } from '@/surfaces/matrix/api/types';

import type { WorkspacePriorityScore } from '../api/types';

/**
 * The 13 scoring dimensions + the three P1-forcing hard gates, with the deck's
 * 1 / 5 anchors beside every dimension. Weighted score, normalised % and band
 * are the server's (I9) — shown, never computed. Saves through the Matrix's
 * `PUT /priorities/{id}` (same endpoint, same RBAC: Matrix write).
 */
type Scores = Record<DimensionField, number>;

function scoresOf(ps: WorkspacePriorityScore | null): Scores {
  return Object.fromEntries(DIMENSIONS.map((d) => [d.field, ps ? ps[d.field] : 3])) as Scores;
}

export function ScoringSection({
  projectId,
  score,
  canWrite,
}: {
  projectId: string;
  score: WorkspacePriorityScore | null;
  canWrite: boolean;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [editing, setEditing] = React.useState(false);
  const [scores, setScores] = React.useState<Scores>(() => scoresOf(score));
  const [gates, setGates] = React.useState<HardGateReason[]>(score?.hard_gates ?? []);
  const [error, setError] = React.useState<string | null>(null);

  const save = useMutation({
    mutationFn: (body: PriorityScoreUpdateRequest) => updatePriorityScore(projectId, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.projectWorkspace(projectId) });
      void queryClient.invalidateQueries({ queryKey: ['priority-matrix'] });
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
              <PriorityBandPill priority={score.suggested_band} />
            )}
          </span>
        ) : (
          <span className="text-2xs text-text-subtle">Not scored yet</span>
        )}
        {canWrite && !editing ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setScores(scoresOf(score));
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

      <div className="overflow-x-auto rounded-dash border-[1.5px] border-border bg-surface">
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
            {DIMENSIONS.map((d) => {
              const anchor = SCORING_ANCHORS[d.field];
              const id = `ws-score-${d.field}`;
              return (
                <tr key={d.field} className="border-t border-border/70 transition-colors hover:bg-primary-subtle/30">
                  <th scope="row" className="px-3 py-2.5 text-left font-bold text-text">
                    {editing ? <label htmlFor={id}>{d.label}</label> : d.label}
                  </th>
                  <td className="px-2 py-1 text-right text-text-muted" data-numeric="">
                    {d.weight}
                  </td>
                  <td className="px-2 py-1 text-center" data-numeric="">
                    {editing ? (
                      <select
                        id={id}
                        value={scores[d.field]}
                        onChange={(e) => setScores((prev) => ({ ...prev, [d.field]: Number(e.target.value) }))}
                        className="h-7 rounded border border-border-strong bg-surface px-1 text-xs text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        {SCORING_SCALE.map((s) => (
                          <option key={s.score} value={s.score}>
                            {s.score} — {s.label}
                          </option>
                        ))}
                      </select>
                    ) : score ? (
                      <span className="font-mono font-semibold text-text">{score[d.field]}</span>
                    ) : (
                      <span className="text-text-subtle">–</span>
                    )}
                  </td>
                  <td className="px-2 py-1 text-2xs text-text-muted">
                    1 = {anchor.low} · 5 = {anchor.high}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

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
          <Button type="button" size="sm" disabled={save.isPending} onClick={() => save.mutate({ ...scores, hard_gates: gates })}>
            <Save />
            {save.isPending ? 'Saving…' : 'Save scores'}
          </Button>
        </div>
      ) : null}
    </section>
  );
}

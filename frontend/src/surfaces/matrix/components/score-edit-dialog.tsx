import * as React from 'react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { ApiError } from '@/lib/api/client';
import { formatDecimal } from '@/lib/format';
import { HARD_GATE_REASONS, type HardGateReason } from '@/types/enums';

import {
  SCORE_RANGE_HELP_COPY,
  type DimensionScoreMap,
  type PriorityMatrixRow,
  type PriorityScoreUpdateRequest,
} from '../api/types';
import { groupByPillar } from '../lib/pillars';
import { rowMissingLabels } from '../lib/row-scores';
import { useScoringModel } from '../scoring-model';
import { formatWeight } from '../lib/scoring-model-core';
import { IncompleteScoreMarker } from '@/components/shared/incomplete-score-marker';
import { FromRegistrationHint } from '@/components/shared/scoring-tags';
import { changedScores, scoresFromDimensionScores, toRequestBody } from './score-edit-schema';

/**
 * Inline edit of the dimension scores + hard gates for one project.
 *
 * P26 (ADR 0037): the fields are the row's served ACTIVE dimensions
 * (`dimension_scores`, display order, grouped by pillar), however many there
 * are. Each is a 0–5 menu with "– Not scored"; the body sent is
 * `{scores, hard_gates}` with ONLY the dimensions changed in this dialog
 * (omitted keys keep their stored value; choosing "– Not scored" sends null,
 * which clears it). The menu makes every value valid by construction; the
 * backend re-validates and is the authority.
 *
 * Two modes (P5-T01), selected by the caller — this component itself never
 * calls the network, it only calls `onSubmit`:
 *   - `'immediate'` (default, unchanged behaviour): writes immediately via
 *     `PUT /priorities/{id}`. On success the caller invalidates the
 *     priority-matrix queries; this never triggers a schedule run.
 *   - `'scenario'`: the caller stages the edit locally (Zustand
 *     `useScenarioStore`) instead of writing to the server — nothing is real
 *     until a later "Apply" action. Only the dialog's copy/button label
 *     differ; the form fields and validation are identical.
 */

export interface ScoreEditDialogProps {
  row: PriorityMatrixRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (projectId: string, body: PriorityScoreUpdateRequest) => Promise<unknown>;
  /** @default 'immediate' */
  mode?: 'immediate' | 'scenario';
}


export function ScoreEditDialog({
  row,
  open,
  onOpenChange,
  onSubmit,
  mode = 'immediate',
}: ScoreEditDialogProps): React.JSX.Element {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        {row ? (
          <ScoreEditForm
            key={row.project_id}
            row={row}
            onOpenChange={onOpenChange}
            onSubmit={onSubmit}
            mode={mode}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

const SCORE_OPTIONS = [0, 1, 2, 3, 4, 5] as const;

function ScoreEditForm({
  row,
  onOpenChange,
  onSubmit,
  mode,
}: {
  row: PriorityMatrixRow;
  onOpenChange: (open: boolean) => void;
  onSubmit: ScoreEditDialogProps['onSubmit'];
  mode: 'immediate' | 'scenario';
}): React.JSX.Element {
  const model = useScoringModel();
  const weightOf = new Map(model.dimensions.map((d) => [d.key, d]));
  const groups = groupByPillar(row.dimension_scores);
  const base = React.useMemo(() => scoresFromDimensionScores(row.dimension_scores), [row.dimension_scores]);
  const [values, setValues] = React.useState<DimensionScoreMap>(base);
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const [submitting, setSubmitting] = React.useState(false);
  const [gates, setGates] = React.useState<HardGateReason[]>([...row.hard_gates]);
  const changed = changedScores(base, values);
  const changedCount = Object.keys(changed).length;
  const gatesChanged =
    gates.length !== row.hard_gates.length || gates.some((g) => !row.hard_gates.includes(g));
  const missing = rowMissingLabels(row);
  const n = row.dimension_scores.length;
  // P27 (ADR 0038): dimensions pre-filled by the Registration tags (served). Hint only; still editable.
  const fromRegistration = new Set(row.tag_dimension_keys);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitError(null);
    if (changedCount === 0 && !gatesChanged) {
      onOpenChange(false);
      return;
    }
    setSubmitting(true);
    try {
      await onSubmit(row.project_id, toRequestBody(changed, gates));
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError && err.isForbidden) {
        setSubmitError(
          mode === 'scenario'
            ? 'Your role cannot apply scenario changes.'
            : 'Your role cannot edit prioritization scores.',
        );
      } else if (err instanceof ApiError && err.code === 'UNKNOWN_DIMENSION_KEY') {
        setSubmitError(
          'The scoring rubric changed while you were editing: a dimension you changed is no longer active. Close and reopen to score the current dimensions.',
        );
      } else if (err instanceof ApiError) {
        setSubmitError(
          err.detail ??
            (mode === 'scenario'
              ? 'The change could not be staged. Please try again.'
              : 'The score could not be saved. Please try again.'),
        );
      } else {
        setSubmitError(
          mode === 'scenario'
            ? 'The change could not be staged. Please try again.'
            : 'The score could not be saved. Please try again.',
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  const dimsText = `${String(n)} ${n === 1 ? 'dimension' : 'dimensions'}, each 0–5`;
  return (
    <form onSubmit={(e) => void submit(e)} noValidate>
      <DialogHeader>
        <DialogTitle>
          {mode === 'scenario' ? 'Stage prioritization score change' : 'Edit prioritization score'}
        </DialogTitle>
        <DialogDescription>
          {mode === 'scenario' ? (
            <>
              {row.project_name} — {dimsText}. This stages the change locally only; nothing is sent to the server
              until you Apply the scenario.
            </>
          ) : (
            <>
              {row.project_name} — {dimsText}. The weighted score and band are recomputed by the server on save.
              This does not apply priorities or re-run the schedule.
            </>
          )}
        </DialogDescription>
      </DialogHeader>

      <p className="mt-2 text-2xs text-text-muted" id="score-range-help" data-testid="score-range-help">
        {SCORE_RANGE_HELP_COPY}. “– Not scored” counts 0 points and marks the score incomplete. Only the dimensions you
        change are sent.
      </p>
      {missing.length > 0 ? (
        <p className="mt-1 flex items-center gap-1.5 text-2xs text-text-muted" data-testid="score-edit-incomplete">
          <IncompleteScoreMarker missingLabels={missing} />
          <span>
            {missing.length} of {n} not scored.
          </span>
        </p>
      ) : null}

      <div className="my-4 max-h-[52vh] space-y-4 overflow-y-auto pr-1">
        {n === 0 ? (
          <p className="text-xs text-text-muted">No active scoring dimensions are served for this project.</p>
        ) : null}
        {groups.map((group) => (
          <fieldset key={group.pillar} className="space-y-2" data-testid="score-edit-pillar">
            <legend className="text-2xs font-semibold uppercase tracking-wide text-text-muted">{group.pillar}</legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {group.items.map((dim) => {
                const id = `score-${dim.key}`;
                const served = weightOf.get(dim.key);
                const value = values[dim.key] ?? null;
                const dirty = Object.prototype.hasOwnProperty.call(changed, dim.key);
                return (
                  <div key={dim.key} className="flex items-center justify-between gap-2">
                    <span className="flex min-w-0 flex-wrap items-center gap-1">
                      <label
                        htmlFor={id}
                        className="text-xs text-text"
                        title={`weight ${formatWeight(served?.weight ?? dim.weight, served?.scaled_weight ?? null)}`}
                      >
                        {dim.label}
                        {dirty ? <span className="ml-1 text-2xs font-semibold text-warning-subtle-fg">edited</span> : null}
                      </label>
                      {fromRegistration.has(dim.key) ? <FromRegistrationHint dimensionLabel={dim.label} compact /> : null}
                    </span>
                    <select
                      id={id}
                      value={value === null ? '' : String(value)}
                      aria-describedby="score-range-help"
                      onChange={(e) => {
                        const raw = e.target.value;
                        setValues((prev) => ({ ...prev, [dim.key]: raw === '' ? null : Number(raw) }));
                      }}
                      className={
                        'h-8 w-28 rounded border bg-surface px-1 text-xs text-text tnum focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ' +
                        (dirty ? 'border-warning font-semibold' : 'border-border-strong')
                      }
                      data-testid="score-edit-select"
                    >
                      <option value="">– Not scored</option>
                      {SCORE_OPTIONS.map((opt) => (
                        <option key={opt} value={String(opt)}>
                          {opt}
                        </option>
                      ))}
                    </select>
                  </div>
                );
              })}
            </div>
          </fieldset>
        ))}

        <FinancialsReadOnly row={row} />

        <fieldset className="space-y-2">
          <legend className="text-2xs font-semibold uppercase tracking-wide text-text-muted">
            Hard gates — override band, force P1 (DOMAIN_RULES.md)
          </legend>
          <div className="space-y-1.5">
            {HARD_GATE_REASONS.map((reason) => {
              const checked = gates.includes(reason);
              return (
                <label key={reason} className="flex items-center gap-2 text-xs">
                  <Checkbox
                    checked={checked}
                    onCheckedChange={(next) => {
                      const on = next === true;
                      setGates((prev) =>
                        on ? [...prev, reason] : prev.filter((g) => g !== reason),
                      );
                    }}
                  />
                  {reason}
                </label>
              );
            })}
          </div>
        </fieldset>
      </div>

      {submitError ? (
        <p role="alert" className="mb-2 text-2xs text-danger">
          {submitError}
        </p>
      ) : null}

      <DialogFooter>
        <Button type="button" variant="secondary" size="sm" onClick={() => onOpenChange(false)}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={submitting}>
          {mode === 'scenario'
            ? submitting
              ? 'Staging…'
              : 'Stage change'
            : submitting
              ? 'Saving…'
              : 'Save score'}
        </Button>
      </DialogFooter>
    </form>
  );
}

/**
 * P21: the financial figures left the grid; they stay here, read-only and
 * unchanged, for the roles that may open this dialog. Values are the row's
 * served fields, already converted to `row.currency` by the server
 * (`gross_margin_pct` is never converted). Nothing is computed.
 */
function FinancialsReadOnly({ row }: { row: PriorityMatrixRow }): React.JSX.Element {
  const c = row.currency;
  const items: { label: string; value: number | null; suffix?: string }[] = [
    { label: `CAPEX (k ${c})`, value: row.capex_keur },
    { label: `RM savings (k ${c})`, value: row.rm_savings_keur },
    { label: `TCOGS (${c})`, value: row.tcogs_eur },
    { label: `Selling price (${c})`, value: row.selling_price_eur },
    { label: 'Gross margin %', value: row.gross_margin_pct, suffix: '%' },
  ];
  return (
    <section aria-labelledby="score-edit-financials" className="space-y-2" data-testid="score-edit-financials">
      <h3 id="score-edit-financials" className="text-2xs font-semibold uppercase tracking-wide text-text-muted">
        Financials — read only, in {c} (converted server-side)
      </h3>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs sm:grid-cols-3">
        {items.map((it) => (
          <div key={it.label} className="flex flex-col">
            <dt className="text-2xs text-text-muted">{it.label}</dt>
            <dd className="tnum text-text" data-numeric="">
              {it.value === null ? '–' : `${formatDecimal(it.value)}${it.suffix ?? ''}`}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

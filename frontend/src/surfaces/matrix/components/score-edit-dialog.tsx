import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';

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
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/api/client';
import { formatDecimal } from '@/lib/format';
import { HARD_GATE_REASONS, type HardGateReason } from '@/types/enums';

import {
  SCORE_RANGE_HELP_COPY,
  type PriorityMatrixRow,
  type PriorityScoreUpdateRequest,
} from '../api/types';
import { formatWeight, useScoringModel } from '../scoring-model';
import {
  dimensionDefaultsFromRow,
  scoreDimensionsSchema,
  toRequestBody,
  type ScoreDimensionsInput,
  type ScoreDimensionsValues,
} from './score-edit-schema';

/**
 * Inline edit of the 13 dimension scores + hard gates for one project.
 * `react-hook-form` + `zod` (`frontend-builder` SKILL) — client validation for
 * responsiveness only; the backend re-validates and is the authority.
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
  const pillars = [...new Set(model.dimensions.map((d) => d.pillar))];
  const [submitError, setSubmitError] = React.useState<string | null>(null);
  const [gates, setGates] = React.useState<HardGateReason[]>([...row.hard_gates]);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<ScoreDimensionsInput, unknown, ScoreDimensionsValues>({
    resolver: zodResolver(scoreDimensionsSchema),
    defaultValues: dimensionDefaultsFromRow(row),
    mode: 'onChange',
  });

  const submit = handleSubmit(async (values) => {
    setSubmitError(null);
    try {
      await onSubmit(row.project_id, toRequestBody(values, gates));
      onOpenChange(false);
    } catch (err) {
      if (err instanceof ApiError && err.isForbidden) {
        setSubmitError(
          mode === 'scenario'
            ? 'Your role cannot apply scenario changes.'
            : 'Your role cannot edit prioritization scores.',
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
    }
  });

  return (
    <form onSubmit={submit} noValidate>
      <DialogHeader>
        <DialogTitle>
          {mode === 'scenario' ? 'Stage prioritization score change' : 'Edit prioritization score'}
        </DialogTitle>
        <DialogDescription>
          {mode === 'scenario' ? (
            <>
              {row.project_name} — 13 dimensions, each 0–5. This stages the change locally only;
              nothing is sent to the server until you Apply the scenario.
            </>
          ) : (
            <>
              {row.project_name} — 13 dimensions, each 0–5. The weighted score and band are recomputed by
              the server on save. This does not apply priorities or re-run the schedule.
            </>
          )}
        </DialogDescription>
      </DialogHeader>

      <p className="mt-2 text-2xs text-text-muted" id="score-range-help" data-testid="score-range-help">
        {SCORE_RANGE_HELP_COPY}
      </p>

      <div className="my-4 max-h-[52vh] space-y-4 overflow-y-auto pr-1">
        {pillars.map((pillar) => (
          <fieldset key={pillar} className="space-y-2">
            <legend className="text-2xs font-semibold uppercase tracking-wide text-text-muted">
              {pillar}
            </legend>
            <div className="grid gap-2 sm:grid-cols-2">
              {model.dimensions.filter((d) => d.pillar === pillar).map((dim) => {
                const err = errors[dim.key];
                return (
                  <div key={dim.key} className="flex items-center justify-between gap-2">
                    <Label
                      htmlFor={dim.key}
                      className="text-xs"
                      title={`weight ${formatWeight(dim.weight, dim.scaled_weight)}`}
                    >
                      {dim.label}
                    </Label>
                    <div className="flex flex-col items-end">
                      <Input
                        id={dim.key}
                        type="number"
                        min={0}
                        max={5}
                        step={1}
                        inputMode="numeric"
                        className="h-8 w-16 text-right tnum"
                        aria-invalid={err ? true : undefined}
                        aria-describedby="score-range-help"
                        {...register(dim.key)}
                      />
                      {err ? (
                        <span role="alert" className="text-2xs text-danger">
                          {err.message}
                        </span>
                      ) : null}
                    </div>
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
        <Button type="submit" size="sm" disabled={isSubmitting}>
          {mode === 'scenario'
            ? isSubmitting
              ? 'Staging…'
              : 'Stage change'
            : isSubmitting
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

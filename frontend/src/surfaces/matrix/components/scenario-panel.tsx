import * as React from 'react';
import { CircleX, Layers, Redo2, Save, Trash2, Undo2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ApiError } from '@/lib/api/client';
import {
  computeScenarioDiff,
  effectivePendingEdits,
  isNoOpEdit,
  useScenarioStore,
  type ScenarioPendingEdit,
} from '@/stores/scenario';

import { DIMENSIONS, type ScenarioApplyRequest } from '../api/types';
import { useApplyScenario } from '../hooks/use-matrix';

/**
 * Scenario mode (P5-T01) UI for the Prioritization Matrix.
 *
 * `ScenarioModeToggle` switches the grid's inline edit from "immediate write"
 * (`PUT /priorities/{id}`, untouched) to "stage a pending change" (this
 * store, nothing sent until Apply). `ScenarioPendingPanel` lists what is
 * staged, with Undo/Redo over the local edit history and Apply/Discard.
 *
 * Every diff line below is a raw field-for-field comparison of the staged
 * `next` values against the project's live `baseline` values captured when it
 * was first staged — never a recomputed score/band/currency figure
 * (Invariant I9: scoring math is server-only).
 */

export function ScenarioModeToggle({ disabled = false }: { disabled?: boolean }): React.JSX.Element {
  const active = useScenarioStore((s) => s.active);
  const setActive = useScenarioStore((s) => s.setActive);
  const stagedCount = useScenarioStore((s) => effectivePendingEdits(s.pending).length);
  // Two DIFFERENT ids — a shared `htmlFor` between the group heading ("Edit
  // mode") and the checkbox's own label ("Scenario mode") would make the
  // checkbox's accessible name the concatenation of both labels' text.
  const groupId = React.useId();
  const checkboxId = React.useId();

  return (
    <div className="flex flex-col gap-1">
      <Label id={groupId} className="text-2xs text-text-muted">
        Edit mode
      </Label>
      <div className="flex h-8 items-center gap-2" role="group" aria-labelledby={groupId}>
        <Checkbox
          id={checkboxId}
          checked={active}
          disabled={disabled}
          onCheckedChange={(next) => setActive(next === true)}
        />
        <label htmlFor={checkboxId} className="flex items-center gap-1.5 text-xs text-text">
          <Layers aria-hidden="true" className="size-3.5" />
          Scenario mode
        </label>
        {active && stagedCount > 0 ? (
          <Badge tone="primary" data-numeric="" data-testid="scenario-staged-count">
            {stagedCount} staged
          </Badge>
        ) : null}
      </div>
    </div>
  );
}

/** Raw field-for-field diff lines for one staged edit — display only. */
function diffEntries(edit: ScenarioPendingEdit): { label: string; from: string; to: string }[] {
  const entries: { label: string; from: string; to: string }[] = [];
  for (const dim of DIMENSIONS) {
    if (edit.baseline[dim.field] !== edit.next[dim.field]) {
      entries.push({
        label: dim.label,
        from: String(edit.baseline[dim.field]),
        to: String(edit.next[dim.field]),
      });
    }
  }
  const removedGates = edit.baseline.hard_gates.filter((g) => !edit.next.hard_gates.includes(g));
  const addedGates = edit.next.hard_gates.filter((g) => !edit.baseline.hard_gates.includes(g));
  if (removedGates.length > 0 || addedGates.length > 0) {
    entries.push({
      label: 'Hard gates',
      from: edit.baseline.hard_gates.length > 0 ? edit.baseline.hard_gates.join(', ') : 'none',
      to: edit.next.hard_gates.length > 0 ? edit.next.hard_gates.join(', ') : 'none',
    });
  }
  return entries;
}

export interface ScenarioPendingPanelProps {
  /** The caller's role cannot write (`MATRIX`/`WRITE`) — Apply is disabled,
   *  matching the immediate-edit flow's own `writeForbidden` posture. */
  writeForbidden?: boolean;
}

export function ScenarioPendingPanel({
  writeForbidden = false,
}: ScenarioPendingPanelProps): React.JSX.Element | null {
  const active = useScenarioStore((s) => s.active);
  const pending = useScenarioStore((s) => s.pending);
  const notes = useScenarioStore((s) => s.notes);
  const setNotes = useScenarioStore((s) => s.setNotes);
  const past = useScenarioStore((s) => s.past);
  const future = useScenarioStore((s) => s.future);
  const undo = useScenarioStore((s) => s.undo);
  const redo = useScenarioStore((s) => s.redo);
  const removeEdit = useScenarioStore((s) => s.removeEdit);
  const reset = useScenarioStore((s) => s.reset);

  const applyScenarioMutation = useApplyScenario();
  const [error, setError] = React.useState<string | null>(null);

  if (!active) return null;

  const allStaged = Object.values(pending);
  const effectiveEdits = effectivePendingEdits(pending);
  const canApply = effectiveEdits.length > 0 && !writeForbidden && !applyScenarioMutation.isPending;
  const canDiscard = allStaged.length > 0 || notes.trim() !== '';

  async function handleApply(): Promise<void> {
    setError(null);
    const diff = computeScenarioDiff(pending);
    if (diff.length === 0) return;
    const body: ScenarioApplyRequest = {
      notes: notes.trim() === '' ? null : notes.trim(),
      priority_scores: diff,
    };
    try {
      await applyScenarioMutation.mutateAsync(body);
      reset();
    } catch (err) {
      if (err instanceof ApiError && err.isForbidden) {
        setError('Your role cannot apply scenario changes.');
      } else if (err instanceof ApiError) {
        setError(err.detail ?? 'The scenario could not be applied. Please try again.');
      } else {
        setError('The scenario could not be applied. Please try again.');
      }
    }
  }

  function handleDiscard(): void {
    setError(null);
    reset();
  }

  return (
    <Card data-testid="scenario-panel">
      <CardHeader>
        <CardTitle>Scenario — pending changes</CardTitle>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="sm" onClick={undo} disabled={past.length === 0}>
            <Undo2 />
            Undo
          </Button>
          <Button variant="ghost" size="sm" onClick={redo} disabled={future.length === 0}>
            <Redo2 />
            Redo
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <p className="text-2xs text-text-muted">
          Edits made in scenario mode are staged here only — nothing changes on the server until you
          Apply, which sends only the projects whose staged values genuinely differ from their
          current live score (<code>POST /scenarios/apply</code>).
        </p>

        {writeForbidden ? (
          <p role="alert" className="text-2xs text-danger">
            Your role has read-only access to the Prioritization Matrix — staged changes can be
            reviewed but not applied.
          </p>
        ) : null}

        {allStaged.length === 0 ? (
          <p className="text-2xs text-text-subtle" data-testid="scenario-empty">
            No staged changes yet — edit a project&rsquo;s score above to begin.
          </p>
        ) : (
          <ul className="space-y-2">
            {allStaged.map((edit) => {
              const entries = diffEntries(edit);
              const noOp = isNoOpEdit(edit);
              return (
                <li
                  key={edit.projectId}
                  className="rounded-lg border border-border bg-surface-raised px-3 py-2 text-xs"
                  data-testid="scenario-pending-item"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-medium text-text">
                      {edit.projectName} <span className="font-normal text-text-muted">· {edit.hub}</span>
                    </span>
                    <div className="flex items-center gap-2">
                      {!edit.hasScore ? <Badge tone="warning">New score</Badge> : null}
                      {noOp ? (
                        <Badge tone="neutral">No change</Badge>
                      ) : (
                        <Badge tone="primary" data-numeric="">
                          {entries.length} field{entries.length === 1 ? '' : 's'} changed
                        </Badge>
                      )}
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => removeEdit(edit.projectId)}
                        aria-label={`Remove staged change for ${edit.projectName}`}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </div>
                  {entries.length > 0 ? (
                    <ul className="mt-1.5 space-y-0.5 text-2xs text-text-muted">
                      {entries.map((entry) => (
                        <li key={entry.label}>
                          {entry.label}: <span className="tnum">{entry.from}</span> →{' '}
                          <span className="tnum font-medium text-text">{entry.to}</span>
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </li>
              );
            })}
          </ul>
        )}

        <div className="flex flex-col gap-1">
          <Label htmlFor="scenario-notes" className="text-2xs text-text-muted">
            Notes (optional)
          </Label>
          <Input
            id="scenario-notes"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            placeholder="Why this scenario…"
          />
        </div>

        {error ? (
          <p role="alert" className="text-2xs text-danger">
            {error}
          </p>
        ) : null}

        <div className="flex items-center justify-end gap-2">
          <Button variant="secondary" size="sm" onClick={handleDiscard} disabled={!canDiscard}>
            <CircleX />
            Discard
          </Button>
          <Button size="sm" onClick={() => void handleApply()} disabled={!canApply}>
            <Save />
            {applyScenarioMutation.isPending
              ? 'Applying…'
              : `Apply${effectiveEdits.length > 0 ? ` (${String(effectiveEdits.length)})` : ''}`}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

import * as React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, RefreshCw, Save, X } from 'lucide-react';

import { PlanRecalculateButton, useCanRecalculatePlan } from '@/components/shared/plan-recalc';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { ApiError } from '@/lib/api/client';
import { CONFLICT_COPY, sendEditWithBase } from '@/lib/api/edit-conflict';
import { apiErrorMessage } from '@/lib/api/error-messages';
import { queryKeys } from '@/lib/query-keys';
import { useEditConflict } from '@/lib/use-edit-conflict';
import { editFreshness } from '@/lib/use-edit-freshness';
import { usePermission } from '@/stores/session';
import type { ChamberRead } from '@/surfaces/planning/api/types';
import { fetchChambers } from '@/surfaces/planning/api/planning-api';
import { useUpdateChamber } from '@/surfaces/planning/hooks/use-planning';

/**
 * P62-F2 (owner 2026-11-25: "in workflow template there should be option to
 * check or uncheck this"): which lab-kind steps each chamber accepts, as one
 * tick box per chamber × lab step.
 *
 * - Data: `GET /chambers` (`allowed_stages`, the same list Capacity Planning's
 *   chamber form edits). Saves go through the same `PATCH /chambers/{id}` with
 *   `allowed_stages` and a `base` of the list as read (P47 / ADR 0059 edit
 *   base; a 409 asks whose list to keep). No backend change.
 * - Writers are the callers the PATCH accepts (`capacity_planning.write`); every
 *   other role sees the ticks read-only.
 * - After a save the chamber and workflow-settings queries are refetched, and a
 *   notice says the plan is not recalculated (ADR 0069: recalculation is
 *   manual), with "Recalculate" for Admin / Super Admin.
 * - The list order sent is the lab-step order shown, then any served id this
 *   grid does not show (kept, never silently dropped). The server validates
 *   the ids (`_validate_allowed_stages`).
 */
export interface LabStepColumn {
  workflowId: string;
  stepId: string;
  name: string;
}

export function ChamberStagesGrid({ labSteps }: { labSteps: readonly LabStepColumn[] }): React.JSX.Element | null {
  const { read: canRead, write: canWrite } = usePermission('capacity_planning');
  const [editing, setEditing] = React.useState<string | null>(null);
  // The same query (key and fetch) as Capacity Planning's chamber list; no
  // refetch replaces the ticks while a row is being edited (P47-T03).
  const chambers = useQuery({
    queryKey: queryKeys.chambers(),
    queryFn: ({ signal }) => fetchChambers({ signal }),
    enabled: canRead,
    retry: false,
    ...editFreshness(editing !== null),
  });
  const update = useUpdateChamber();
  const queryClient = useQueryClient();
  const conflict = useEditConflict();
  const canRecalc = useCanRecalculatePlan();
  const [savedCode, setSavedCode] = React.useState<string | null>(null);

  // Two workflows can share a step name; the accessible label then names the workflow.
  const nameCounts = new Map<string, number>();
  for (const s of labSteps) nameCounts.set(s.name, (nameCounts.get(s.name) ?? 0) + 1);
  const stepLabel = (s: LabStepColumn) => ((nameCounts.get(s.name) ?? 0) > 1 ? `${s.workflowId} ${s.name}` : s.name);

  if (!canRead || labSteps.length === 0) return null;

  const save = async (chamber: ChamberRead, next: string[]): Promise<string | null> => {
    try {
      const sent = await sendEditWithBase({
        body: { allowed_stages: next },
        original: chamber,
        send: (withBase) => update.mutateAsync({ chamberId: chamber.id, body: withBase }),
        ask: conflict.ask,
        onUseTheirs: () => queryClient.invalidateQueries({ queryKey: queryKeys.chambers() }),
      });
      if (sent.outcome === 'dismissed') return CONFLICT_COPY.dismissed;
      void queryClient.invalidateQueries({ queryKey: queryKeys.workflowSettings() });
      if (sent.outcome === 'theirs') return CONFLICT_COPY.theirs;
      setSavedCode(chamber.code);
      return null;
    } catch (err) {
      if (err instanceof ApiError && err.isForbidden) return 'Your role cannot change which steps a chamber accepts.';
      return apiErrorMessage(err, 'The chamber could not be saved.');
    }
  };

  return (
    <section className="mt-4 space-y-2" aria-labelledby="chamber-stages-title" data-testid="chamber-stages">
      {conflict.dialog}
      <div>
        <h3 id="chamber-stages-title" className="text-2xs font-bold uppercase tracking-wider text-text-subtle">
          Lab steps each chamber accepts
        </h3>
        <p className="text-2xs text-text-muted">
          A chamber only books the lab steps ticked here (the same setting as the chamber form on Capacity Planning).
          {canWrite ? ' Press Edit on a chamber, tick or untick, then Save.' : ' Read-only for your role.'}
        </p>
      </div>
      {savedCode !== null ? (
        <div
          role="status"
          data-testid="chamber-stages-stale"
          className="flex flex-wrap items-center gap-2 rounded-lg border border-warning/50 bg-warning-subtle px-3 py-2 text-2xs text-warning-subtle-fg"
        >
          <RefreshCw className="size-3.5 shrink-0" aria-hidden="true" />
          <span className="flex-1">
            <strong>{savedCode} saved — the plan is not recalculated.</strong> The active schedule still books chambers by
            the previous steps until {canRecalc ? 'you recalculate' : 'an Admin or Super Admin recalculates'}.
          </span>
          {canRecalc ? <PlanRecalculateButton /> : null}
          <Button type="button" variant="ghost" size="icon" className="size-6" onClick={() => setSavedCode(null)} aria-label="Dismiss">
            <X className="size-3.5" />
          </Button>
        </div>
      ) : null}
      {chambers.isError ? (
        <p role="alert" className="text-2xs text-danger">
          The chambers&apos; accepted steps could not be loaded.
        </p>
      ) : chambers.data === undefined ? (
        <p className="text-2xs text-text-muted">Loading chambers…</p>
      ) : (
        <div className="overflow-x-auto rounded-dash border-[1.5px] border-border bg-surface">
          <table className="w-full border-collapse text-sm" aria-label="Lab steps each chamber accepts">
            <thead className="bg-surface-sunken text-2xs font-bold uppercase tracking-wider text-text-subtle">
              <tr>
                <th scope="col" className="px-3 py-2 text-left">Chamber</th>
                {labSteps.map((s) => (
                  <th key={s.stepId} scope="col" className="px-2 py-2 text-center" title={s.name}>
                    <span className="block">{s.stepId}</span>
                    <span className="block max-w-[9rem] truncate font-medium normal-case tracking-normal">{s.name}</span>
                  </th>
                ))}
                {canWrite ? (
                  <th scope="col" className="px-3 py-2">
                    <span className="sr-only">Actions</span>
                  </th>
                ) : null}
              </tr>
            </thead>
            <tbody>
              {chambers.data.map((c) => (
                <ChamberStagesRow
                  key={`${c.id}-${c.allowed_stages.join(',')}`}
                  chamber={c}
                  labSteps={labSteps}
                  stepLabel={stepLabel}
                  canWrite={canWrite}
                  editing={editing === c.id}
                  busy={update.isPending}
                  onEdit={() => setEditing(c.id)}
                  onDone={() => setEditing(null)}
                  onSave={save}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const s = new Set(a);
  return b.every((x) => s.has(x));
}

function ChamberStagesRow({
  chamber,
  labSteps,
  stepLabel,
  canWrite,
  editing,
  busy,
  onEdit,
  onDone,
  onSave,
}: {
  chamber: ChamberRead;
  labSteps: readonly LabStepColumn[];
  stepLabel: (s: LabStepColumn) => string;
  canWrite: boolean;
  editing: boolean;
  busy: boolean;
  onEdit: () => void;
  onDone: () => void;
  onSave: (chamber: ChamberRead, next: string[]) => Promise<string | null>;
}): React.JSX.Element {
  const [ticked, setTicked] = React.useState<Set<string>>(() => new Set(chamber.allowed_stages));
  const [error, setError] = React.useState<string | null>(null);
  const shown = new Set(labSteps.map((s) => s.stepId));
  const next = [
    ...labSteps.filter((s) => ticked.has(s.stepId)).map((s) => s.stepId),
    ...chamber.allowed_stages.filter((id) => !shown.has(id)),
  ];
  const dirty = !sameSet(next, chamber.allowed_stages);

  const cancel = () => {
    setTicked(new Set(chamber.allowed_stages));
    setError(null);
    onDone();
  };

  return (
    <>
      <tr className="border-t border-border/70" data-testid={`chamber-stages-${chamber.code}`}>
        <th scope="row" className="px-3 py-2 text-left font-bold text-text">
          {chamber.code}
        </th>
        {labSteps.map((s) => (
          <td key={s.stepId} className="px-2 py-2 text-center">
            <Checkbox
              checked={ticked.has(s.stepId)}
              disabled={!canWrite || !editing || busy}
              onCheckedChange={(v) =>
                setTicked((prev) => {
                  const out = new Set(prev);
                  if (v === true) out.add(s.stepId);
                  else out.delete(s.stepId);
                  return out;
                })
              }
              aria-label={`${chamber.code} accepts ${stepLabel(s)}`}
            />
          </td>
        ))}
        {canWrite ? (
          <td className="whitespace-nowrap px-2 py-1 text-right">
            {editing ? (
              <span className="inline-flex gap-1">
                <Button
                  type="button"
                  size="sm"
                  disabled={!dirty || busy}
                  onClick={() => {
                    setError(null);
                    void onSave(chamber, next).then((msg) => {
                      if (msg === null) onDone();
                      else setError(msg);
                    });
                  }}
                  aria-label={`Save accepted steps for ${chamber.code}`}
                >
                  <Save />
                  Save
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={cancel} aria-label={`Cancel editing ${chamber.code}`}>
                  Cancel
                </Button>
              </span>
            ) : (
              <Button type="button" size="sm" variant="secondary" onClick={onEdit} aria-label={`Edit accepted steps for ${chamber.code}`}>
                <Pencil />
                Edit
              </Button>
            )}
          </td>
        ) : null}
      </tr>
      {error ? (
        <tr>
          <td colSpan={labSteps.length + (canWrite ? 2 : 1)} className="px-3 pb-2">
            <p role="alert" className="text-2xs text-danger">
              {error}
            </p>
          </td>
        </tr>
      ) : null}
    </>
  );
}

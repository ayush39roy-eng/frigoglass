import * as React from 'react';
import { Save, Undo2 } from 'lucide-react';

import { StepKindBadge } from '@/components/shared/step-kind-badge';
import { STEP_KIND_META } from '@/components/shared/step-kind-meta';
import { Badge } from '@/components/ui/badge';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { ConfirmDialog } from '@/surfaces/planning/components/confirm-dialog';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { WORKFLOW_STEP_KINDS, type WorkflowId, type WorkflowStepKind } from '@/types/enums';

import type { WorkflowSetting, WorkflowSettingsSaveResult, StepsUpdateRequest } from '../api/types';
import { parallelPeers, validateDag } from '../lib/dag';
import { DagDiagram } from './dag-diagram';
import { PredecessorPicker } from './predecessor-picker';
import { saveErrorMessage } from './save-error';

/**
 * Steps & precedence (ADR 0009). Per workflow: the 14 steps with their kind
 * badge, a "Can start after…" multi-select of EARLIER steps, and the derived
 * "runs in parallel with X, Y" summary; plus the inline DAG diagram. The
 * client-side check (`validateDag`) mirrors the server's so an invalid graph
 * is explained before it is sent; the server's 422 codes are shown if it
 * disagrees.
 *
 * Kinds (ADR 0007) are editable by Super Admin only (`workflow_settings.write`).
 * Every kind change goes through a confirm dialog, because it moves load
 * between engineers (design), chambers (lab) and nobody (elapsed) for every
 * project on this workflow once the schedule is recalculated.
 */
export interface StepsTabProps {
  workflows: WorkflowSetting[];
  canWrite: boolean;
  onSave: (workflowId: string, body: StepsUpdateRequest) => Promise<WorkflowSettingsSaveResult>;
  saving: boolean;
}

export function StepsTab({ workflows, canWrite, onSave, saving }: StepsTabProps): React.JSX.Element {
  const [workflowId, setWorkflowId] = React.useState<WorkflowId>(workflows[0]?.id ?? 'PDD');
  const workflow = workflows.find((w) => w.id === workflowId) ?? workflows[0];

  return (
    <div className="space-y-4">
      <ToggleGroup
        type="single"
        size="sm"
        value={workflowId}
        onValueChange={(v) => {
          if (v === 'PDD' || v === 'OEM') setWorkflowId(v);
        }}
        aria-label="Workflow"
      >
        {workflows.map((w) => (
          <ToggleGroupItem key={w.id} value={w.id} aria-label={`${w.id} workflow`}>
            {w.id} — {w.name}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {workflow ? (
        <WorkflowStepsEditor key={workflow.id} workflow={workflow} canWrite={canWrite} onSave={onSave} saving={saving} />
      ) : null}
    </div>
  );
}

function WorkflowStepsEditor({
  workflow,
  canWrite,
  onSave,
  saving,
}: {
  workflow: WorkflowSetting;
  canWrite: boolean;
  onSave: StepsTabProps['onSave'];
  saving: boolean;
}): React.JSX.Element {
  const ordered = React.useMemo(
    () => [...workflow.steps].sort((a, b) => a.sequence_order - b.sequence_order),
    [workflow.steps],
  );
  const [preds, setPreds] = React.useState<Record<string, string[]>>(() =>
    Object.fromEntries(ordered.map((s) => [s.step_id, [...s.predecessor_ids]])),
  );
  const [kinds, setKinds] = React.useState<Record<string, WorkflowStepKind>>(() =>
    Object.fromEntries(ordered.map((s) => [s.step_id, s.kind])),
  );
  const [pendingKind, setPendingKind] = React.useState<{ stepId: string; name: string; from: WorkflowStepKind; to: WorkflowStepKind } | null>(null);
  const [serverError, setServerError] = React.useState<string | null>(null);

  const edited = ordered.map((s) => ({
    ...s,
    kind: kinds[s.step_id] ?? s.kind,
    predecessor_ids: preds[s.step_id] ?? [],
  }));
  const errors = validateDag(edited);
  const errorByStep = new Map(errors.map((e) => [e.step_id, e]));
  const dirty = ordered.some(
    (s) =>
      [...s.predecessor_ids].sort().join(',') !== [...(preds[s.step_id] ?? [])].sort().join(',') ||
      (kinds[s.step_id] ?? s.kind) !== s.kind,
  );
  const nameById = new Map(ordered.map((s) => [s.step_id, s.name]));
  const acyclic = !errors.some((e) => e.code === 'CYCLE');

  const handleSave = async () => {
    setServerError(null);
    try {
      await onSave(workflow.id, {
        steps: edited.map((s) => ({ step_id: s.step_id, kind: s.kind, predecessor_ids: s.predecessor_ids })),
      });
    } catch (err) {
      setServerError(saveErrorMessage(err));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{workflow.id} — steps &amp; precedence</CardTitle>
        {canWrite ? (
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={!dirty || saving}
              onClick={() => {
                setPreds(Object.fromEntries(ordered.map((s) => [s.step_id, [...s.predecessor_ids]])));
                setKinds(Object.fromEntries(ordered.map((s) => [s.step_id, s.kind])));
                setServerError(null);
              }}
            >
              <Undo2 />
              Reset
            </Button>
            <Button type="button" size="sm" disabled={!dirty || errors.length > 0 || saving} onClick={() => void handleSave()}>
              <Save />
              {saving ? 'Saving…' : 'Save steps'}
            </Button>
          </div>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-3">
        <DagDiagram steps={edited} workflowName={`${workflow.id} workflow`} />
        <p className="text-2xs text-text-muted">
          Default is the strict chain. Letting a step start after an earlier step (instead of the one just
          before it) lets it run in parallel. Two design steps still never overlap in practice — both book the
          project leader, so the scheduler serialises them; parallelism buys lab ∥ design and elapsed ∥ anything.
        </p>

        {errors.length > 0 ? (
          <ul role="alert" className="space-y-0.5 rounded-control border border-danger/40 bg-danger-subtle px-3 py-2 text-2xs text-danger-subtle-fg">
            {errors.map((e) => (
              <li key={`${e.code}-${e.step_id}`}>
                <strong>{e.code}</strong> — {e.detail}
              </li>
            ))}
          </ul>
        ) : null}
        {serverError ? (
          <p role="alert" className="text-2xs text-danger">
            {serverError}
          </p>
        ) : null}

        <div role="table" aria-label={`${workflow.id} steps`} className="overflow-x-auto rounded-lg border border-border">
          <div role="row" className="grid grid-cols-[3rem_minmax(12rem,2fr)_5rem_minmax(10rem,1.3fr)_minmax(10rem,1.5fr)] items-center gap-3 border-b border-border bg-surface-sunken px-3 py-2 text-2xs font-semibold text-text-muted">
            <div role="columnheader">Step</div>
            <div role="columnheader">Name</div>
            <div role="columnheader">Kind</div>
            <div role="columnheader">Can start after…</div>
            <div role="columnheader">Runs in parallel with</div>
          </div>
          {edited.map((s, index) => {
            const peers = acyclic ? parallelPeers(edited, s.step_id) : [];
            const earlier = ordered.slice(0, index).map((o) => ({ step_id: o.step_id, name: o.name }));
            return (
              <div
                key={s.step_id}
                role="row"
                data-testid={`step-row-${s.step_id}`}
                className="grid grid-cols-[3rem_minmax(12rem,2fr)_5rem_minmax(10rem,1.3fr)_minmax(10rem,1.5fr)] items-center gap-3 border-b border-border px-3 py-1.5 text-xs last:border-0"
              >
                <div role="cell" className="font-mono text-2xs text-text-muted">
                  {s.step_id}
                </div>
                <div role="cell" className="min-w-0">
                  <span className="block truncate text-text" title={s.name}>
                    {s.name}
                  </span>
                  <span className="block font-mono text-[0.625rem] text-text-subtle">{s.code}</span>
                </div>
                <div role="cell">
                  {canWrite ? (
                    <Select
                      value={s.kind}
                      onValueChange={(v) => {
                        const to = v as WorkflowStepKind;
                        if (to !== s.kind) setPendingKind({ stepId: s.step_id, name: s.name, from: s.kind, to });
                      }}
                    >
                      <SelectTrigger className="h-7 px-1.5 text-2xs" aria-label={`Kind — ${s.name}`}>
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {WORKFLOW_STEP_KINDS.map((k) => (
                          <SelectItem key={k} value={k}>
                            {STEP_KIND_META[k].label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <StepKindBadge kind={s.kind} />
                  )}
                </div>
                <div role="cell">
                  <PredecessorPicker
                    stepId={s.step_id}
                    stepName={s.name}
                    options={earlier}
                    value={s.predecessor_ids}
                    onChange={(next) => setPreds((prev) => ({ ...prev, [s.step_id]: next }))}
                    disabled={!canWrite}
                    invalid={errorByStep.has(s.step_id)}
                  />
                </div>
                <div role="cell" className="text-2xs text-text-muted" data-testid={`parallel-${s.step_id}`}>
                  {peers.length === 0 ? (
                    <span className="text-text-subtle">—</span>
                  ) : (
                    <span className="flex flex-wrap gap-1">
                      {peers.map((p) => (
                        <Badge key={p} tone="outline" title={nameById.get(p)}>
                          {p.slice(-1)} {nameById.get(p)}
                        </Badge>
                      ))}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </CardContent>
      <ConfirmDialog
        open={pendingKind !== null}
        onOpenChange={(open) => {
          if (!open) setPendingKind(null);
        }}
        title={
          pendingKind
            ? `Change ${pendingKind.name} from ${STEP_KIND_META[pendingKind.from].label} to ${STEP_KIND_META[pendingKind.to].label}?`
            : 'Change step kind?'
        }
        description={
          pendingKind ? kindChangeExplanation(pendingKind.from, pendingKind.to) : ''
        }
        confirmLabel="Change kind"
        onConfirm={() => {
          if (pendingKind) setKinds((prev) => ({ ...prev, [pendingKind.stepId]: pendingKind.to }));
          setPendingKind(null);
        }}
      />
    </Card>
  );
}

const KIND_BOOKS: Record<WorkflowStepKind, string> = {
  design: "the project leader's weeks (engineer load)",
  lab: 'chamber platform-weeks (lab load)',
  elapsed: 'no resource at all (calendar time only)',
};

function kindChangeExplanation(from: WorkflowStepKind, to: WorkflowStepKind): string {
  return `This step will book ${KIND_BOOKS[to]} instead of ${KIND_BOOKS[from]} for every project on this workflow. Engineer and chamber load on RPD Capacity shifts accordingly, and chambers must allow this step before a lab kind can book. Nothing moves until the schedule is recalculated — saving marks every schedulable project stale.`;
}

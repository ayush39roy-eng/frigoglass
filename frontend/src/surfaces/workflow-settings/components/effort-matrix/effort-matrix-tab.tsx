import * as React from 'react';
import { Info, Plus, Rocket, Undo2, Workflow } from 'lucide-react';

import { SectionBoundary } from '@/components/shared/section-boundary';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useCategories } from '@/lib/api/categories';
import { EditConflictDismissedError } from '@/lib/api/edit-conflict';
import type { Category } from '@/lib/category-catalog';
import type { WorkflowId, WorkflowStepKind } from '@/types/enums';
import { ConfirmDialog } from '@/surfaces/planning/components/confirm-dialog';

import type { StepsUpdateRequest, WorkflowSetting, WorkflowSettingsSaveResult, TemplateChangeSet } from '../../api/types';
import type { EffortMatrixState } from '../../hooks/use-effort-matrix';
import { useBEquivalent, useCategoryTimelines } from '../../hooks/use-workflow-settings';
import { matrixChangeSet, matrixSummary, RESOURCE_LABEL } from '../../lib/effort-matrix';
import { kindChangeExplanation } from '../../lib/kind-copy';
import { AddCategoryDialog } from '../add-category-dialog';
import { BEquivalentPanel } from '../b-equivalent-panel';
import { ControlledCategoryTimeline } from '../category-timeline';
import { saveErrorMessage } from '../save-error';
import { MatrixGrid } from './matrix-grid';

/**
 * P52-T01 (owner 2026-11-19): "Effort & Timeline Planning" — the client's old
 * app page on our Workflow page, everything on one screen: per workflow an
 * Excel-style grid (Resource row, categories × steps, TOTAL (W) with D / L),
 * then the per-category timelines with gap / overlap ± and the B-equivalent
 * workload. Presentation over existing capabilities only (ADR 0007 kinds,
 * ADR 0045–0048 templates and apply); no new rule and no new endpoint.
 *
 * Every edit is a draft (owner rule 2026-11-19: nothing the client entered is
 * overwritten without an explicit action). "Apply to App" is the only save:
 *  1. drafted Resources (Super Admin) → the existing steps PUT per workflow,
 *     each change already confirmed in the kind dialog;
 *  2. drafted lengths and gaps → the existing apply dialog (E2 preview of the
 *     projects reached → E3 apply), where the user can still cancel.
 * Resources go first so the apply preview reads the kinds in force.
 */
export interface EffortMatrixTabProps {
  workflows: WorkflowSetting[];
  /** Every category in rank order (C1), for "+ Add category". */
  categories: readonly Category[];
  versions: Readonly<Record<string, number>>;
  state: EffortMatrixState;
  canWriteTemplates: boolean;
  canWriteSettings: boolean;
  /** An apply is being checked / written / followed. */
  applying: boolean;
  onSaveSteps: (workflowId: string, body: StepsUpdateRequest) => Promise<WorkflowSettingsSaveResult>;
  onStartApply: (changeSet: TemplateChangeSet, summary: string[], onApplied: () => void) => void;
  onEditWorkflow: () => void;
}

const WORKFLOW_TITLE: Record<WorkflowId, string> = {
  PDD: 'Standard PDD Workflow',
  OEM: 'OEM Workflow',
};

interface KindRequest {
  workflowId: WorkflowId;
  stepId: string;
  name: string;
  from: WorkflowStepKind;
  to: WorkflowStepKind;
}

export function EffortMatrixTab({
  workflows,
  categories,
  versions,
  state,
  canWriteTemplates,
  canWriteSettings,
  applying,
  onSaveSteps,
  onStartApply,
  onEditWorkflow,
}: EffortMatrixTabProps): React.JSX.Element {
  const { catalog } = useCategories();
  const [kindRequest, setKindRequest] = React.useState<KindRequest | null>(null);
  const [savingKinds, setSavingKinds] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [adding, setAdding] = React.useState<WorkflowId | null>(null);
  const [openCategory, setOpenCategory] = React.useState<string | null>(null);

  const ordered = React.useMemo(() => {
    const rank = (id: WorkflowId) => (id === 'PDD' ? 0 : 1);
    return [...workflows].sort((a, b) => rank(a.id) - rank(b.id));
  }, [workflows]);
  const busy = applying || savingKinds;
  const changeCount = state.templateCount + state.kindCount;
  const invalid = state.invalid.size > 0;
  const canWriteAny = canWriteTemplates || canWriteSettings;

  const applyToApp = async () => {
    setError(null);
    // 1. Resources: one steps PUT per workflow with drafted kinds (predecessors as served).
    setSavingKinds(true);
    try {
      for (const w of ordered) {
        const drafted = state.kinds[w.id] ?? {};
        if (Object.keys(drafted).length === 0) continue;
        const steps = [...w.steps]
          .sort((a, b) => a.sequence_order - b.sequence_order)
          .map((s) => ({ step_id: s.step_id, kind: drafted[s.step_id] ?? s.kind, predecessor_ids: [...s.predecessor_ids] }));
        await onSaveSteps(w.id, { steps });
        state.clearKinds(w.id);
      }
    } catch (err) {
      setError(err instanceof EditConflictDismissedError ? err.message : saveErrorMessage(err));
      return;
    } finally {
      setSavingKinds(false);
    }
    // 2. Lengths and gaps: the apply dialog shows which projects they reach.
    const changeSet = matrixChangeSet(state.drafts, versions);
    if (changeSet.changes.length === 0) return;
    onStartApply(changeSet, matrixSummary(state.drafts, state.savedOf), state.clearTemplateDrafts);
  };

  return (
    <div className="space-y-4" data-testid="effort-matrix">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <h2 className="font-display text-xl font-extrabold text-text">Effort &amp; Timeline Planning</h2>
          <p className="text-sm text-text-muted">
            Define effort durations (weeks) per step &amp; category · Adjust gaps between steps · Visualize per-category
            timelines
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onEditWorkflow}>
            <Workflow aria-hidden="true" />
            Edit Workflow
          </Button>
          {canWriteAny ? (
            <>
              <Button type="button" variant="secondary" size="sm" disabled={!state.dirty || busy} onClick={state.discardAll}>
                <Undo2 aria-hidden="true" />
                Discard changes
              </Button>
              <Button
                type="button"
                size="md"
                disabled={changeCount === 0 || invalid || busy}
                onClick={() => void applyToApp()}
                data-testid="apply-to-app"
              >
                <Rocket aria-hidden="true" />
                {busy ? 'Applying…' : changeCount > 0 ? `Apply to App (${String(changeCount)})` : 'Apply to App'}
              </Button>
            </>
          ) : null}
        </div>
      </div>

      <div className="flex items-start gap-2 rounded-md border border-primary/30 bg-primary-subtle/40 px-3 py-2 text-2xs text-text" role="note">
        <Info className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden="true" />
        <p>
          Values are the <strong>category templates</strong>. Edits stay drafts on this page until you press{' '}
          <strong>Apply to App</strong>, which first shows which projects each change reaches (projects that have started
          a step, or carry their own effort figure, keep their own weeks). Resource = which capacity a step books: Design
          (project leader), Lab (a chamber) or Other (calendar time only); changing it is Super Admin only. Totals are sums
          of the template weeks shown, including unsaved edits; timeline previews and B-equivalent are calculated by the
          server.
        </p>
      </div>

      <div aria-live="polite" className="text-2xs" data-testid="matrix-status">
        {changeCount > 0 ? (
          <span className="font-semibold text-warning-subtle-fg">
            {String(changeCount)} unsaved {changeCount === 1 ? 'change' : 'changes'} — not applied yet.
          </span>
        ) : null}
      </div>
      {invalid ? (
        <p role="alert" className="text-2xs text-danger">
          Lengths are whole weeks, from 0 to 104. Fix the outlined cells before applying.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-2xs text-danger" data-testid="matrix-error">
          {error}
        </p>
      ) : null}

      <div className="grid items-start gap-4 2xl:grid-cols-2">
        {ordered.map((w) => (
          <WorkflowCard
            key={w.id}
            workflow={w}
            categoryCodes={catalog.codesForWorkflow(w.id)}
            state={state}
            canWriteTemplates={canWriteTemplates}
            canWriteSettings={canWriteSettings}
            disabled={busy}
            openCategory={openCategory}
            onAddCategory={canWriteTemplates ? () => setAdding(w.id) : undefined}
            onRequestKind={setKindRequest}
          />
        ))}
      </div>

      <ConfirmDialog
        open={kindRequest !== null}
        onOpenChange={(open) => {
          if (!open) setKindRequest(null);
        }}
        tone="primary"
        title={
          kindRequest
            ? `Change ${kindRequest.name} from ${RESOURCE_LABEL[kindRequest.from]} to ${RESOURCE_LABEL[kindRequest.to]}?`
            : 'Change resource?'
        }
        description={
          kindRequest
            ? `${kindChangeExplanation(kindRequest.from, kindRequest.to)} This is a draft until you press Apply to App.`
            : ''
        }
        confirmLabel="Change resource"
        onConfirm={() => {
          if (kindRequest) state.setKind(kindRequest.workflowId, kindRequest.stepId, kindRequest.to);
          setKindRequest(null);
        }}
      />
      {canWriteTemplates && adding ? (
        <AddCategoryDialog
          open={adding !== null}
          onOpenChange={(open) => {
            if (!open) setAdding(null);
          }}
          categories={categories}
          defaultWorkflow={adding}
          onCreated={(c) => setOpenCategory(c.code)}
        />
      ) : null}
    </div>
  );
}

function WorkflowCard({
  workflow,
  categoryCodes,
  state,
  canWriteTemplates,
  canWriteSettings,
  disabled,
  openCategory,
  onAddCategory,
  onRequestKind,
}: {
  workflow: WorkflowSetting;
  categoryCodes: readonly string[];
  state: EffortMatrixState;
  canWriteTemplates: boolean;
  canWriteSettings: boolean;
  disabled: boolean;
  openCategory: string | null;
  onAddCategory: (() => void) | undefined;
  onRequestKind: (request: KindRequest) => void;
}): React.JSX.Element {
  const wf = workflow.id;
  const timelines = useCategoryTimelines(wf);
  const bEquivalent = useBEquivalent(wf);
  const headingId = React.useId();

  return (
    <Card className="min-w-0" aria-labelledby={headingId} role="region" data-testid={`matrix-card-${wf}`}>
      <CardHeader>
        <CardTitle id={headingId}>{WORKFLOW_TITLE[wf]}</CardTitle>
        {onAddCategory ? (
          <Button type="button" variant="secondary" size="sm" aria-haspopup="dialog" onClick={onAddCategory} disabled={disabled}>
            <Plus aria-hidden="true" />
            Add category
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-4">
        <MatrixGrid
          workflow={workflow}
          categories={categoryCodes}
          state={state}
          canEditWeeks={canWriteTemplates}
          canEditResources={canWriteSettings}
          disabled={disabled}
          onRequestKind={onRequestKind}
        />
        <HeatLegend />

        <section aria-label={`${WORKFLOW_TITLE[wf]} per-category Gantt timelines`} className="space-y-2">
          <h3 className="text-2xs font-bold uppercase tracking-wider text-text-subtle">Per-category Gantt timelines</h3>
          <SectionBoundary query={timelines} title="Per-category timelines" errorDescription="The category timelines could not be loaded.">
            {(data) =>
              data.length === 0 ? (
                <p className="py-s4 text-center text-sm text-text-muted">No categories configured for this workflow.</p>
              ) : (
                <div className="space-y-2">
                  {data.map((t) => (
                    <ControlledCategoryTimeline
                      key={t.category}
                      timeline={t}
                      drafts={state.drafts[wf]?.[t.category] ?? EMPTY}
                      saved={state.savedOf(wf, t.category)}
                      canWrite={canWriteTemplates}
                      disabled={disabled}
                      defaultOpen={t.category === openCategory}
                      onNudge={(stepId, field, dir) => state.nudge(wf, t.category, stepId, field, dir)}
                      onResetStep={(stepId) => state.resetStep(wf, t.category, stepId)}
                    />
                  ))}
                </div>
              )
            }
          </SectionBoundary>
        </section>

        <SectionBoundary query={bEquivalent} title="B-equivalent workload" errorDescription="The B-equivalent workload could not be loaded.">
          {(rows) => (
            <div className="space-y-1">
              <BEquivalentPanel workflow={wf} rows={rows} />
              <p className="text-2xs text-text-subtle">B-equivalent reflects the saved template; it updates after Apply to App.</p>
            </div>
          )}
        </SectionBoundary>
      </CardContent>
    </Card>
  );
}

const EMPTY = {} as const;

function HeatLegend(): React.JSX.Element {
  return (
    <p className="flex flex-wrap items-center gap-2 text-2xs text-text-muted">
      <span>Fewer weeks</span>
      <span
        aria-hidden="true"
        className="h-2.5 w-24 rounded-sm"
        style={{
          backgroundImage: 'linear-gradient(to right, hsl(120 72% 46% / 0.35), hsl(60 72% 46% / 0.35), hsl(0 72% 46% / 0.35))',
        }}
      />
      <span>More weeks</span>
      <span className="ml-2">0 = step skipped for that category · underlined = unsaved change</span>
    </p>
  );
}

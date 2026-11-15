import * as React from 'react';
import { Save, Undo2 } from 'lucide-react';

import { STEP_KIND_META } from '@/components/shared/step-kind-meta';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useCategories } from '@/lib/api/categories';
import { formatDecimal } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { WorkflowStepKind } from '@/types/enums';

import type { LeadTimeSetting, TemplateChangeSet, WorkflowSetting } from '../api/types';
import { buildLeadTimeGrid, changedLeadTimes, leadTimeChangeSet, rowTotals, type LeadTimeGridRow } from '../lib/lead-times';
import { WEEKS_MAX } from '../lib/template-drafts';

/**
 * Lead times (ADR 0007): the client's own `Final RPD` table — per workflow,
 * category rows × 14 step columns, with Σ and design / lab / elapsed
 * subtotals (the workbook's row formulas, evaluated over the cells on screen).
 * A 0 is rendered "—" (the step is skipped for that category). Read-only
 * roles see the same grid as text.
 *
 * P33-T17 (ADR 0045 §5): editable with `workflow_templates.write` (Admin and
 * Super Admin). Save goes through the same apply as the timeline editor
 * (E2 → dialog → E3); the old `PUT /workflow-settings/lead-times` is 410.
 */
export interface LeadTimesTabProps {
  workflows: WorkflowSetting[];
  leadTimes: LeadTimeSetting[];
  /** C1 `categories[].template_version` by code: each entry's `base_version`. */
  versions: Readonly<Record<string, number>>;
  canWrite: boolean;
  /** Opens the apply dialog; `onApplied` runs once the apply succeeded. */
  onSave: (changeSet: TemplateChangeSet, summary: string[], onApplied: () => void) => void;
  saving: boolean;
}

export function LeadTimesTab(props: LeadTimesTabProps): React.JSX.Element {
  // P33-T14: a newly served category list re-seeds the grids' row order.
  const { catalog } = useCategories();
  const categoriesKey = catalog.codes.join('|');
  const versionsKey = Object.entries(props.versions)
    .map(([code, v]) => `${code}:${String(v)}`)
    .join('|');
  return (
    <div className="space-y-4">
      {props.workflows.map((w) => (
        // A new template version (an apply, a 409 reload) or category list re-seeds the grid.
        <LeadTimeGrid key={`${w.id}-${props.leadTimes.length}-${versionsKey}-${categoriesKey}`} workflow={w} {...props} />
      ))}
    </div>
  );
}

function LeadTimeGrid({
  workflow,
  leadTimes,
  versions,
  canWrite,
  onSave,
  saving,
}: LeadTimesTabProps & { workflow: WorkflowSetting }): React.JSX.Element {
  const steps = React.useMemo(
    () => [...workflow.steps].sort((a, b) => a.sequence_order - b.sequence_order),
    [workflow.steps],
  );
  const stepIds = steps.map((s) => s.step_id);
  const kinds: Record<string, WorkflowStepKind> = Object.fromEntries(steps.map((s) => [s.step_id, s.kind]));
  // P33-T14: row order = the served categories of this workflow, in rank order.
  const { catalog } = useCategories();
  const original = React.useMemo(
    () => buildLeadTimeGrid(leadTimes, workflow.id, stepIds, catalog.codesForWorkflow(workflow.id)),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stepIds is derived from steps
    [leadTimes, workflow.id, steps, catalog],
  );
  const [rows, setRows] = React.useState<LeadTimeGridRow[]>(original);
  const changes = changedLeadTimes(original, rows, workflow.id);
  const invalid = rows.some((r) => Object.values(r.cells).some((w) => !Number.isInteger(w) || w < 0 || w > WEEKS_MAX));

  const setCell = (category: string, stepId: string, raw: string) => {
    const weeks = raw.trim() === '' ? 0 : Number(raw);
    setRows((prev) =>
      prev.map((r) => (r.category === category ? { ...r, cells: { ...r.cells, [stepId]: weeks } } : r)),
    );
  };

  const handleSave = () => {
    const before = new Map(original.map((r) => [r.category, r.cells]));
    const summary = changes.map(
      (c) => `${c.category} \u00b7 ${c.step_id} length ${String(before.get(c.category)?.[c.step_id] ?? 0)}w \u2192 ${String(c.weeks)}w`,
    );
    // After a successful apply the refetched template versions re-key (re-seed) the grid.
    onSave(leadTimeChangeSet(changes, versions), summary, () => undefined);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{workflow.id} — lead times (weeks)</CardTitle>
        {canWrite ? (
          <div className="flex items-center gap-2">
            <Button type="button" variant="ghost" size="sm" disabled={changes.length === 0 || saving} onClick={() => setRows(original)}>
              <Undo2 />
              Reset
            </Button>
            <Button type="button" size="sm" disabled={changes.length === 0 || invalid || saving} onClick={handleSave}>
              <Save />
              {saving ? 'Saving…' : `Save ${String(changes.length)} ${changes.length === 1 ? 'change' : 'changes'}…`}
            </Button>
          </div>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-2">
        {invalid ? (
          <p role="alert" className="text-2xs text-danger">
            Lead times are whole weeks, from 0 to 104.
          </p>
        ) : null}
        <div className="overflow-x-auto rounded-dash border-[1.5px] border-border bg-surface">
          <table className="w-full border-collapse text-sm" aria-label={`${workflow.id} lead times`}>
            <thead className="bg-surface-sunken text-2xs font-bold uppercase tracking-wider text-text-subtle">
              <tr>
                <th scope="col" className="sticky left-0 z-10 bg-surface-sunken px-3 py-3 text-left">
                  Category
                </th>
                {steps.map((s) => (
                  <th key={s.step_id} scope="col" className="px-1 py-1.5 text-center font-semibold" title={`${s.name} · ${STEP_KIND_META[s.kind].label}`}>
                    <span className="block">{s.step_id.slice(-1)}</span>
                    <span className={cn('block text-[0.625rem] font-normal uppercase', s.kind === 'elapsed' && 'italic')}>
                      {STEP_KIND_META[s.kind].short}
                    </span>
                  </th>
                ))}
                <th scope="col" className="border-l border-border px-3 py-3 text-right">
                  Σ
                </th>
                <th scope="col" className="px-3 py-3 text-right">
                  Design
                </th>
                <th scope="col" className="px-3 py-3 text-right">
                  Lab
                </th>
                <th scope="col" className="px-3 py-3 text-right">
                  Elapsed
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => {
                const totals = rowTotals(row.cells, kinds);
                return (
                  <tr key={row.category} className="border-t border-border/70 transition-colors hover:bg-primary-subtle/30" data-testid={`lead-row-${row.category}`}>
                    <th scope="row" className="sticky left-0 z-10 bg-surface px-3 py-2 text-left font-bold text-text">
                      {row.category}
                    </th>
                    {stepIds.map((stepId) => {
                      const weeks = row.cells[stepId] ?? 0;
                      return (
                        <td key={stepId} className="px-0.5 py-0.5 text-center" data-numeric="">
                          {canWrite ? (
                            <input
                              type="number"
                              min={0}
                              max={WEEKS_MAX}
                              step={1}
                              inputMode="numeric"
                              value={weeks === 0 ? '' : String(weeks)}
                              placeholder="—"
                              onChange={(e) => setCell(row.category, stepId, e.target.value)}
                              aria-label={`${workflow.id} ${row.category} ${stepId} weeks`}
                              className="h-7 w-10 rounded border border-border-strong bg-surface text-center text-xs text-text placeholder:text-text-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                            />
                          ) : weeks === 0 ? (
                            <span className="text-text-subtle" title="Skipped for this category">
                              —
                            </span>
                          ) : (
                            weeks
                          )}
                        </td>
                      );
                    })}
                    <td className="border-l border-border px-2 py-1 text-right font-semibold text-text" data-numeric="" data-testid="total">
                      {formatDecimal(totals.total)}
                    </td>
                    <td className="px-2 py-1 text-right" data-numeric="" data-testid="design">
                      {formatDecimal(totals.design)}
                    </td>
                    <td className="px-2 py-1 text-right" data-numeric="" data-testid="lab">
                      {formatDecimal(totals.lab)}
                    </td>
                    <td className="px-2 py-1 text-right text-text-muted" data-numeric="" data-testid="elapsed">
                      {formatDecimal(totals.elapsed)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="text-2xs text-text-subtle">
          “—” = 0 weeks: the step is skipped for that category (no calendar time, no capacity). Totals are the
          workbook’s row formulas over the cells shown, including unsaved edits.
        </p>
      </CardContent>
    </Card>
  );
}

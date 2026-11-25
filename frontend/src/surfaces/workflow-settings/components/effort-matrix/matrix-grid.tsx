import * as React from 'react';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { formatInteger } from '@/lib/format';
import { cn } from '@/lib/utils';
import type { WorkflowId, WorkflowStepKind } from '@/types/enums';

import type { WorkflowSetting } from '../../api/types';
import type { EffortMatrixState } from '../../hooks/use-effort-matrix';
import { cellHold, cellWeeks, heatStyle, matrixTotals, parseWeeks, RESOURCE_LABEL, RESOURCE_OPTIONS } from '../../lib/effort-matrix';
import { WEEKS_MAX } from '../../lib/template-drafts';

/**
 * P52-T01: one workflow's Excel-style effort grid — the client's "Process
 * steps" sheet: a Resource row (Design / Lab / Other per step), one row per
 * category with the template length of each step, and a TOTAL (W) column with
 * the row's design and lab weeks.
 *
 * Excel feel: gridlines, heat colouring (green few weeks → red many), sticky
 * header rows and category column, horizontal scroll, and keyboard movement —
 * arrows move between cells, Enter / Shift+Enter move down / up, Tab follows
 * the row, Escape puts the saved value back. Typing replaces the cell (its
 * text is selected on focus).
 *
 * Edits are drafts (the matrix state); nothing is sent from here.
 */
export interface MatrixGridProps {
  workflow: WorkflowSetting;
  /** The workflow's categories in rank order. */
  categories: readonly string[];
  state: EffortMatrixState;
  /** `workflow_templates.write`: the cells are inputs. */
  canEditWeeks: boolean;
  /** `workflow_settings.write` (Super Admin): the Resource row is a dropdown. */
  canEditResources: boolean;
  disabled: boolean;
  /** A Resource change asks for confirmation first (it moves load). */
  onRequestKind: (request: { workflowId: WorkflowId; stepId: string; name: string; from: WorkflowStepKind; to: WorkflowStepKind }) => void;
}

const HEAD_ROW_1 = 'h-14';
const HEAD_ROW_2_TOP = 'top-14';

export function MatrixGrid({
  workflow,
  categories,
  state,
  canEditWeeks,
  canEditResources,
  disabled,
  onRequestKind,
}: MatrixGridProps): React.JSX.Element {
  const tableRef = React.useRef<HTMLTableElement>(null);
  const steps = React.useMemo(
    () => [...workflow.steps].sort((a, b) => a.sequence_order - b.sequence_order),
    [workflow.steps],
  );
  const stepIds = steps.map((s) => s.step_id);
  const wf = workflow.id;
  const weeksOf = (category: string, stepId: string) =>
    cellWeeks(state.drafts[wf]?.[category], state.savedOf(wf, category), stepId);
  const max = Math.max(0, ...categories.flatMap((c) => stepIds.map((id) => weeksOf(c, id))));
  const draftedKinds = state.kinds[wf] ?? {};

  const focusCell = (row: number, col: number) => {
    if (row < 0 || row >= categories.length || col < 0 || col >= stepIds.length) return;
    const el = tableRef.current?.querySelector<HTMLInputElement>(`input[data-cell="${String(row)}:${String(col)}"]`);
    el?.focus();
  };

  return (
    <div className="max-h-[70vh] overflow-auto rounded-md border border-border-strong bg-surface" data-testid={`matrix-scroll-${wf}`}>
      <table ref={tableRef} className="w-max min-w-full border-collapse text-xs" aria-label={`${wf} effort in weeks per step and category`}>
        <thead>
          <tr>
            <th
              scope="col"
              className={cn(
                'sticky left-0 top-0 z-30 border border-border bg-surface-sunken px-2 text-left text-2xs font-bold uppercase tracking-wider text-text-subtle',
                HEAD_ROW_1,
              )}
            >
              Category
            </th>
            {steps.map((s) => (
              <th
                key={s.step_id}
                scope="col"
                title={`${s.step_id} · ${s.name}`}
                className={cn('sticky top-0 z-20 w-16 border border-border bg-surface-sunken px-1 align-bottom font-normal', HEAD_ROW_1)}
              >
                <span className="block font-mono text-[0.6875rem] font-bold text-text">{s.step_id}</span>
                <span className="block max-w-[4.25rem] truncate text-[0.625rem] leading-tight text-text-muted">{s.name}</span>
              </th>
            ))}
            <th
              scope="col"
              className={cn('sticky top-0 z-20 min-w-[7.5rem] border border-text bg-text px-2 text-center text-2xs font-bold uppercase tracking-wider text-text-inverse', HEAD_ROW_1)}
            >
              Total (W)
            </th>
          </tr>
          <tr>
            <th
              scope="row"
              className={cn(
                'sticky left-0 z-30 border border-border bg-surface-sunken px-2 py-1 text-left text-2xs font-bold uppercase tracking-wider text-text-subtle',
                HEAD_ROW_2_TOP,
              )}
            >
              Resource
            </th>
            {steps.map((s) => {
              const kind = state.kindOf(wf, s.step_id);
              const drafted = s.step_id in draftedKinds;
              return (
                <td
                  key={s.step_id}
                  className={cn('sticky z-20 border border-border bg-surface-sunken px-0.5 py-1 text-center', HEAD_ROW_2_TOP)}
                  data-testid={`resource-${s.step_id}`}
                  data-drafted={drafted || undefined}
                >
                  {canEditResources ? (
                    <Select
                      value={kind}
                      disabled={disabled}
                      onValueChange={(v) => {
                        const to = v as WorkflowStepKind;
                        if (to !== kind) onRequestKind({ workflowId: wf, stepId: s.step_id, name: s.name, from: kind, to });
                      }}
                    >
                      <SelectTrigger
                        className={cn('h-6 w-16 px-1 text-[0.6875rem]', drafted && 'border-warning ring-1 ring-warning')}
                        aria-label={`Resource — ${s.step_id} ${s.name}`}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {RESOURCE_OPTIONS.map((k) => (
                          <SelectItem key={k} value={k}>
                            {RESOURCE_LABEL[k]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  ) : (
                    <span className={cn('text-[0.6875rem] font-semibold', kind === 'elapsed' ? 'text-text-muted' : 'text-text')}>
                      {RESOURCE_LABEL[kind]}
                    </span>
                  )}
                </td>
              );
            })}
            <td className={cn('sticky z-20 border border-text bg-text', HEAD_ROW_2_TOP)} />
          </tr>
        </thead>
        <tbody>
          {categories.map((category, row) => {
            const saved = state.savedOf(wf, category);
            const catDrafts = state.drafts[wf]?.[category] ?? {};
            const totals = matrixTotals(
              stepIds,
              (id) => weeksOf(category, id),
              (id) => state.kindOf(wf, id),
              (id) => cellHold(catDrafts, saved, id),
            );
            return (
              <tr key={category} data-testid={`matrix-row-${wf}-${category}`}>
                <th scope="row" className="sticky left-0 z-10 border border-border bg-surface px-2 py-0.5 text-left text-sm font-bold text-text">
                  {category}
                </th>
                {steps.map((s, col) => {
                  const weeks = weeksOf(category, s.step_id);
                  const savedWeeks = saved[s.step_id]?.weeks ?? 0;
                  // P62 (ADR 0071): a lab step that books its room for part of its length.
                  const hold = state.kindOf(wf, s.step_id) === 'lab' && weeks > 0 ? cellHold(catDrafts, saved, s.step_id) : null;
                  return (
                    <td
                      key={s.step_id}
                      className="relative border border-border p-0 text-center"
                      style={heatStyle(weeks, max)}
                      data-numeric=""
                      data-testid={`cell-${wf}-${category}-${s.step_id}`}
                    >
                      {canEditWeeks ? (
                        <WeeksInput
                          value={weeks}
                          savedValue={savedWeeks}
                          drafted={catDrafts[s.step_id]?.weeks !== undefined}
                          label={`${category} ${s.step_id} ${s.name} weeks`}
                          cell={`${String(row)}:${String(col)}`}
                          invalidKey={`${wf}|${category}|${s.step_id}`}
                          disabled={disabled}
                          onCommit={(w) => state.setCellWeeks(wf, category, s.step_id, w)}
                          onInvalid={state.setInvalid}
                          onMove={(dr, dc) => focusCell(row + dr, col + dc)}
                        />
                      ) : (
                        <span className={cn('block px-1 py-1', weeks === 0 && 'text-text-subtle')}>{weeks}</span>
                      )}
                      {hold !== null ? (
                        <span
                          className="pointer-events-none absolute bottom-0 right-0.5 text-[0.5625rem] font-semibold leading-3 text-success-subtle-fg"
                          title={`Room booked for the last ${String(Math.min(hold, weeks))} of ${String(weeks)} weeks`}
                          data-testid={`room-${wf}-${category}-${s.step_id}`}
                        >
                          <span aria-hidden="true">{`room ${String(Math.min(hold, weeks))}`}</span>
                          <span className="sr-only">{`Room booked for the last ${String(Math.min(hold, weeks))} of ${String(weeks)} weeks`}</span>
                        </span>
                      ) : null}
                    </td>
                  );
                })}
                <td className="border border-text bg-text px-2 py-0.5 text-text-inverse" data-numeric="" data-testid={`total-${wf}-${category}`}>
                  <span className="flex items-center justify-end gap-1.5">
                    <span className="font-display text-sm font-extrabold tabular-nums" data-testid="total-weeks">
                      {formatInteger(totals.total)}
                    </span>
                    <span className="rounded-sm bg-primary px-1 text-[0.625rem] font-semibold text-primary-fg" data-testid="total-design">
                      D: {formatInteger(totals.design)} w
                    </span>
                    <span
                      className="rounded-sm bg-success px-1 text-[0.625rem] font-semibold text-success-fg"
                      data-testid="total-lab"
                      title={`Lab room weeks (chamber booked) ${formatInteger(totals.lab)} w · lab length ${formatInteger(totals.labLength)} w`}
                    >
                      L: {formatInteger(totals.lab)} w
                      {totals.labLength !== totals.lab ? (
                        <span className="sr-only">{` of room booked; lab length ${formatInteger(totals.labLength)} w`}</span>
                      ) : null}
                    </span>
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function WeeksInput({
  value,
  savedValue,
  drafted,
  label,
  cell,
  invalidKey,
  disabled,
  onCommit,
  onInvalid,
  onMove,
}: {
  value: number;
  savedValue: number;
  drafted: boolean;
  label: string;
  cell: string;
  invalidKey: string;
  disabled: boolean;
  onCommit: (weeks: number) => void;
  onInvalid: (key: string, invalid: boolean) => void;
  onMove: (dRow: number, dCol: number) => void;
}): React.JSX.Element {
  const [text, setText] = React.useState(String(value));
  const [seen, setSeen] = React.useState(value);
  // A value changed elsewhere (timeline ±, Discard, a reload) re-seeds the text.
  if (seen !== value) {
    setSeen(value);
    if (parseWeeks(text) !== value) setText(String(value));
  }
  const invalid = parseWeeks(text) === null;
  React.useEffect(() => {
    onInvalid(invalidKey, invalid);
  }, [invalid, invalidKey, onInvalid]);
  React.useEffect(() => () => onInvalid(invalidKey, false), [invalidKey, onInvalid]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    switch (e.key) {
      case 'ArrowUp':
        e.preventDefault();
        onMove(-1, 0);
        return;
      case 'ArrowDown':
        e.preventDefault();
        onMove(1, 0);
        return;
      case 'ArrowLeft':
        e.preventDefault();
        onMove(0, -1);
        return;
      case 'ArrowRight':
        e.preventDefault();
        onMove(0, 1);
        return;
      case 'Enter':
        e.preventDefault();
        onMove(e.shiftKey ? -1 : 1, 0);
        return;
      case 'Escape':
        e.preventDefault();
        setText(String(savedValue));
        onCommit(savedValue);
        return;
      default:
    }
  };

  return (
    <input
      type="text"
      inputMode="numeric"
      autoComplete="off"
      maxLength={3}
      value={text}
      disabled={disabled}
      aria-label={label}
      aria-invalid={invalid || undefined}
      data-cell={cell}
      data-drafted={drafted || undefined}
      title={invalid ? `Whole weeks, 0 to ${String(WEEKS_MAX)}` : drafted ? `Changed — saved value ${String(savedValue)}w` : undefined}
      onFocus={(e) => e.currentTarget.select()}
      onKeyDown={onKeyDown}
      onChange={(e) => {
        const next = e.target.value;
        setText(next);
        const weeks = parseWeeks(next);
        if (weeks !== null) onCommit(weeks);
      }}
      className={cn(
        'block h-7 w-full min-w-[3.25rem] bg-transparent text-center text-xs font-semibold tabular-nums text-text',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
        value === 0 && !drafted && 'font-normal text-text-subtle',
        drafted && 'italic underline decoration-primary decoration-2 underline-offset-2',
        invalid && 'ring-2 ring-inset ring-danger',
      )}
    />
  );
}

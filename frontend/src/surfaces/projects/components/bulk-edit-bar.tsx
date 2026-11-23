import * as React from 'react';
import { RotateCcw, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { isStatusOptionLocked, statusOptionLabel, useIsSuperAdmin } from '@/lib/auth/super-admin';
import type { Category } from '@/lib/api/categories';
import type { WorkflowStepTemplate } from '@/lib/api/reference';
import { formatInteger } from '@/lib/format';
import { cn } from '@/lib/utils';
import {
  PRIORITY_LABELS,
  PROJECT_PRIORITIES,
  PROJECT_TYPE_LABELS,
  PROJECT_TYPES,
  UI_PROJECT_STATUSES,
  type ProjectPriority,
  type ProjectStatus,
  type ProjectType,
} from '@/types/enums';

import type { EngineerOption } from '@/surfaces/registration/api/engineers-api';

import { parseEffortInput, type RegisterDraft } from '../lib/register-edit';
import { EDIT_INPUT } from './register-edit-cells';

/**
 * P35-T08: the bulk-edit bar shown while rows are ticked in Edit mode. Each
 * "Set" stages one value on every ticked row, in the same edit session the
 * cells write — nothing is sent until the edit bar's Save (one batch).
 * Mirrors the old tool's bar (assign resource / status / times), without
 * requesting department (read-only here, ADR 0035).
 *
 * P59 (owner 2026-11-23): Priority, Current step, Category and Type too, staged the same way
 * and sent in the same batch. A Commercialized / Cancelled row gets no
 * priority (ADR 0067); the bar says how many were skipped. A band change puts
 * the project at the end of its new band (server rule).
 */

/** "2 Commercialized/Cancelled rows skipped — priority not applicable". */
export function prioritySkippedText(count: number): string {
  return `${formatInteger(count)} Commercialized/Cancelled ${count === 1 ? 'row' : 'rows'} skipped — priority not applicable`;
}

const NO_CHANGE = '__no_change__';
const UNASSIGNED = '__unassigned__';

export function BulkEditBar({
  selectedCount,
  draftCount,
  notApplicableCount = 0,
  leaderOptions,
  leaderNote,
  workflowOptions = null,
  workflowNote = null,
  onApply,
  onClearSelection,
}: {
  selectedCount: number;
  /** Ticked rows still in Draft: a status is not set on them. */
  draftCount: number;
  /** P59: ticked Commercialized / Cancelled rows: a priority is not set on them. */
  notApplicableCount?: number;
  /** Engineers valid for every ticked row's hub (served lists), or null when
   *  the ticked rows have no common list. */
  leaderOptions: readonly EngineerOption[] | null;
  /** Why no design resource is offered (mixed hubs, loading…). */
  leaderNote: string | null;
  /** P59: the categories and steps of the ticked rows' ONE workflow (served
   *  lists), or null when they span both workflows / are loading. */
  workflowOptions?: { categories: readonly Category[]; steps: readonly WorkflowStepTemplate[] } | null;
  /** Why no category / step is offered ("Pick projects of one workflow…"). */
  workflowNote?: string | null;
  onApply: (patch: RegisterDraft) => void;
  onClearSelection: () => void;
}): React.JSX.Element {
  const ids = React.useId();
  const [leader, setLeader] = React.useState(NO_CHANGE);
  const [status, setStatus] = React.useState<string>(NO_CHANGE);
  const superAdmin = useIsSuperAdmin();
  const [design, setDesign] = React.useState('');
  const [lab, setLab] = React.useState('');
  const [priority, setPriority] = React.useState<string>(NO_CHANGE);
  const [step, setStep] = React.useState<string>(NO_CHANGE);
  const [category, setCategory] = React.useState<string>(NO_CHANGE);
  const [type, setType] = React.useState<string>(NO_CHANGE);
  const [notice, setNotice] = React.useState<string | null>(null);

  const designValue = design.trim() === '' ? undefined : parseEffortInput(design);
  const labValue = lab.trim() === '' ? undefined : parseEffortInput(lab);
  const designBad = design.trim() !== '' && designValue === undefined;
  const labBad = lab.trim() !== '' && labValue === undefined;
  const rowsText = (n: number): string => `${formatInteger(n)} ${n === 1 ? 'row' : 'rows'}`;

  const apply = (patch: RegisterDraft, what: string): void => {
    onApply(patch);
    setNotice(`${what} staged on ${rowsText(selectedCount)}. Save to send.`);
  };

  const applyPriority = (): void => {
    onApply({ priority: priority as ProjectPriority });
    const staged = Math.max(0, selectedCount - notApplicableCount);
    const skipped = notApplicableCount > 0 ? ` ${prioritySkippedText(notApplicableCount)}.` : '';
    setNotice(
      staged > 0
        ? `Priority ${priority} staged on ${rowsText(staged)} (each goes to the end of the band).${skipped} Save to send.`
        : `No priority staged.${skipped}`,
    );
  };

  return (
    <div
      role="region"
      aria-label="Bulk edit ticked rows"
      className="mb-3 flex flex-wrap items-end gap-3 rounded-card border-[1.5px] border-primary/40 bg-primary-subtle px-3 py-2"
      data-testid="bulk-edit-bar"
    >
      <span className="self-center text-xs font-semibold text-primary-subtle-fg" data-testid="bulk-selected-count">
        {formatInteger(selectedCount)} selected
      </span>

      <div className="flex items-end gap-1.5">
        <label htmlFor={`${ids}-leader`} className="flex flex-col gap-0.5 text-2xs font-semibold text-text-muted">
          Design resource (leader)
          <select
            id={`${ids}-leader`}
            className={cn(EDIT_INPUT, 'w-44')}
            value={leader}
            disabled={leaderOptions === null}
            title={leaderNote ?? undefined}
            onChange={(e) => setLeader(e.currentTarget.value)}
            data-testid="bulk-leader"
          >
            <option value={NO_CHANGE}>Choose…</option>
            <option value={UNASSIGNED}>Unassigned</option>
            {(leaderOptions ?? []).map((e) => (
              <option key={e.id} value={e.id}>
                {e.name}
              </option>
            ))}
          </select>
        </label>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="h-7"
          disabled={leader === NO_CHANGE || leaderOptions === null}
          onClick={() => apply({ leader_engineer_id: leader === UNASSIGNED ? null : leader }, 'Design resource')}
          data-testid="bulk-leader-apply"
        >
          Set
        </Button>
      </div>

      <div className="flex items-end gap-1.5">
        <label htmlFor={`${ids}-status`} className="flex flex-col gap-0.5 text-2xs font-semibold text-text-muted">
          Status
          <select
            id={`${ids}-status`}
            className={cn(EDIT_INPUT, 'w-44')}
            value={status}
            onChange={(e) => setStatus(e.currentTarget.value)}
            data-testid="bulk-status"
          >
            <option value={NO_CHANGE}>Choose…</option>
            {UI_PROJECT_STATUSES.map((s) => {
              // P46 (ADR 0058 D1.1): only a Super Admin may set Cancelled.
              const locked = isStatusOptionLocked(s, superAdmin);
              return (
                <option key={s} value={s} disabled={locked}>
                  {statusOptionLabel(s, locked)}
                </option>
              );
            })}
          </select>
        </label>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="h-7"
          disabled={status === NO_CHANGE}
          onClick={() => apply({ status: status as ProjectStatus }, 'Status')}
          data-testid="bulk-status-apply"
        >
          Set
        </Button>
      </div>

      <div className="flex items-end gap-1.5">
        <label htmlFor={`${ids}-design`} className="flex flex-col gap-0.5 text-2xs font-semibold text-text-muted">
          Design time (wk)
          <input
            id={`${ids}-design`}
            type="text"
            inputMode="decimal"
            className={cn(EDIT_INPUT, 'w-20 text-right tabular-nums')}
            value={design}
            aria-invalid={designBad ? true : undefined}
            onChange={(e) => setDesign(e.currentTarget.value)}
            data-testid="bulk-design"
          />
        </label>
        <label htmlFor={`${ids}-lab`} className="flex flex-col gap-0.5 text-2xs font-semibold text-text-muted">
          Lab time (wk)
          <input
            id={`${ids}-lab`}
            type="text"
            inputMode="decimal"
            className={cn(EDIT_INPUT, 'w-20 text-right tabular-nums')}
            value={lab}
            aria-invalid={labBad ? true : undefined}
            onChange={(e) => setLab(e.currentTarget.value)}
            data-testid="bulk-lab"
          />
        </label>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="h-7"
          disabled={designBad || labBad || (designValue === undefined && labValue === undefined)}
          onClick={() => {
            const patch: RegisterDraft = {};
            if (designValue !== undefined) patch.design_effort_weeks = designValue;
            if (labValue !== undefined) patch.lab_effort_weeks = labValue;
            apply(patch, 'Times');
            setDesign('');
            setLab('');
          }}
          data-testid="bulk-times-apply"
        >
          Set times
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7"
          onClick={() => apply({ design_effort_weeks: null, lab_effort_weeks: null }, 'Reset to calculated times')}
          data-testid="bulk-times-reset"
        >
          <RotateCcw aria-hidden="true" />
          Reset times
        </Button>
      </div>

      <div className="flex items-end gap-1.5">
        <label htmlFor={`${ids}-priority`} className="flex flex-col gap-0.5 text-2xs font-semibold text-text-muted">
          Priority
          <select
            id={`${ids}-priority`}
            className={cn(EDIT_INPUT, 'w-28')}
            value={priority}
            onChange={(e) => setPriority(e.currentTarget.value)}
            data-testid="bulk-priority"
          >
            <option value={NO_CHANGE}>Choose…</option>
            {PROJECT_PRIORITIES.map((p) => (
              <option key={p} value={p} title={PRIORITY_LABELS[p]}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="h-7"
          disabled={priority === NO_CHANGE}
          onClick={applyPriority}
          data-testid="bulk-priority-apply"
        >
          Set
        </Button>
      </div>

      <div className="flex items-end gap-1.5">
        <label htmlFor={`${ids}-step`} className="flex flex-col gap-0.5 text-2xs font-semibold text-text-muted">
          Current step
          <select
            id={`${ids}-step`}
            className={cn(EDIT_INPUT, 'w-36')}
            value={step}
            disabled={workflowOptions === null}
            title={workflowNote ?? undefined}
            onChange={(e) => setStep(e.currentTarget.value)}
            data-testid="bulk-step"
          >
            <option value={NO_CHANGE}>Choose…</option>
            {(workflowOptions?.steps ?? []).map((t) => (
              <option key={t.code} value={t.code} title={t.name}>
                {t.code} · {t.name}
              </option>
            ))}
          </select>
        </label>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="h-7"
          disabled={step === NO_CHANGE || workflowOptions === null}
          onClick={() => apply({ current_step_code: step }, 'Current step')}
          data-testid="bulk-step-apply"
        >
          Set
        </Button>
      </div>

      <div className="flex items-end gap-1.5">
        <label htmlFor={`${ids}-category`} className="flex flex-col gap-0.5 text-2xs font-semibold text-text-muted">
          Category
          <select
            id={`${ids}-category`}
            className={cn(EDIT_INPUT, 'w-24')}
            value={category}
            disabled={workflowOptions === null}
            title={workflowNote ?? undefined}
            onChange={(e) => setCategory(e.currentTarget.value)}
            data-testid="bulk-category"
          >
            <option value={NO_CHANGE}>Choose…</option>
            {(workflowOptions?.categories ?? []).map((c) => (
              <option key={c.code} value={c.code} title={c.label}>
                {c.code}
              </option>
            ))}
          </select>
        </label>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="h-7"
          disabled={category === NO_CHANGE || workflowOptions === null}
          onClick={() => apply({ category }, 'Category')}
          data-testid="bulk-category-apply"
        >
          Set
        </Button>
      </div>

      <div className="flex items-end gap-1.5">
        <label htmlFor={`${ids}-type`} className="flex flex-col gap-0.5 text-2xs font-semibold text-text-muted">
          Type
          <select
            id={`${ids}-type`}
            className={cn(EDIT_INPUT, 'w-28')}
            value={type}
            onChange={(e) => setType(e.currentTarget.value)}
            data-testid="bulk-type"
          >
            <option value={NO_CHANGE}>Choose…</option>
            {PROJECT_TYPES.map((t) => (
              <option key={t} value={t} title={PROJECT_TYPE_LABELS[t]}>
                {t} · {PROJECT_TYPE_LABELS[t]}
              </option>
            ))}
          </select>
        </label>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          className="h-7"
          disabled={type === NO_CHANGE}
          onClick={() => apply({ project_type: type as ProjectType }, 'Type')}
          data-testid="bulk-type-apply"
        >
          Set
        </Button>
      </div>

      <Button type="button" variant="ghost" size="sm" className="ml-auto h-7" onClick={onClearSelection}>
        <X aria-hidden="true" />
        Clear selection
      </Button>

      <div className="basis-full text-2xs text-text-muted" role="status" aria-live="polite" data-testid="bulk-notice">
        {notice}
        {leaderNote && leaderOptions === null ? <span className="ml-1">{leaderNote}</span> : null}
        {workflowNote && workflowOptions === null ? (
          <span className="ml-1" data-testid="bulk-workflow-note">
            {workflowNote}
          </span>
        ) : null}
        {notApplicableCount > 0 ? (
          <span className="ml-1" data-testid="bulk-priority-skip">
            {`${formatInteger(notApplicableCount)} ticked ${notApplicableCount === 1 ? 'row is' : 'rows are'} Commercialized/Cancelled: a priority is not set on ${notApplicableCount === 1 ? 'it' : 'them'}.`}
          </span>
        ) : null}
        {draftCount > 0 ? (
          <span className="ml-1">
            {`${formatInteger(draftCount)} ticked ${draftCount === 1 ? 'row is' : 'rows are'} in Draft: a status is not set on ${draftCount === 1 ? 'it' : 'them'}.`}
          </span>
        ) : null}
      </div>
    </div>
  );
}

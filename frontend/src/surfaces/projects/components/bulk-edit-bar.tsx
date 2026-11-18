import * as React from 'react';
import { RotateCcw, X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { isStatusOptionLocked, statusOptionLabel, useIsSuperAdmin } from '@/lib/auth/super-admin';
import { formatInteger } from '@/lib/format';
import { cn } from '@/lib/utils';
import { UI_PROJECT_STATUSES, type ProjectStatus } from '@/types/enums';

import type { EngineerOption } from '@/surfaces/registration/api/engineers-api';

import { parseEffortInput, type RegisterDraft } from '../lib/register-edit';
import { EDIT_INPUT } from './register-edit-cells';

/**
 * P35-T08: the bulk-edit bar shown while rows are ticked in Edit mode. Each
 * "Set" stages one value on every ticked row, in the same edit session the
 * cells write — nothing is sent until the edit bar's Save (one batch).
 * Mirrors the old tool's bar (assign resource / status / times), without
 * requesting department (read-only here, ADR 0035).
 */

const NO_CHANGE = '__no_change__';
const UNASSIGNED = '__unassigned__';

export function BulkEditBar({
  selectedCount,
  draftCount,
  leaderOptions,
  leaderNote,
  onApply,
  onClearSelection,
}: {
  selectedCount: number;
  /** Ticked rows still in Draft: a status is not set on them. */
  draftCount: number;
  /** Engineers valid for every ticked row's hub (served lists), or null when
   *  the ticked rows have no common list. */
  leaderOptions: readonly EngineerOption[] | null;
  /** Why no design resource is offered (mixed hubs, loading…). */
  leaderNote: string | null;
  onApply: (patch: RegisterDraft) => void;
  onClearSelection: () => void;
}): React.JSX.Element {
  const ids = React.useId();
  const [leader, setLeader] = React.useState(NO_CHANGE);
  const [status, setStatus] = React.useState<string>(NO_CHANGE);
  const superAdmin = useIsSuperAdmin();
  const [design, setDesign] = React.useState('');
  const [lab, setLab] = React.useState('');
  const [notice, setNotice] = React.useState<string | null>(null);

  const designValue = design.trim() === '' ? undefined : parseEffortInput(design);
  const labValue = lab.trim() === '' ? undefined : parseEffortInput(lab);
  const designBad = design.trim() !== '' && designValue === undefined;
  const labBad = lab.trim() !== '' && labValue === undefined;
  const rows = `${formatInteger(selectedCount)} ${selectedCount === 1 ? 'row' : 'rows'}`;

  const apply = (patch: RegisterDraft, what: string): void => {
    onApply(patch);
    setNotice(`${what} staged on ${rows}. Save to send.`);
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

      <Button type="button" variant="ghost" size="sm" className="ml-auto h-7" onClick={onClearSelection}>
        <X aria-hidden="true" />
        Clear selection
      </Button>

      <div className="basis-full text-2xs text-text-muted" role="status" aria-live="polite" data-testid="bulk-notice">
        {notice}
        {leaderNote && leaderOptions === null ? <span className="ml-1">{leaderNote}</span> : null}
        {draftCount > 0 ? (
          <span className="ml-1">
            {`${formatInteger(draftCount)} ticked ${draftCount === 1 ? 'row is' : 'rows are'} in Draft: a status is not set on ${draftCount === 1 ? 'it' : 'them'}.`}
          </span>
        ) : null}
      </div>
    </div>
  );
}

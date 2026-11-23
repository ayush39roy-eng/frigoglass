import * as React from 'react';
import { X } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { formatInteger } from '@/lib/format';
import { cn } from '@/lib/utils';
import { PROJECT_PRIORITIES, type ProjectPriority } from '@/types/enums';

import { registerRowErrorText, type RegisterEditError } from '@/surfaces/projects/api/register-edits';
import { RegisterDiscardDialog } from '@/surfaces/projects/components/register-edit-bar';
import { RegisterSavePanel } from '@/surfaces/projects/components/register-save-panel';
import { useRegisterSave } from '@/surfaces/projects/hooks/use-register-save';

/**
 * P59 (owner 2026-11-23): Priority board multi-select. Ticked cards are moved
 * to one band with ONE `POST /projects/register-edits` (`{project_id, priority}`
 * per project): the server puts each at the end of its new band and runs one
 * recalculation for the batch. The shared register save hook follows the run
 * and invalidates the same caches a register Save does (board, matrix,
 * projects, dashboard, gantt, vip board). Drag-and-drop and the single move
 * are unchanged. Shown only with Registration write (the context is null
 * otherwise, so no checkbox renders).
 */

export interface BoardSelection {
  selected: ReadonlySet<string>;
  toggle: (projectId: string, on: boolean) => void;
  setMany: (projectIds: readonly string[], on: boolean) => void;
}

export const BoardSelectionContext = React.createContext<BoardSelection | null>(null);

export function useBoardSelectionState(): BoardSelection & { clear: () => void } {
  const [selected, setSelected] = React.useState<ReadonlySet<string>>(() => new Set());
  const toggle = React.useCallback((id: string, on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  const setMany = React.useCallback((ids: readonly string[], on: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  }, []);
  const clear = React.useCallback(() => setSelected(new Set()), []);
  return { selected, toggle, setMany, clear };
}

/** The tick box on a card or list row. */
export function BoardSelectCheckbox({
  projectId,
  projectName,
  className,
}: {
  projectId: string;
  projectName: string;
  className?: string;
}): React.JSX.Element | null {
  const selection = React.useContext(BoardSelectionContext);
  if (!selection) return null;
  return (
    <Checkbox
      className={cn('mt-1 shrink-0', className)}
      checked={selection.selected.has(projectId)}
      onCheckedChange={(v) => selection.toggle(projectId, v === true)}
      aria-label={`Select ${projectName}`}
      data-testid="board-select"
    />
  );
}

/** "Select all" of one column (the cards shown in it). */
export function BoardColumnSelectAll({ band, projectIds }: { band: ProjectPriority; projectIds: readonly string[] }): React.JSX.Element | null {
  const selection = React.useContext(BoardSelectionContext);
  if (!selection || projectIds.length === 0) return null;
  const ticked = projectIds.filter((id) => selection.selected.has(id)).length;
  const state = ticked === 0 ? false : ticked === projectIds.length ? true : 'indeterminate';
  return (
    <Checkbox
      checked={state}
      onCheckedChange={(v) => selection.setMany(projectIds, v === true)}
      aria-label={`Select all ${band} projects`}
      data-testid="board-column-select-all"
    />
  );
}

/** "N selected → Move to [band] → Move", the confirm dialog, the save panel and per-project errors. */
export function BoardBulkMoveBar({
  selected,
  projectName,
  onClear,
  request = null,
}: {
  selected: readonly string[];
  projectName: (projectId: string) => string | undefined;
  onClear: () => void;
  /** P59 multi-drag: a drop of a selected card on another column asks to move
   *  the whole selection there (a new object each drop opens the confirm). */
  request?: { band: ProjectPriority } | null;
}): React.JSX.Element | null {
  const save = useRegisterSave();
  const ids = React.useId();
  const [band, setBand] = React.useState<ProjectPriority | ''>('');
  const [confirming, setConfirming] = React.useState(false);
  const [errors, setErrors] = React.useState<readonly RegisterEditError[]>([]);
  const [message, setMessage] = React.useState<string | null>(null);
  // A new drop request opens the same confirm as the bar's Move (state adjusted during render).
  const [seenRequest, setSeenRequest] = React.useState(request);
  if (request !== seenRequest) {
    setSeenRequest(request);
    if (request) {
      setBand(request.band);
      setConfirming(true);
    }
  }

  const count = selected.length;
  const projects = `${formatInteger(count)} ${count === 1 ? 'project' : 'projects'}`;

  const move = async (): Promise<void> => {
    if (band === '') return;
    setConfirming(false);
    setErrors([]);
    setMessage(null);
    const result = await save.save({ edits: selected.map((project_id) => ({ project_id, priority: band })) });
    if (result.ok) {
      onClear();
      setBand('');
      return;
    }
    setErrors(result.rowErrors);
    setMessage(result.message);
  };

  const panel = (
    <RegisterSavePanel
      flow={save.flow}
      runState={save.runState}
      changes={save.changes}
      watchingFollowUp={save.watchingFollowUp}
      onClose={save.close}
      effChanges={save.effChanges}
      projectName={projectName}
    />
  );

  if (count === 0 && errors.length === 0 && message === null) return panel;

  return (
    <>
      <div
        role="region"
        aria-label="Move ticked projects"
        className="mb-3 flex flex-wrap items-end gap-3 rounded-card border-[1.5px] border-primary/40 bg-primary-subtle px-3 py-2"
        data-testid="board-bulk-bar"
      >
        <span className="self-center text-xs font-semibold text-primary-subtle-fg" data-testid="board-bulk-count">
          {formatInteger(count)} selected
        </span>
        <label htmlFor={`${ids}-band`} className="flex flex-col gap-0.5 text-2xs font-semibold text-text-muted">
          Move to
          <select
            id={`${ids}-band`}
            className="h-7 w-28 rounded-sm border border-border bg-surface px-1.5 text-xs text-text"
            value={band}
            onChange={(e) => setBand(e.currentTarget.value as ProjectPriority | '')}
            data-testid="board-bulk-band"
          >
            <option value="">Choose…</option>
            {PROJECT_PRIORITIES.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <Button
          type="button"
          size="sm"
          className="h-7"
          disabled={band === '' || count === 0 || save.saving}
          onClick={() => setConfirming(true)}
          data-testid="board-bulk-move"
        >
          Move
        </Button>
        <Button type="button" variant="ghost" size="sm" className="ml-auto h-7" onClick={onClear}>
          <X aria-hidden="true" />
          Clear selection
        </Button>
        {message || errors.length > 0 ? (
          <div className="basis-full text-2xs text-danger" role="alert" data-testid="board-bulk-errors">
            {message ? <p>{message}</p> : null}
            {errors.length > 0 ? (
              <ul className="mt-0.5 list-disc pl-4">
                {errors.map((e) => (
                  <li key={`${e.project_id}-${e.code}`}>
                    {projectName(e.project_id) ?? e.project_id}: {registerRowErrorText(e)}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
      <RegisterDiscardDialog
        open={confirming}
        title={`Move ${projects} to ${band}?`}
        description={`Move ${projects} to ${band}? The schedule recalculates once. Each goes to the end of ${band}.`}
        keepLabel="Cancel"
        discardLabel="Move"
        onKeep={() => setConfirming(false)}
        onDiscard={() => void move()}
        testId="board-bulk-confirm"
      />
      {panel}
    </>
  );
}

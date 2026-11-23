import * as React from 'react';
import { BookmarkPlus, Download } from 'lucide-react';

import { Button } from '@/components/ui/button';
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
import { Spinner } from '@/components/ui/spinner';

import { downloadCurrentResult, downloadSavedScenario } from '../import-api';
import { useImportPlan } from '../import-store';
import { currentRequest, MAX_SAVED_NAME, MAX_SAVED_NOTE, storedEntryOf } from '../saved-scenarios';
import { useImportScenarios } from '../scenarios-store';
import { libraryErrorMessage, useCreateSavedScenario, useDownload } from '../use-import-library';
import { useImportToast } from '../toast-store';

/**
 * P41 (ADR 0055 D3 / D5, contract E2): "Save scenario" and "Export" for what the results
 * show. The current result (or a session variant) is saved by sending its REQUEST; the
 * server re-runs it and stores its own output. Export of an unsaved result also sends the
 * request; a saved one is exported by id.
 */

export function SaveImportScenarioButton({ disabled }: { disabled: boolean }): React.JSX.Element {
  const view = useImportPlan((s) => s.view);
  const source = useImportPlan((s) => s.source);
  const [open, setOpen] = React.useState(false);
  const isSaved = view?.kind === 'saved';
  const noSource = source?.sha256 == null;
  const reason = isSaved
    ? 'This scenario is already saved'
    : noSource
      ? 'This browser could not fingerprint the file, so it cannot be saved'
      : undefined;
  return (
    <>
      <Button
        type="button"
        size="sm"
        variant="secondary"
        disabled={disabled || reason !== undefined}
        title={reason}
        onClick={() => setOpen(true)}
      >
        <BookmarkPlus />
        Save scenario
      </Button>
      {open ? <SaveDialog onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function SaveDialog({ onClose }: { onClose: () => void }): React.JSX.Element {
  const view = useImportPlan((s) => s.view);
  const fileName = useImportPlan((s) => s.source?.file_name ?? '');
  const [name, setName] = React.useState(() => (view ? view.name : ''));
  const [note, setNote] = React.useState('');
  const create = useCreateSavedScenario();
  const addStored = useImportScenarios((s) => s.addStored);
  const toast = useImportToast((s) => s.show);
  const nameId = React.useId();
  const noteId = React.useId();
  const clean = name.trim();

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const st = useImportPlan.getState();
    const src = st.source;
    if (clean === '' || !src?.sha256 || create.isPending) return;
    const trimmedNote = note.trim();
    create.mutate(
      {
        name: clean,
        ...(trimmedNote === '' ? {} : { note: trimmedNote }),
        source_file_name: src.file_name,
        source_file_sha256: src.sha256,
        imported_at: src.imported_at,
        request: currentRequest(st),
      },
      {
        onSuccess: (saved) => {
          addStored(storedEntryOf(saved));
          toast(`Scenario “${saved.name}” saved. It is in the saved scenarios and ready to compare.`);
          onClose();
        },
      },
    );
  };

  return (
    <Dialog open onOpenChange={(o) => (o || create.isPending ? undefined : onClose())}>
      <DialogContent className="max-w-md" data-testid="import-save-scenario">
        <form onSubmit={submit} className="space-y-s4">
          <DialogHeader>
            <DialogTitle>Save scenario</DialogTitle>
            <DialogDescription>
              The server recomputes it on today&apos;s plan and keeps it for later reference
              {fileName ? `, filed under ${fileName}` : ''}. The real plan is not changed.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1">
            <Label htmlFor={nameId} className="text-2xs text-text-muted">
              Scenario name
            </Label>
            <Input id={nameId} value={name} maxLength={MAX_SAVED_NAME} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor={noteId} className="text-2xs text-text-muted">
              Note (optional)
            </Label>
            <textarea
              id={noteId}
              className="min-h-20 rounded border border-border-strong bg-surface px-2 py-1.5 text-sm text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              value={note}
              maxLength={MAX_SAVED_NOTE}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          {create.isError ? (
            <p role="alert" className="text-xs font-medium text-danger-subtle-fg">
              {libraryErrorMessage(create.error)}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="ghost" disabled={create.isPending} onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={clean === '' || create.isPending}>
              {create.isPending ? <Spinner className="size-4" /> : null}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Export what the results show: a saved scenario by id, anything else from its request. */
export function ExportScenarioButton({ disabled }: { disabled: boolean }): React.JSX.Element {
  const download = useDownload();
  const onClick = () => {
    const st = useImportPlan.getState();
    const view = st.view;
    if (view?.kind === 'saved') {
      void download.run('export', () => downloadSavedScenario(view.id, view.name));
      return;
    }
    // Unnamed result: no name, so the server's "whatif-import-result.xlsx" applies.
    const name = view?.name ?? null;
    const request = currentRequest(st);
    void download.run('export', () => downloadCurrentResult(name, request));
  };
  return (
    <span className="inline-flex items-center gap-s2">
      <Button type="button" size="sm" variant="secondary" disabled={disabled || download.pending !== null} onClick={onClick}>
        {download.pending ? <Spinner className="size-3.5" /> : <Download />}
        Export to Excel (with Gantt chart)
      </Button>
      {download.error ? (
        <span role="alert" className="text-2xs font-medium text-danger-subtle-fg">
          {download.error}
        </span>
      ) : null}
    </span>
  );
}

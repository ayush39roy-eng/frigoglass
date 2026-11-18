import * as React from 'react';
import { Download, FileSpreadsheet, Pencil, Plus, RotateCcw, X } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
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
import { Skeleton } from '@/components/ui/skeleton';
import { Spinner } from '@/components/ui/spinner';
import { ApiError } from '@/lib/api/client';
import { useIsSuperAdmin } from '@/lib/auth/super-admin';
import { SuperAdminOnly } from '@/components/shared/super-admin-only';
import { formatTimestamp } from '@/lib/format';

import { downloadFormatTemplate } from '../import-api';
import {
  draftBody,
  draftOf,
  hasDraftErrors,
  MAX_ALIAS_LENGTH,
  MAX_ALIASES,
  requirementOf,
  validateFormatDraft,
  withAlias,
  type FormatDraft,
} from '../import-format';
import type { ImportFormat, ImportFormatField } from '../import-types';
import {
  libraryErrorMessage,
  useDownload,
  useImportFormat,
  useIsFormatAdmin,
  useResetImportFormat,
  useSaveImportFormat,
} from '../use-import-library';
import { FeatureCard } from './feature-card';
import { useImportToast } from '../toast-store';

/**
 * P41 (ADR 0055 D1, contract E1): the Upload step's "Excel format" card. Everyone sees the
 * header names the parser looks for and can download a blank template; Admin and Super
 * Admin get "Edit format". When the format cannot be read, the built-in headers are shown.
 */

/** Shown while the served format is not available (the parser's built-in names). */
const BUILT_IN_HEADERS = [
  'Project description',
  'Status',
  'RPD HUB',
  'Project Category',
  'PDD Project Stage',
  'PRIORITY',
  'Recommended Design Engineer',
  'Project code',
  'Plant',
  'Num of Projects',
];

function AliasChip({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <li className="rounded-pill border border-border bg-surface-sunken px-2 py-0.5 text-2xs text-text">{children}</li>
  );
}

function FormatList({ format }: { format: ImportFormat }): React.JSX.Element {
  return (
    <dl className="grid gap-x-s4 gap-y-s2 sm:grid-cols-2" data-testid="import-format-fields">
      {format.fields.map((f) => {
        const req = requirementOf(f.key, f.required);
        return (
          <div key={f.key} className="min-w-0" data-field={f.key}>
            <dt className="flex items-center gap-1 text-2xs font-semibold text-text">
              {f.label}
              {req ? <Badge tone={f.required ? 'primary' : 'neutral'}>{req}</Badge> : null}
            </dt>
            <dd>
              {f.aliases.length === 0 ? (
                <span className="text-2xs text-text-muted">not read</span>
              ) : (
                <ul className="mt-0.5 flex flex-wrap gap-1" aria-label={`Header names for ${f.label}`}>
                  {f.aliases.map((a) => (
                    <AliasChip key={a}>{a}</AliasChip>
                  ))}
                </ul>
              )}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}

export function ExcelFormatCard(): React.JSX.Element {
  const format = useImportFormat();
  const isAdmin = useIsFormatAdmin();
  const download = useDownload();
  const [editing, setEditing] = React.useState(false);
  const data = format.data;
  const canEdit = isAdmin && data !== undefined && data.can_edit;

  return (
    <FeatureCard
      icon={FileSpreadsheet}
      title="Excel format"
      hint="Columns found by header name, in any order"
      testId="import-format-help"
      bodyClassName="space-y-s3 text-xs text-text-muted"
      actions={
        <>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            disabled={download.pending !== null}
            onClick={() => void download.run('template', downloadFormatTemplate)}
          >
            {download.pending === 'template' ? <Spinner className="size-3.5" /> : <Download />}
            Download template
          </Button>
          {canEdit ? (
            <Button type="button" size="sm" variant="secondary" onClick={() => setEditing(true)}>
              <Pencil />
              Edit format
            </Button>
          ) : null}
        </>
      }
      info={
        <>
          <p>
            The projects sheet needs a header row (in the first 10 rows) with the project name and the status or the
            hub. Any of a field&apos;s header names is accepted.
          </p>
          <p>
            A Process steps sheet with the PDD-A…PDD-N and OEM-A…OEM-N lead times per category gives the step
            durations. Without it the app&apos;s lead-time table is used.
          </p>
          <p>Customer, CAPEX, tooling, volume and comment columns are ignored and never read.</p>
          <p>Admins and Super Admins can change the header names.</p>
        </>
      }
    >
      {download.error ? (
        <p role="alert" className="font-medium text-danger-subtle-fg">
          {download.error}
        </p>
      ) : null}
      {format.isPending ? (
        <div className="space-y-s2" aria-busy="true">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
        </div>
      ) : data ? (
        <>
          <FormatList format={data} />
          <p data-testid="import-format-meta">
            {data.is_default || data.updated_at === null
              ? 'Built-in format.'
              : `Edited${data.updated_by_name ? ` by ${data.updated_by_name}` : ''} on ${formatTimestamp(data.updated_at)}.`}
          </p>
        </>
      ) : (
        <>
          <ul className="flex flex-wrap gap-1.5" aria-label="Columns read">
            {BUILT_IN_HEADERS.map((h) => (
              <AliasChip key={h}>{h}</AliasChip>
            ))}
          </ul>
          <p>The built-in header names are shown; the current format could not be loaded.</p>
        </>
      )}
      <p>
        Plus a <span className="font-medium text-text">Process steps</span> sheet for the step lead times.
      </p>
      {editing && data ? <FormatDialog format={data} onClose={() => setEditing(false)} onReload={() => void format.refetch()} /> : null}
    </FeatureCard>
  );
}

function FieldEditor({
  field,
  aliases,
  error,
  onChange,
}: {
  field: ImportFormatField;
  aliases: string[];
  error: string | undefined;
  onChange: (next: string[]) => void;
}): React.JSX.Element {
  const [text, setText] = React.useState('');
  const inputId = React.useId();
  const errorId = React.useId();
  const req = requirementOf(field.key, field.required);
  const full = aliases.length >= MAX_ALIASES;
  const add = () => {
    onChange(withAlias(aliases, text));
    setText('');
  };
  return (
    <li className="space-y-1.5 rounded-md border border-border px-s3 py-s2" data-testid="format-field" data-field={field.key}>
      <div className="flex flex-wrap items-center gap-s2">
        <label htmlFor={inputId} className="text-sm font-semibold text-text">
          {field.label}
        </label>
        {req ? <Badge tone={field.required ? 'primary' : 'neutral'}>{req}</Badge> : null}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="ml-auto"
          onClick={() => onChange([...field.default_aliases])}
          aria-label={`Reset ${field.label} to default`}
        >
          <RotateCcw />
          Reset field
        </Button>
      </div>
      <ul className="flex flex-wrap gap-1" aria-label={`Header names for ${field.label}`}>
        {aliases.length === 0 ? <li className="text-2xs text-text-muted">No header name yet.</li> : null}
        {aliases.map((a) => (
          <li
            key={a}
            className="inline-flex items-center gap-1 rounded-pill border border-border bg-surface-sunken py-0.5 pl-2 pr-1 text-2xs text-text"
          >
            {a}
            <button
              type="button"
              className="rounded-full p-0.5 text-text-muted hover:bg-surface-raised hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => onChange(aliases.filter((x) => x !== a))}
              aria-label={`Remove ${a} from ${field.label}`}
            >
              <X className="size-3" aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-s2">
        <Input
          id={inputId}
          className="h-8 max-w-xs text-xs"
          value={text}
          maxLength={MAX_ALIAS_LENGTH}
          disabled={full}
          placeholder={full ? `At most ${String(MAX_ALIASES)}` : 'Add a header name'}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
        />
        <Button
          type="button"
          size="sm"
          variant="secondary"
          disabled={full || text.trim() === ''}
          onClick={add}
          aria-label={`Add header name to ${field.label}`}
        >
          <Plus />
          Add
        </Button>
      </div>
      {error ? (
        <p id={errorId} className="text-2xs font-medium text-danger-subtle-fg">
          {error}
        </p>
      ) : null}
    </li>
  );
}

function FormatDialog({
  format,
  onClose,
  onReload,
}: {
  format: ImportFormat;
  onClose: () => void;
  onReload: () => void;
}): React.JSX.Element {
  const [draft, setDraft] = React.useState<FormatDraft>(() => draftOf(format));
  const [confirmReset, setConfirmReset] = React.useState(false);
  // P46 (ADR 0058 D1.4): "Reset all to default" is Super Admin only.
  const superAdmin = useIsSuperAdmin();
  const save = useSaveImportFormat();
  const reset = useResetImportFormat();
  const toast = useImportToast((s) => s.show);
  const errors = React.useMemo(() => validateFormatDraft(format, draft), [format, draft]);
  const invalid = hasDraftErrors(errors);
  const busy = save.isPending || reset.isPending;
  const failure = save.error ?? reset.error;
  const conflict = failure instanceof ApiError && failure.status === 409;

  // A reload after a 409 brings the new version in: start the draft from it.
  const lastVersion = React.useRef(format.version);
  React.useEffect(() => {
    if (format.version === lastVersion.current) return;
    lastVersion.current = format.version;
    setDraft(draftOf(format));
    save.reset();
    reset.reset();
  }, [format, save, reset]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (invalid || busy) return;
    save.mutate(
      { version: format.version, fields: draftBody(format, draft) },
      {
        onSuccess: () => {
          toast('Excel format saved.');
          onClose();
        },
      },
    );
  };
  const resetAll = () =>
    reset.mutate(format.version, {
      onSuccess: () => {
        toast('Excel format reset to the built-in header names.');
        onClose();
      },
    });

  return (
    <Dialog open onOpenChange={(o) => (o || busy ? undefined : onClose())}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto" data-testid="import-format-dialog">
        <form onSubmit={submit} className="space-y-s4">
          <DialogHeader>
            <DialogTitle>Edit Excel format</DialogTitle>
            <DialogDescription>
              The header names the import looks for, per column. Matching ignores case and extra spaces.
            </DialogDescription>
          </DialogHeader>
          <ul className="space-y-s2">
            {format.fields.map((f) => (
              <FieldEditor
                key={f.key}
                field={f}
                aliases={draft[f.key] ?? []}
                error={errors.fields[f.key]}
                onChange={(next) => setDraft((d) => ({ ...d, [f.key]: next }))}
              />
            ))}
          </ul>
          {errors.form ? (
            <p className="text-xs font-medium text-danger-subtle-fg" data-testid="format-form-error">
              {errors.form}
            </p>
          ) : null}
          {failure ? (
            <div role="alert" className="flex flex-wrap items-center gap-s2 text-xs font-medium text-danger-subtle-fg" data-testid="format-save-error">
              <span>{libraryErrorMessage(failure)}</span>
              {conflict ? (
                <Button type="button" size="sm" variant="secondary" onClick={onReload}>
                  Reload
                </Button>
              ) : null}
            </div>
          ) : null}
          {confirmReset && superAdmin ? (
            <div
              role="alertdialog"
              aria-label="Reset all to default"
              className="flex flex-wrap items-center gap-s2 rounded-md border border-warning/50 bg-warning-subtle px-s3 py-s2 text-xs text-warning-subtle-fg"
            >
              <span className="min-w-0 flex-1">Reset every column to the built-in header names?</span>
              <Button type="button" size="sm" variant="ghost" onClick={() => setConfirmReset(false)}>
                Keep editing
              </Button>
              <Button type="button" size="sm" variant="danger" disabled={busy} onClick={resetAll}>
                Reset all
              </Button>
            </div>
          ) : null}
          <DialogFooter className="gap-s2 sm:justify-between">
            <SuperAdminOnly locked={!superAdmin}>
              <Button
                type="button"
                variant="ghost"
                disabled={busy || !superAdmin}
                onClick={() => setConfirmReset(true)}
                data-testid="format-reset-all"
              >
                <RotateCcw />
                Reset all to default
              </Button>
            </SuperAdminOnly>
            <div className="flex gap-s2">
              <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
                Cancel
              </Button>
              <Button type="submit" disabled={invalid || busy}>
                {save.isPending ? <Spinner className="size-4" /> : null}
                Save
              </Button>
            </div>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

import * as React from 'react';
import { Download, FileUp, Pencil, Save, X } from 'lucide-react';

import { EmptyState } from '@/components/shared/empty-state';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ApiError } from '@/lib/api/client';
import { apiErrorMessage } from '@/lib/api/error-messages';
import { saveBlob } from '@/lib/download';
import { formatTimestamp } from '@/lib/format';
import { cn } from '@/lib/utils';

import { FILE_CATEGORIES, type FileCategory, type FileRead } from '../api/types';
import { downloadFile } from '../api/workspace-api';
import { usePatchFile, useUploadFile } from '../hooks/use-workspace';
import {
  ALLOWED_EXTENSIONS,
  formatBytes,
  groupFiles,
  isFileCategory,
  nextVersionFor,
  validateFileDraft,
  type FileDraft,
  type FileGroup,
} from '../lib/file-validation';
import { personLabel } from '../lib/people';

/**
 * Files (P9 contract §7). Drag-and-drop or pick a file, give it a display name
 * (separate from the on-disk name), a category and a description; re-uploading
 * an existing display name creates the next version server-side. Files are
 * DOWNLOADED as bytes (Blob → object URL) and never previewed or rendered
 * inline — they are untrusted content.
 */
const EMPTY: FileDraft = { file: null, display_name: '', category: '', description: '' };

function uploadError(err: unknown): string {
  if (err instanceof ApiError && err.isForbidden && !err.code) return 'Your role cannot upload files to this project.';
  // FILE_TOO_LARGE (413) / UNSUPPORTED_FILE_TYPE (415) — the server sniffs content.
  return apiErrorMessage(err, 'The file could not be uploaded.');
}

export function FilesPanel({ projectId, files, canWrite }: { projectId: string; files: FileRead[]; canWrite: boolean }): React.JSX.Element {
  const upload = useUploadFile(projectId);
  const [draft, setDraft] = React.useState<FileDraft>(EMPTY);
  const [showErrors, setShowErrors] = React.useState(false);
  const [serverError, setServerError] = React.useState<string | null>(null);
  const [dragOver, setDragOver] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const errors = validateFileDraft(draft);
  const nextVersion = nextVersionFor(files, draft.display_name);
  const groups = React.useMemo(() => groupFiles(files), [files]);

  const pick = (file: File | undefined) => {
    if (!file) return;
    setServerError(null);
    setDraft((prev) => ({ ...prev, file, display_name: prev.display_name || file.name }));
    setShowErrors(true);
  };

  const submit = async () => {
    setShowErrors(true);
    if (Object.keys(errors).length > 0 || !draft.file || !isFileCategory(draft.category)) return;
    setServerError(null);
    try {
      await upload.mutateAsync({
        file: draft.file,
        display_name: draft.display_name.trim(),
        category: draft.category,
        description: draft.description.trim() || undefined,
      });
      setDraft(EMPTY);
      setShowErrors(false);
      if (inputRef.current) inputRef.current.value = '';
    } catch (err) {
      setServerError(uploadError(err));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Files</CardTitle>
        <span className="text-2xs text-text-muted">
          {groups.length === 1 ? '1 file' : `${String(groups.length)} files`}
          {files.length !== groups.length ? ` · ${String(files.length)} versions` : ''}
        </span>
      </CardHeader>
      <CardContent className="space-y-3">
        {canWrite ? (
          <div className="space-y-2" data-testid="file-upload">
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragOver(true);
              }}
              onDragLeave={() => setDragOver(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(false);
                pick(e.dataTransfer.files[0]);
              }}
              className={cn(
                'flex flex-col items-center gap-1 rounded-lg border-2 border-dashed px-3 py-4 text-center text-2xs text-text-muted transition-colors duration-fast',
                dragOver ? 'border-primary bg-primary-subtle' : 'border-border-strong bg-surface-sunken',
              )}
              data-testid="file-dropzone"
            >
              <FileUp className="size-5" aria-hidden="true" />
              <span>
                Drop a file here, or{' '}
                <button type="button" className="font-medium text-primary underline underline-offset-2" onClick={() => inputRef.current?.click()}>
                  choose a file
                </button>
              </span>
              <span className="text-text-subtle">Up to 50 MB · {ALLOWED_EXTENSIONS.join(', ')}</span>
              <input
                ref={inputRef}
                type="file"
                className="sr-only"
                aria-label="File to upload"
                accept={ALLOWED_EXTENSIONS.map((e) => `.${e}`).join(',')}
                onChange={(e) => pick(e.target.files?.[0])}
              />
              {draft.file ? (
                <span className="font-medium text-text" data-testid="picked-file">
                  {draft.file.name} · {formatBytes(draft.file.size)}
                </span>
              ) : null}
            </div>
            {showErrors && errors.file ? (
              <p role="alert" className="text-2xs text-danger">
                {errors.file}
              </p>
            ) : null}

            <div className="grid gap-2 sm:grid-cols-2">
              <div className="flex flex-col gap-0.5">
                <label htmlFor="ws-file-name" className="text-2xs text-text-muted">
                  Display name <span className="text-danger">*</span>
                </label>
                <Input
                  id="ws-file-name"
                  value={draft.display_name}
                  onChange={(e) => setDraft((prev) => ({ ...prev, display_name: e.target.value }))}
                  aria-invalid={showErrors && errors.display_name ? true : undefined}
                />
                {showErrors && errors.display_name ? (
                  <span role="alert" className="text-2xs text-danger">
                    {errors.display_name}
                  </span>
                ) : nextVersion !== null ? (
                  <span className="text-2xs text-text-muted" data-testid="version-hint">
                    Matches an existing file — this uploads v{nextVersion}.
                  </span>
                ) : null}
              </div>
              <div className="flex flex-col gap-0.5">
                <label htmlFor="ws-file-category" className="text-2xs text-text-muted">
                  Category <span className="text-danger">*</span>
                </label>
                <select
                  id="ws-file-category"
                  value={draft.category}
                  onChange={(e) => setDraft((prev) => ({ ...prev, category: e.target.value }))}
                  aria-invalid={showErrors && errors.category ? true : undefined}
                  className="h-8 rounded border border-border-strong bg-surface px-2 text-sm text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-[invalid=true]:border-danger"
                >
                  <option value="">Choose…</option>
                  {FILE_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
                {showErrors && errors.category ? (
                  <span role="alert" className="text-2xs text-danger">
                    {errors.category}
                  </span>
                ) : null}
              </div>
              <div className="flex flex-col gap-0.5 sm:col-span-2">
                <label htmlFor="ws-file-desc" className="text-2xs text-text-muted">
                  Description
                </label>
                <Input id="ws-file-desc" value={draft.description} onChange={(e) => setDraft((prev) => ({ ...prev, description: e.target.value }))} />
              </div>
            </div>
            {serverError ? (
              <p role="alert" className="text-2xs text-danger">
                {serverError}
              </p>
            ) : null}
            <div className="flex justify-end">
              <Button type="button" size="sm" onClick={() => void submit()} disabled={upload.isPending}>
                <FileUp />
                {upload.isPending ? 'Uploading…' : 'Upload'}
              </Button>
            </div>
          </div>
        ) : null}

        {groups.length === 0 ? (
          <EmptyState title="No files yet" description={canWrite ? 'Upload drawings, test reports or certificates above.' : 'Nothing has been uploaded to this project.'} />
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border" aria-label="Project files">
            {groups.map((g) => (
              <FileRow key={g.display_name} projectId={projectId} group={g} canWrite={canWrite} />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function FileRow({ projectId, group, canWrite }: { projectId: string; group: FileGroup; canWrite: boolean }): React.JSX.Element {
  const file = group.versions[0]!;
  const older = group.versions.slice(1);
  const patch = usePatchFile(projectId);
  const [editing, setEditing] = React.useState(false);
  const [name, setName] = React.useState(file.display_name);
  const [category, setCategory] = React.useState<FileCategory>(file.category);
  const [description, setDescription] = React.useState(file.description ?? '');
  const [error, setError] = React.useState<string | null>(null);
  const [downloading, setDownloading] = React.useState(false);

  const download = async (version: FileRead = file) => {
    setError(null);
    setDownloading(true);
    try {
      const { blob, filename } = await downloadFile(projectId, version);
      saveBlob(blob, filename);
    } catch {
      setError('The file could not be downloaded.');
    } finally {
      setDownloading(false);
    }
  };

  return (
    <li className="space-y-1 px-3 py-2 text-xs" data-testid={`file-${file.id}`}>
      {editing ? (
        <div className="grid gap-2 sm:grid-cols-3">
          <Input aria-label={`Display name for ${file.display_name}`} value={name} onChange={(e) => setName(e.target.value)} />
          <select
            aria-label={`Category for ${file.display_name}`}
            value={category}
            onChange={(e) => {
              if (isFileCategory(e.target.value)) setCategory(e.target.value);
            }}
            className="h-8 rounded border border-border-strong bg-surface px-2 text-sm text-text"
          >
            {FILE_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
          <Input aria-label={`Description for ${file.display_name}`} value={description} onChange={(e) => setDescription(e.target.value)} />
          <p className="text-2xs text-text-subtle sm:col-span-3">
            Renaming applies to every version; category and description apply to v{file.version} only.
          </p>
          <div className="flex justify-end gap-1 sm:col-span-3">
            <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>
              <X />
              Cancel
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={name.trim() === '' || patch.isPending}
              onClick={() =>
                patch
                  .mutateAsync({ fileId: file.id, body: { display_name: name.trim(), category, description: description.trim() || null } })
                  .then(() => setEditing(false))
                  .catch(() => setError('The file details could not be saved.'))
              }
            >
              <Save />
              Save
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 truncate font-medium text-text" title={file.display_name}>
            {file.display_name}
          </span>
          <Badge tone="outline">v{file.version}</Badge>
          <Badge tone="neutral">{file.category}</Badge>
          <span className="text-2xs text-text-muted" data-numeric="">
            {formatBytes(file.size_bytes)}
          </span>
          <Button type="button" variant="ghost" size="icon" className="size-7" onClick={() => void download(file)} disabled={downloading} aria-label={`Download ${file.display_name} v${String(file.version)}`}>
            <Download className="size-3.5" />
          </Button>
          {canWrite ? (
            <Button type="button" variant="ghost" size="icon" className="size-7" onClick={() => setEditing(true)} aria-label={`Edit details of ${file.display_name}`}>
              <Pencil className="size-3.5" />
            </Button>
          ) : null}
        </div>
      )}
      <p className="text-2xs text-text-subtle">
        {file.description ? `${file.description} · ` : ''}
        {file.uploaded_by_name === null ? 'Uploader withheld (GDPR pending)' : `Uploaded by ${personLabel(file.uploaded_by_name)}`} ·{' '}
        {formatTimestamp(file.created_at)}
      </p>
      {older.length > 0 ? (
        <details className="text-2xs text-text-muted" data-testid={`older-versions-${file.id}`}>
          <summary className="cursor-pointer select-none">
            Older versions ({older.length})
          </summary>
          <ul className="mt-1 space-y-0.5 pl-3">
            {older.map((v) => (
              <li key={v.id} className="flex items-center gap-2">
                <Badge tone="outline">v{v.version}</Badge>
                <span>{formatTimestamp(v.created_at)}</span>
                <span data-numeric="">{formatBytes(v.size_bytes)}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-6"
                  onClick={() => void download(v)}
                  disabled={downloading}
                  aria-label={`Download ${v.display_name} v${String(v.version)}`}
                >
                  <Download className="size-3" />
                </Button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {error ? (
        <p role="alert" className="text-2xs text-danger">
          {error}
        </p>
      ) : null}
    </li>
  );
}

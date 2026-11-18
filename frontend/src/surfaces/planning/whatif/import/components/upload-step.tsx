import * as React from 'react';
import { FileSpreadsheet, Upload } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

import { WhatIfErrorNotice } from '../../components/whatif-error';
import { sha256Hex } from '../file-digest';
import { checkImportFile } from '../import-schema';
import { useImportPlan } from '../import-store';
import { classifyImportError, useImportParse } from '../use-import';
import { ExcelFormatCard } from './excel-format';
import { FeatureCard } from './feature-card';
import { SavedScenariosLibrary } from './saved-scenarios-library';

/** P48 (owner 2026-11-18): the empty copy of the saved-scenario panel on the upload step. */
export const UPLOAD_LIBRARY_EMPTY = 'No saved scenarios yet — import a file, pick projects and Save scenario.';

/** Step 1: choose the workbook and parse it (`POST /whatif/import/parse`). */
export function UploadStep(): React.JSX.Element {
  const setParsed = useImportPlan((s) => s.setParsed);
  const setSource = useImportPlan((s) => s.setSource);
  const browseSaved = useImportPlan((s) => s.browseSaved);
  const closeView = useImportPlan((s) => s.closeView);
  const parse = useImportParse();
  const [file, setFile] = React.useState<File | null>(null);
  const [clientError, setClientError] = React.useState<string | null>(null);
  const [over, setOver] = React.useState(false);
  const inputId = React.useId();
  const hintId = React.useId();

  const choose = (f: File | null | undefined) => {
    parse.reset();
    if (!f) return;
    const err = checkImportFile(f);
    setClientError(err);
    setFile(err ? null : f);
  };

  const submit = () => {
    if (!file) return;
    const digest = sha256Hex(file);
    parse.mutate(file, {
      onSuccess: (data) => {
        setParsed(data);
        const importedAt = new Date().toISOString();
        void digest.then((sha256) => setSource({ file_name: data.file_name, sha256, imported_at: importedAt }));
      },
    });
  };

  return (
    <div className="grid gap-gutter xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]" data-testid="import-upload">
      <FeatureCard
        icon={Upload}
        title="Upload the workbook"
        hint="The capacity-planning .xlsx, read once and never stored"
        bodyClassName="space-y-s4"
        testId="import-upload-card"
      >
        <div
          className={cn(
            'flex flex-col items-center justify-center gap-s2 rounded-lg border-2 border-dashed px-s5 py-s6 text-center transition-colors',
            over ? 'border-primary bg-primary-subtle' : 'border-border-strong bg-surface-sunken/40',
          )}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setOver(false);
            choose(e.dataTransfer.files[0]);
          }}
          data-testid="import-dropzone"
        >
          <FileSpreadsheet className="size-8 text-text-subtle" aria-hidden="true" />
          <p className="text-sm text-text">Drag the .xlsx file here, or</p>
          <label
            htmlFor={inputId}
            className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded border border-border-strong bg-surface px-3 text-sm font-medium text-text hover:bg-surface-raised focus-within:ring-2 focus-within:ring-ring"
          >
            Choose a file
            <input
              id={inputId}
              type="file"
              accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              className="sr-only"
              aria-describedby={hintId}
              onChange={(e) => {
                choose(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
          </label>
          <p id={hintId} className="text-2xs text-text-muted">
            Excel workbook (.xlsx), up to 5 MB. The file is read once and not stored.
          </p>
        </div>

        {file ? (
          <p className="text-sm text-text" data-testid="import-file-name">
            Selected: <span className="font-medium">{file.name}</span>
          </p>
        ) : null}
        {clientError ? (
          <p role="alert" className="text-xs font-medium text-danger-subtle-fg" data-testid="import-file-error">
            {clientError}
          </p>
        ) : null}
        {parse.isError ? (
          <WhatIfErrorNotice
            info={classifyImportError(parse.error, 'parse')}
            errorToken={parse.submittedAt}
            onRetry={submit}
          />
        ) : null}

        <Button type="button" onClick={submit} disabled={!file || parse.isPending}>
          {parse.isPending ? <Spinner className="size-4" /> : <Upload />}
          {parse.isPending ? 'Reading the file…' : 'Parse file'}
        </Button>
      </FeatureCard>

      <ExcelFormatCard />

      {/* P48: earlier imports' saved scenarios, before any file is chosen. Open shows the
          stored result read-only and Compare works on saved scenarios alone; no upload needed. */}
      <div className="min-w-0 xl:col-span-2">
        <SavedScenariosLibrary
          testId="import-upload-library"
          emptyText={UPLOAD_LIBRARY_EMPTY}
          onOpened={() => browseSaved()}
          onShowCompare={() => {
            closeView();
            browseSaved('compare');
          }}
        />
      </div>
    </div>
  );
}

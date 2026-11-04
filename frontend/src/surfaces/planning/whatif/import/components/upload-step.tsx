import * as React from 'react';
import { FileSpreadsheet, Upload } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

import { WhatIfErrorNotice } from '../../components/whatif-error';
import { checkImportFile } from '../import-schema';
import { useImportPlan } from '../import-store';
import { classifyImportError, useImportParse } from '../use-import';
import { FeatureCard } from './feature-card';

const EXPECTED_HEADERS = [
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

/** Step 1: choose the workbook and parse it (`POST /whatif/import/parse`). */
export function UploadStep(): React.JSX.Element {
  const setParsed = useImportPlan((s) => s.setParsed);
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
    parse.mutate(file, { onSuccess: (data) => setParsed(data) });
  };

  return (
    <div className="grid gap-gutter xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]" data-testid="import-upload">
      <FeatureCard
        icon={Upload}
        title="Upload the workbook"
        hint="The capacity-planning .xlsx, read once and never stored"
        bodyClassName="space-y-s4"
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

      <FeatureCard
        icon={FileSpreadsheet}
        title="Expected format"
        hint="Columns found by name, in any order"
        testId="import-format-help"
        bodyClassName="text-xs text-text-muted"
        info={
          <>
            <p>
              One sheet with a header row (in the first 10 rows) that has at least Project description and Status or
              RPD HUB.
            </p>
            <p>
              A Process steps sheet with the PDD-A…PDD-N and OEM-A…OEM-N lead times per category gives the step
              durations. Without it the app&apos;s lead-time table is used.
            </p>
            <p>Customer, CAPEX, tooling, volume and comment columns are ignored and never read.</p>
          </>
        }
      >
        <ul className="flex flex-wrap gap-1.5" aria-label="Columns read">
          {EXPECTED_HEADERS.map((h) => (
            <li key={h} className="rounded-pill border border-border bg-surface-sunken px-2 py-0.5 text-2xs text-text">
              {h}
            </li>
          ))}
        </ul>
        <p>
          Plus a <span className="font-medium text-text">Process steps</span> sheet for the step lead times.
        </p>
      </FeatureCard>
    </div>
  );
}

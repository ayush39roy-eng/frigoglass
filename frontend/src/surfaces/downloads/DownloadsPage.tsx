import * as React from 'react';
import { Download, Loader2, RefreshCw } from 'lucide-react';

import { SURFACES } from '@/app/nav';
import { PageHeader } from '@/components/layout/page-header';
import { EmptyState } from '@/components/shared/empty-state';
import { SectionBoundary } from '@/components/shared/section-boundary';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ApiError } from '@/lib/api/client';
import { saveBlob } from '@/lib/download';
import { formatInteger, formatTimestamp } from '@/lib/format';

import {
  downloadExportJob,
  EXPORT_JOBS_LIMIT,
  useExportJobs,
  type ExportJobKind,
  type ExportJobListItem,
  type ExportJobStatus,
} from './api';

const SURFACE = SURFACES.find((s) => s.path === '/downloads');

const KIND_LABEL: Record<ExportJobKind, string> = {
  dashboard: 'Dashboard',
  capacity: 'RPD Capacity',
  matrix: 'Prioritization Matrix',
  gantt: 'Execution Timeline',
  project_registration: 'Project Registration',
  capacity_planning: 'Capacity Planning',
};

const STATUS_META: Record<ExportJobStatus, { label: string; tone: 'neutral' | 'primary' | 'success' | 'danger' }> = {
  queued: { label: 'Queued', tone: 'neutral' },
  running: { label: 'Preparing', tone: 'primary' },
  completed: { label: 'Ready', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
};

/**
 * P13-T15 Downloads (API_CONTRACT_P13 §7): the caller's recent export jobs
 * (`GET /export-jobs`, own jobs; Admin sees all), each downloadable through the
 * existing `GET /exports/jobs/{id}/download` route once it is ready. Read-only;
 * no figures are computed. Fewer than 100 rows (limit 50), so no virtualization.
 */
export default function DownloadsPage(): React.JSX.Element {
  const jobsQuery = useExportJobs(EXPORT_JOBS_LIMIT);

  return (
    <>
      <PageHeader
        title={SURFACE?.title ?? 'Downloads'}
        description={SURFACE?.summary ?? ''}
        actions={
          <Button
            variant="secondary"
            size="sm"
            onClick={() => void jobsQuery.refetch()}
            disabled={jobsQuery.isFetching}
          >
            <RefreshCw className={jobsQuery.isFetching ? 'animate-spin' : undefined} aria-hidden="true" />
            Refresh
          </Button>
        }
      />
      <SectionBoundary
        query={jobsQuery}
        title="Export jobs"
        errorDescription="Your export jobs could not be loaded."
      >
        {(jobs) => (
          <Card>
            <CardHeader>
              <CardTitle>Export jobs</CardTitle>
              <span className="text-2xs text-text-muted">
                Newest first · the last {EXPORT_JOBS_LIMIT} jobs
              </span>
            </CardHeader>
            <CardContent>
              {jobs.length === 0 ? (
                <EmptyState
                  title="No export jobs yet"
                  description="Large exports prepared in the background appear here with a download link. Quick downloads from a page's Download button save straight away and are not listed."
                />
              ) : (
                <JobsTable jobs={jobs} />
              )}
            </CardContent>
          </Card>
        )}
      </SectionBoundary>
    </>
  );
}

function JobsTable({ jobs }: { jobs: ExportJobListItem[] }): React.JSX.Element {
  return (
    <Table aria-label="Export jobs">
      <TableHeader>
        <TableRow>
          <TableHead>File</TableHead>
          <TableHead>Surface</TableHead>
          <TableHead>Format</TableHead>
          <TableHead>Status</TableHead>
          <TableHead className="text-right">Rows</TableHead>
          <TableHead>Requested</TableHead>
          <TableHead className="text-right">Action</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {jobs.map((job) => (
          <TableRow key={job.id} data-testid="export-job-row">
            <TableCell className="max-w-64 truncate font-medium text-text" title={job.file_name}>
              {job.file_name}
            </TableCell>
            <TableCell>{KIND_LABEL[job.kind]}</TableCell>
            <TableCell className="uppercase">{job.format}</TableCell>
            <TableCell>
              <Badge tone={STATUS_META[job.status].tone}>{STATUS_META[job.status].label}</Badge>
            </TableCell>
            <TableCell className="tnum text-right" data-numeric="">
              {job.row_count === null ? '–' : formatInteger(job.row_count)}
            </TableCell>
            <TableCell className="whitespace-nowrap text-text-muted">{formatTimestamp(job.created_at)}</TableCell>
            <TableCell className="text-right">
              <JobDownload job={job} />
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function JobDownload({ job }: { job: ExportJobListItem }): React.JSX.Element {
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  if (job.status !== 'completed') {
    return <span className="text-2xs text-text-subtle">{job.status === 'failed' ? 'Not available' : 'Not ready yet'}</span>;
  }

  async function handleClick(): Promise<void> {
    setError(null);
    setPending(true);
    try {
      const { blob, filename } = await downloadExportJob(job);
      saveBlob(blob, filename);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 404
          ? 'This export is no longer available.'
          : 'The file could not be downloaded. Please try again.',
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <span className="inline-flex flex-col items-end gap-0.5">
      <Button
        variant="secondary"
        size="sm"
        onClick={() => void handleClick()}
        disabled={pending}
        aria-label={`Download ${job.file_name}`}
      >
        {pending ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Download aria-hidden="true" />}
        Download
      </Button>
      {error ? (
        <span role="alert" className="text-2xs text-danger">
          {error}
        </span>
      ) : null}
    </span>
  );
}

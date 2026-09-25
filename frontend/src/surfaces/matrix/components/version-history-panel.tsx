import * as React from 'react';
import { ArrowLeft, History } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { EmptyState } from '@/components/shared/empty-state';
import { ErrorState } from '@/components/shared/error-state';
import { Skeleton } from '@/components/ui/skeleton';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { ApiError } from '@/lib/api/client';
import { formatInteger, formatTimestamp } from '@/lib/format';

import { DIMENSIONS, type ScenarioApplyChangeDetail, type ScenarioApplyRunSummary } from '../api/types';
import { useScenarioVersionDetail, useScenarioVersions } from '../hooks/use-matrix';

/**
 * Versions & History (P5-T03) — browse/compare historical **scenario-apply**
 * versions.
 *
 * **Scope, read before extending**: this is NOT a general "every schedule
 * run" browser. Today the only mechanism that ever writes a
 * `ScenarioApplyRun`/`ScenarioApplyChange` row is a Matrix scenario Apply
 * (`POST /scenarios/apply`, P5-T02), and that endpoint only accepts
 * `priority_scores` diffs (P5-T02's documented scope). Capacity/Engineer/
 * Chamber edits and full schedule runs have no versioning write path yet —
 * see `docs/MEMORY.md`'s P5-T02/P5-T01/P5-T03 entries. Every string in this
 * file says "scenario" / "priority score", never "schedule run", so this UI
 * doesn't imply more coverage than the backend actually has.
 *
 * Read-only browse + a single version's before/after diff — no revert action
 * (P5-T02 deliberately did not build a revert endpoint; there is nothing for
 * a revert button here to call).
 */

/** `applied_by_user_id` is a raw UUID — there is no `/users/{id}` -> display
 *  name lookup anywhere in this codebase yet (confirmed: the existing Audit
 *  Log read surface shows the same raw `actor_user_id` UUID, no name
 *  resolution). Showing the id verbatim, not inventing a name. */
function AppliedBy({ userId }: { userId: string | null }): React.JSX.Element {
  if (userId === null) return <span className="text-text-subtle">system</span>;
  return (
    <span className="tnum truncate text-text-muted" title={userId}>
      {userId.slice(0, 8)}
    </span>
  );
}

interface ProjectLookupEntry {
  name: string;
  hub: string;
}

/** Raw field-for-field diff lines for one changed `PriorityScore` row — never
 *  a recomputed score/band figure (Invariant I9). `before_state === null`
 *  means a first-time score: every dimension is listed as newly set rather
 *  than "changed", since there was nothing to diff against. */
function priorityScoreDiffEntries(
  change: ScenarioApplyChangeDetail,
): { label: string; from: string; to: string }[] {
  const { before_state: before, after_state: after } = change;
  const entries: { label: string; from: string; to: string }[] = [];

  for (const dim of DIMENSIONS) {
    const afterVal = after[dim.field];
    const beforeVal = before ? before[dim.field] : undefined;
    if (before === null || beforeVal !== afterVal) {
      entries.push({
        label: dim.label,
        from: before === null ? '—' : String(beforeVal ?? '—'),
        to: String(afterVal ?? '—'),
      });
    }
  }

  const beforeGates = Array.isArray(before?.hard_gates) ? (before.hard_gates as unknown[]) : [];
  const afterGates = Array.isArray(after.hard_gates) ? (after.hard_gates as unknown[]) : [];
  const removed = beforeGates.filter((g) => !afterGates.includes(g));
  const added = afterGates.filter((g) => !beforeGates.includes(g));
  if (removed.length > 0 || added.length > 0) {
    entries.push({
      label: 'Hard gates',
      from: beforeGates.length > 0 ? beforeGates.join(', ') : 'none',
      to: afterGates.length > 0 ? afterGates.join(', ') : 'none',
    });
  }

  return entries;
}

export interface VersionHistoryDialogProps {
  /** `project_id -> { name, hub }`, built from the Matrix grid's own
   *  already-fetched rows (`GET /priorities`) purely as a display lookup —
   *  never an independent fetch. A project outside the caller's current
   *  filter/hub scope falls back to showing its raw id. */
  projectLookup: Record<string, ProjectLookupEntry | undefined>;
  /** @default 'secondary' */
  triggerVariant?: 'secondary' | 'ghost';
}

export function VersionHistoryDialog({
  projectLookup,
  triggerVariant = 'secondary',
}: VersionHistoryDialogProps): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const [selectedVersion, setSelectedVersion] = React.useState<number | null>(null);

  const versionsQuery = useScenarioVersions({ enabled: open });
  const detailQuery = useScenarioVersionDetail(open ? selectedVersion : null);

  function handleOpenChange(next: boolean): void {
    setOpen(next);
    if (!next) setSelectedVersion(null);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant={triggerVariant} size="sm">
          <History />
          Version history
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          {selectedVersion === null ? (
            <>
              <DialogTitle>Scenario version history</DialogTitle>
              <DialogDescription>
                Applied prioritization-score scenarios, most recent first. This lists scenario
                Apply actions only — not every schedule run; capacity, engineer, and project
                edits are not yet versioned here.
              </DialogDescription>
            </>
          ) : (
            <>
              <div>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelectedVersion(null)}
                  className="mb-1 -ml-2"
                >
                  <ArrowLeft />
                  All versions
                </Button>
              </div>
              <DialogTitle>Version {selectedVersion}</DialogTitle>
              <DialogDescription>
                Before → after for every changed project in this version.
              </DialogDescription>
            </>
          )}
        </DialogHeader>

        <div className="max-h-[65vh] overflow-y-auto">
          {selectedVersion === null ? (
            <VersionList query={versionsQuery} onSelect={setSelectedVersion} />
          ) : (
            <VersionDetail query={detailQuery} projectLookup={projectLookup} />
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

function VersionList({
  query,
  onSelect,
}: {
  query: ReturnType<typeof useScenarioVersions>;
  onSelect: (version: number) => void;
}): React.JSX.Element {
  if (query.isPending) {
    return (
      <div className="space-y-2" aria-busy="true">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-5/6" />
        <Skeleton className="h-8 w-4/6" />
      </div>
    );
  }

  if (query.isError) {
    return (
      <ErrorState
        description="The scenario version history could not be loaded."
        onRetry={() => void query.refetch()}
      />
    );
  }

  const runs = query.data;
  if (runs.length === 0) {
    return (
      <EmptyState
        title="No scenarios applied yet"
        description="Once a Matrix scenario is applied, it will appear here as a browsable version."
      />
    );
  }

  return (
    <Table data-testid="version-history-table">
      <TableHeader>
        <TableRow>
          <TableHead>Version</TableHead>
          <TableHead>Applied</TableHead>
          <TableHead>Applied by</TableHead>
          <TableHead>Notes</TableHead>
          <TableHead className="text-right">Changes</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {runs.map((run: ScenarioApplyRunSummary) => (
          <TableRow key={run.id} data-testid="version-history-row">
            <TableCell className="tnum font-medium text-text" data-numeric="">
              {`v${String(run.version)}`}
            </TableCell>
            <TableCell className="text-text-muted">{formatTimestamp(run.created_at)}</TableCell>
            <TableCell>
              <AppliedBy userId={run.applied_by_user_id} />
            </TableCell>
            <TableCell className="max-w-[200px] truncate text-text-muted" title={run.notes ?? ''}>
              {run.notes && run.notes.trim() !== '' ? run.notes : <span className="text-text-subtle">—</span>}
            </TableCell>
            <TableCell className="tnum text-right" data-numeric="">
              {formatInteger(run.change_count)}
            </TableCell>
            <TableCell className="text-right">
              <Button variant="ghost" size="sm" onClick={() => onSelect(run.version)}>
                View diff
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function VersionDetail({
  query,
  projectLookup,
}: {
  query: ReturnType<typeof useScenarioVersionDetail>;
  projectLookup: Record<string, ProjectLookupEntry | undefined>;
}): React.JSX.Element {
  if (query.isPending) {
    return (
      <div className="space-y-2" aria-busy="true">
        <Skeleton className="h-8 w-full" />
        <Skeleton className="h-8 w-5/6" />
      </div>
    );
  }

  if (query.isError) {
    const notFound = query.error instanceof ApiError && query.error.status === 404;
    return notFound ? (
      <ErrorState
        title="Version not available"
        description="This version does not exist, or none of its changes are within your hub scope."
      />
    ) : (
      <ErrorState
        description="This version could not be loaded."
        onRetry={() => void query.refetch()}
      />
    );
  }

  const run = query.data;

  return (
    <div className="space-y-3" data-testid="version-detail">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-2xs text-text-muted sm:grid-cols-4">
        <div>
          <dt className="font-medium text-text-subtle">Applied</dt>
          <dd className="text-text">{formatTimestamp(run.created_at)}</dd>
        </div>
        <div>
          <dt className="font-medium text-text-subtle">Applied by</dt>
          <dd>
            <AppliedBy userId={run.applied_by_user_id} />
          </dd>
        </div>
        <div className="col-span-2">
          <dt className="font-medium text-text-subtle">Notes</dt>
          <dd className="text-text">{run.notes && run.notes.trim() !== '' ? run.notes : '—'}</dd>
        </div>
      </dl>

      {run.changes.length === 0 ? (
        <EmptyState
          title="No changes visible in your hub scope"
          description="This version touched projects outside the hubs you can see."
        />
      ) : (
        <ul className="space-y-2">
          {run.changes.map((change) => {
            const project = change.project_id ? projectLookup[change.project_id] : undefined;
            const entries = priorityScoreDiffEntries(change);
            return (
              <li
                key={change.id}
                className="rounded-lg border border-border bg-surface-raised px-3 py-2 text-xs"
                data-testid="version-detail-change"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium text-text">
                    {project ? (
                      <>
                        {project.name} <span className="font-normal text-text-muted">· {project.hub}</span>
                      </>
                    ) : (
                      <span className="tnum" title={change.project_id ?? change.entity_id}>
                        {change.project_id ?? change.entity_id}
                      </span>
                    )}
                  </span>
                  <div className="flex items-center gap-2">
                    {change.before_state === null ? <Badge tone="warning">New score</Badge> : null}
                    <Badge tone="outline">{change.entity_type}</Badge>
                  </div>
                </div>
                {entries.length > 0 ? (
                  <ul className="mt-1.5 space-y-0.5 text-2xs text-text-muted">
                    {entries.map((entry) => (
                      <li key={entry.label}>
                        {entry.label}: <span className="tnum">{entry.from}</span> →{' '}
                        <span className="tnum font-medium text-text">{entry.to}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

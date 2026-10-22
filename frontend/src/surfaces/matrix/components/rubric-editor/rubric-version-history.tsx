import * as React from 'react';
import { ChevronDown } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorState } from '@/components/shared/error-state';
import { formatTimestamp } from '@/lib/format';
import { cn } from '@/lib/utils';

import type { ScoringRubric } from '../../api/types';
import { useScoringRubricVersions } from '../../hooks/use-matrix';
import { diffSnapshots } from '../../lib/rubric-draft';

/**
 * P26: the rubric's versions (`GET /scoring-rubric/versions`, newest first):
 * who, when, why and the served total weight, and per version the dimension
 * snapshot diff against the version before it. Read-only for everyone.
 */
export function RubricVersionHistory({ enabled }: { enabled: boolean }): React.JSX.Element {
  const query = useScoringRubricVersions(enabled);
  const [openVersion, setOpenVersion] = React.useState<number | null>(null);

  if (query.isPending) {
    return (
      <div className="space-y-2" aria-busy="true" aria-label="Loading rubric versions">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-5/6" />
      </div>
    );
  }
  if (query.isError) {
    return <ErrorState description="The rubric versions could not be loaded." onRetry={() => void query.refetch()} />;
  }
  const versions = query.data.versions;
  return (
    <ol className="space-y-2" aria-label="Rubric versions, newest first" data-testid="rubric-versions">
      {versions.map((v, i) => {
        const prev: ScoringRubric | undefined = versions[i + 1];
        const isOpen = openVersion === v.version;
        const detailId = `rubric-version-${String(v.version)}-changes`;
        const active = v.dimensions.filter((d) => d.active).length;
        return (
          <li key={v.version} className="rounded-lg border border-border bg-surface-raised px-3 py-2 text-xs" data-testid="rubric-version">
            <div className="flex flex-wrap items-start justify-between gap-2">
              <div className="min-w-0 space-y-0.5">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="tnum font-semibold text-text">Version {v.version}</span>
                  {i === 0 ? <Badge tone="primary">Current</Badge> : null}
                  <span className="text-text-muted">{formatTimestamp(v.changed_at)}</span>
                  <span className="text-text-muted">· {v.changed_by_name ?? 'system (migration)'}</span>
                </p>
                <p className="text-text">{v.reason}</p>
                <p className="tnum text-2xs text-text-muted" data-numeric="">
                  Total weight {v.total_weight}
                  {prev && prev.total_weight !== v.total_weight ? ` (was ${String(prev.total_weight)})` : ''} · {active} active of{' '}
                  {v.dimensions.length} dimensions
                </p>
              </div>
              <Button
                variant="ghost"
                size="sm"
                aria-expanded={isOpen}
                aria-controls={detailId}
                onClick={() => setOpenVersion(isOpen ? null : v.version)}
              >
                {isOpen ? 'Hide changes' : 'Show changes'}
                <ChevronDown className={cn('transition-transform motion-reduce:transition-none', isOpen && 'rotate-180')} aria-hidden="true" />
              </Button>
            </div>
            {isOpen ? <VersionChanges id={detailId} prev={prev} next={v} /> : null}
          </li>
        );
      })}
    </ol>
  );
}

function VersionChanges({ id, prev, next }: { id: string; prev: ScoringRubric | undefined; next: ScoringRubric }): React.JSX.Element {
  const changes = diffSnapshots(prev, next);
  return (
    <div id={id} className="mt-2 border-t border-border pt-2" data-testid="rubric-version-changes">
      <p className="mb-1 text-2xs text-text-muted">
        {prev ? `Compared with version ${String(prev.version)}.` : 'The first version: every dimension it started with.'}
      </p>
      {changes.length === 0 ? (
        <p className="text-2xs text-text-muted">No dimension changed.</p>
      ) : (
        <ul className="space-y-1">
          {changes.map((c) => (
            <li key={c.key} data-testid="rubric-version-change">
              <span className="font-medium text-text">{c.label}</span>{' '}
              {c.kind === 'added' ? <Badge tone="success">added</Badge> : null}
              <ul className="ml-3 text-2xs text-text-muted">
                {c.changes.map((ch) => (
                  <li key={ch.field}>
                    {ch.field}: <span className="tnum">{ch.from}</span> → <span className="tnum font-medium text-text">{ch.to}</span>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

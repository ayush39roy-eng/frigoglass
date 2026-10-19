import * as React from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { GitCommitVertical } from 'lucide-react';

import { SURFACES } from '@/app/nav';
import { PageHeader } from '@/components/layout/page-header';
import { ChangedProjectsList } from '@/components/shared/priority-move/timeline-updated-panel';
import { EmptyState } from '@/components/shared/empty-state';
import { ErrorState } from '@/components/shared/error-state';
import { SectionBoundary } from '@/components/shared/section-boundary';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { formatTimestamp } from '@/lib/format';
import { cn } from '@/lib/utils';
import { usePermission } from '@/stores/session';
import { ScenarioVersionsPanel } from '@/surfaces/matrix/components/version-history-panel';
import type { ScheduleRunStatus } from '@/types/enums';

import {
  baselineFor,
  useProjectNameLookup,
  useRunChanges,
  useScheduleRuns,
  type ScheduleRunListItem,
} from './api';

const SURFACE = SURFACES.find((s) => s.path === '/history');
/** CLAUDE.md: virtualize any list over 100 rows. */
const VIRTUALIZE_OVER = 100;
const RUN_ROW_HEIGHT = 64;

const STATUS_META: Record<ScheduleRunStatus, { label: string; tone: 'neutral' | 'primary' | 'success' | 'danger' | 'warning' }> = {
  queued: { label: 'Queued', tone: 'neutral' },
  running: { label: 'Running', tone: 'primary' },
  completed: { label: 'Completed', tone: 'success' },
  failed: { label: 'Failed', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'warning' },
};

const TRIGGER_LABEL: Record<string, string> = {
  priority_move: 'Priority move',
  step_timing: 'Step timing change',
  check_in: 'Weekly check-in',
  follow_up: 'Follow-up run',
};

function triggerLabel(reason: string | null): string {
  if (reason === null || reason.trim() === '') return 'Manual recalculation';
  const known = TRIGGER_LABEL[reason];
  if (known) return known;
  const spaced = reason.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * P13-T15 Versions & History (API_CONTRACT_P13 §7), read-only:
 * - every schedule run (`GET /schedule-runs`) and, for a selected completed
 *   run, the served list of projects that moved against the run before it
 *   (`GET /schedule-runs/{id}/changes?against=`);
 * - every applied prioritization scenario version (`GET /scenarios/versions`).
 * Nothing is computed here: the change rows, deltas and flags are the server's.
 */
export default function HistoryPage(): React.JSX.Element {
  const canReadNames = usePermission('dashboard').read;
  const [tab, setTab] = React.useState<'runs' | 'scenarios'>('runs');
  const names = useProjectNameLookup(canReadNames && tab === 'scenarios');

  return (
    <>
      <PageHeader title={SURFACE?.title ?? 'Versions & History'} description={SURFACE?.summary ?? ''} />
      <Tabs value={tab} onValueChange={(v) => setTab(v === 'scenarios' ? 'scenarios' : 'runs')}>
        <TabsList aria-label="History type">
          <TabsTrigger value="runs">Schedule runs</TabsTrigger>
          <TabsTrigger value="scenarios">Scenario versions</TabsTrigger>
        </TabsList>
        <TabsContent value="runs" className="mt-4">
          <ScheduleRunsSection />
        </TabsContent>
        <TabsContent value="scenarios" className="mt-4">
          <Card>
            <CardHeader>
              <CardTitle>Scenario versions</CardTitle>
              <span className="text-2xs text-text-muted">
                Applied prioritization-score scenarios from the Matrix, most recent first.
              </span>
            </CardHeader>
            <CardContent>
              <ScenarioVersionsPanel projectLookup={names.data ?? {}} />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>
    </>
  );
}

function ScheduleRunsSection(): React.JSX.Element {
  const runsQuery = useScheduleRuns();
  const [selectedId, setSelectedId] = React.useState<string | null>(null);

  return (
    <SectionBoundary
      query={runsQuery}
      title="Schedule runs"
      errorDescription="The schedule run history could not be loaded."
    >
      {(runs) => {
        if (runs.length === 0) {
          return (
            <EmptyState
              title="No schedule runs yet"
              description="Each recalculation of the schedule is kept as a numbered version and listed here."
            />
          );
        }
        const selected = runs.find((r) => r.id === selectedId) ?? runs[0] ?? null;
        return (
          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
            <Card>
              <CardHeader>
                <CardTitle>Schedule runs</CardTitle>
                <span className="text-2xs text-text-muted">{runs.length} versions · newest first</span>
              </CardHeader>
              <CardContent>
                <RunList runs={runs} selectedId={selected?.id ?? null} onSelect={setSelectedId} />
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>{selected ? `Run v${String(selected.version)} — what changed` : 'What changed'}</CardTitle>
              </CardHeader>
              <CardContent>
                {selected ? <RunChanges run={selected} baseline={baselineFor(runs, selected.id)} /> : null}
              </CardContent>
            </Card>
          </div>
        );
      }}
    </SectionBoundary>
  );
}

function RunList({
  runs,
  selectedId,
  onSelect,
}: {
  runs: ScheduleRunListItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}): React.JSX.Element {
  if (runs.length > VIRTUALIZE_OVER) {
    return <VirtualRunList runs={runs} selectedId={selectedId} onSelect={onSelect} />;
  }
  return (
    <ul aria-label="Schedule runs" className="max-h-[32rem] space-y-1 overflow-y-auto pr-1" data-virtualized="false">
      {runs.map((run) => (
        <li key={run.id}>
          <RunItem run={run} selected={run.id === selectedId} onSelect={onSelect} />
        </li>
      ))}
    </ul>
  );
}

function VirtualRunList({
  runs,
  selectedId,
  onSelect,
}: {
  runs: ScheduleRunListItem[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}): React.JSX.Element {
  const scrollRef = React.useRef<HTMLDivElement>(null);
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual is the mandated virtualizer (see eslint.config.js).
  const virtualizer = useVirtualizer({
    count: runs.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => RUN_ROW_HEIGHT,
    overscan: 8,
  });
  return (
    <div ref={scrollRef} className="max-h-[32rem] overflow-y-auto pr-1" data-virtualized="true">
      <ul aria-label="Schedule runs" style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((item) => {
          const run = runs[item.index];
          if (!run) return null;
          return (
            <li
              key={run.id}
              className="absolute left-0 top-0 w-full pb-1"
              style={{ transform: `translateY(${String(item.start)}px)`, height: RUN_ROW_HEIGHT }}
            >
              <RunItem run={run} selected={run.id === selectedId} onSelect={onSelect} />
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function RunItem({
  run,
  selected,
  onSelect,
}: {
  run: ScheduleRunListItem;
  selected: boolean;
  onSelect: (id: string) => void;
}): React.JSX.Element {
  const status = STATUS_META[run.status];
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={() => onSelect(run.id)}
      data-testid="schedule-run-item"
      className={cn(
        'flex w-full items-start gap-3 rounded-md border px-3 py-2 text-left transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        selected ? 'border-primary bg-primary-subtle/50' : 'border-border hover:bg-surface-sunken',
      )}
    >
      <GitCommitVertical className="mt-0.5 size-4 shrink-0 text-text-subtle" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="tnum text-sm font-bold text-text">v{run.version}</span>
          <Badge tone={status.tone}>{status.label}</Badge>
          {run.is_active ? <Badge tone="primary">Active</Badge> : null}
          <span className="text-2xs text-text-muted">{run.solver_type === 'cp_sat' ? 'CP-SAT' : 'Greedy'}</span>
        </span>
        <span className="mt-0.5 block truncate text-2xs text-text-muted">
          {triggerLabel(run.trigger_reason)} · week {run.current_week} · {formatTimestamp(run.created_at)}
        </span>
      </span>
    </button>
  );
}

function RunChanges({
  run,
  baseline,
}: {
  run: ScheduleRunListItem;
  baseline: ScheduleRunListItem | null;
}): React.JSX.Element {
  const ready = run.status === 'completed' && baseline !== null;
  const changes = useRunChanges(ready ? run.id : null, ready ? (baseline?.id ?? null) : null);

  if (run.status !== 'completed') {
    return (
      <p className="text-xs text-text-muted" data-testid="run-changes-unavailable">
        This run is {STATUS_META[run.status].label.toLowerCase()}; its changes are listed once it has completed.
      </p>
    );
  }
  if (baseline === null) {
    return (
      <p className="text-xs text-text-muted" data-testid="run-changes-first">
        This is the earliest completed run — there is no earlier run to compare it with.
      </p>
    );
  }
  if (changes.isPending) {
    return (
      <div className="space-y-2" aria-busy="true">
        <Skeleton className="h-6 w-1/2" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  }
  if (changes.isError) {
    return (
      <ErrorState
        description="The change list for this run could not be loaded."
        onRetry={() => void changes.refetch()}
      />
    );
  }
  return <ChangedProjectsList changes={changes.data} />;
}

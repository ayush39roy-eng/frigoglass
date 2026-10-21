import * as React from 'react';
import { Calculator, FlaskConical, Sparkles } from 'lucide-react';
import type { UseMutationResult } from '@tanstack/react-query';

import { EmptyState } from '@/components/shared/empty-state';
import { RunProgressStatus } from '@/components/shared/run-progress-status';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import type { RunFollowState } from '@/lib/use-schedule-run-follow';

import type { ChamberRead } from '../../api/types';
import type {
  ChatScenario,
  EstimateRequest,
  EstimateResponse,
  SimulateRequest,
  SimulateResponse,
  SolveRequest,
  SolveResponse,
  WhatIfTarget,
} from '../../api/whatif-types';
import { buildScenarioRequest, parseDesignerFte } from '../scenario-schema';
import { useWhatIfScenario } from '../scenario-store';
import { classifyWhatIfError, useEstimate, useSimulate, useSolve } from '../use-whatif';
import { ChatPanel } from './chat-panel';
import { EstimateView } from './estimate-view';
import { NativeSelect } from './form-controls';
import { ScenarioBuilder } from './scenario-builder';
import { SimulateView } from './simulate-view';
import { SolveView } from './solve-view';
import { WhatIfErrorNotice } from './whatif-error';

type ResultKind = 'estimate' | 'simulate' | 'solve';

const TARGET_LABEL: Record<WhatIfTarget, string> = {
  all_new_within_year: 'Every new project that capacity can help finishes in the year',
  no_existing_slips: 'No existing project slips out of the year',
};

function ResultPane<T, V>({
  mutation,
  current,
  idleTitle,
  idleDescription,
  progressMessage,
  onRetry,
  render,
}: {
  mutation: UseMutationResult<T, Error, V>;
  /** The request the form would send now; null when it cannot be sent. */
  current: V | null;
  idleTitle: string;
  idleDescription: string;
  progressMessage: string;
  onRetry: () => void;
  render: (data: T) => React.ReactNode;
}): React.JSX.Element {
  if (mutation.isPending) {
    const state: RunFollowState = { phase: 'running', percent: null, message: progressMessage };
    return (
      <div className="space-y-s3" aria-busy="true">
        <RunProgressStatus state={state} />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-32 w-full" />
      </div>
    );
  }
  if (mutation.isError) {
    return (
      <WhatIfErrorNotice
        info={classifyWhatIfError(mutation.error, 'scenario')}
        errorToken={mutation.submittedAt}
        onRetry={onRetry}
      />
    );
  }
  if (mutation.isSuccess) {
    const stale = current === null || JSON.stringify(mutation.variables) !== JSON.stringify(current);
    return (
      <div className="space-y-s3">
        {stale ? (
          <p
            role="status"
            className="rounded-md border border-border-strong bg-surface-sunken px-s3 py-s2 text-xs text-text-muted"
            data-testid="whatif-stale"
          >
            The scenario has changed since this result was calculated. Run it again to update.
          </p>
        ) : null}
        {render(mutation.data)}
      </div>
    );
  }
  return <EmptyState media={<FlaskConical />} title={idleTitle} description={idleDescription} />;
}

export interface WhatIfPlannerProps {
  /** Server-scoped chamber list (the existing Chambers query). */
  chambers: ChamberRead[];
}

/**
 * The What-if planner: scenario form, three result views (estimate, simulate,
 * fewest additions) and the "Ask the planner" chat. Scenario state is in
 * Zustand; results are the API's responses, shown as served (I9/I19); hub scope
 * is whatever the server returned (never re-scoped here).
 */
export function WhatIfPlanner({ chambers }: WhatIfPlannerProps): React.JSX.Element {
  const lines = useWhatIfScenario();
  const validation = React.useMemo(
    () =>
      buildScenarioRequest({
        projects: lines.projects,
        engineers: lines.engineers,
        removals: lines.removals,
        chambers: lines.chambers,
        downtime: lines.downtime,
      }),
    [lines.projects, lines.engineers, lines.removals, lines.chambers, lines.downtime],
  );
  const fte = parseDesignerFte(lines.designerFte);

  const estimate = useEstimate();
  const simulate = useSimulate();
  const solve = useSolve();
  const [tab, setTab] = React.useState<ResultKind>('estimate');
  const [loadedNotice, setLoadedNotice] = React.useState(false);
  const builderRef = React.useRef<HTMLDivElement>(null);

  const scenario = validation.request;
  const estimateBody: EstimateRequest | null =
    scenario && fte.value !== undefined ? { scenario, basis: lines.basis, designer_fte: fte.value } : null;
  const simulateBody: SimulateRequest | null = scenario ? { scenario } : null;
  const solveBody: SolveRequest | null =
    scenario && fte.value !== undefined ? { scenario, target: lines.target, designer_fte: fte.value } : null;

  const busy = estimate.isPending || simulate.isPending || solve.isPending;
  const noChanges = validation.empty;

  const run = (kind: ResultKind): void => {
    setTab(kind);
    if (kind === 'estimate' && estimateBody) estimate.mutate(estimateBody);
    if (kind === 'simulate' && simulateBody) simulate.mutate(simulateBody);
    if (kind === 'solve' && solveBody) solve.mutate(solveBody);
  };

  const editInBuilder = (s: ChatScenario): void => {
    lines.loadChatScenario(s);
    setLoadedNotice(true);
    builderRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const reasonDisabled = noChanges
    ? 'Add at least one change to run the scenario.'
    : scenario === null
      ? 'Fix the highlighted fields to run the scenario.'
      : fte.error
        ? `Designer FTE: ${fte.error}.`
        : null;

  return (
    <div className="space-y-s5" data-testid="whatif-planner">
      <p className="max-w-prose text-sm text-text-muted">
        Try a change without touching the plan: add projects, designers or chambers, or take a chamber down. Nothing here
        is saved or applied. Every figure is calculated by the server with the same rules as the real schedule.
      </p>
      {loadedNotice ? (
        <p
          role="status"
          className="rounded-md border border-primary/30 bg-primary-subtle px-s3 py-s2 text-xs text-primary-subtle-fg"
          data-testid="whatif-loaded-notice"
        >
          The assistant&apos;s scenario is now in the builder. Review it, then run it.
        </p>
      ) : null}

      <div className="grid gap-gutter 2xl:grid-cols-2">
        <div ref={builderRef} className="min-w-0 scroll-mt-s6">
          <ScenarioBuilder validation={validation} chambers={chambers} />
        </div>

        <Card className="min-w-0" data-testid="whatif-results">
          <CardHeader>
            <CardTitle>Results</CardTitle>
          </CardHeader>
          <CardContent className="space-y-s4">
            <div className="space-y-s2">
              <div className="flex flex-wrap items-end gap-s2">
                <Button type="button" size="sm" disabled={busy || reasonDisabled !== null} onClick={() => run('estimate')}>
                  <Calculator />
                  Estimate
                </Button>
                <Button type="button" size="sm" disabled={busy || reasonDisabled !== null} onClick={() => run('simulate')}>
                  <FlaskConical />
                  Simulate
                </Button>
                <Button type="button" size="sm" disabled={busy || reasonDisabled !== null} onClick={() => run('solve')}>
                  <Sparkles />
                  Find fewest additions
                </Button>
              </div>
              <div className="flex max-w-md flex-col gap-1">
                <label htmlFor="whatif-target" className="text-2xs text-text-muted">
                  Goal for &quot;fewest additions&quot;
                </label>
                <NativeSelect
                  id="whatif-target"
                  value={lines.target}
                  onChange={(e) => lines.setTarget(e.target.value as WhatIfTarget)}
                >
                  {(Object.keys(TARGET_LABEL) as WhatIfTarget[]).map((t) => (
                    <option key={t} value={t}>
                      {TARGET_LABEL[t]}
                    </option>
                  ))}
                </NativeSelect>
              </div>
              {reasonDisabled ? (
                <p className="text-2xs text-text-muted" data-testid="whatif-run-hint">
                  {reasonDisabled}
                </p>
              ) : null}
            </div>

            <Tabs value={tab} onValueChange={(v) => setTab(v as ResultKind)}>
              <TabsList>
                <TabsTrigger value="estimate">Estimate</TabsTrigger>
                <TabsTrigger value="simulate">Simulate</TabsTrigger>
                <TabsTrigger value="solve">Fewest additions</TabsTrigger>
              </TabsList>
              <TabsContent value="estimate">
                <ResultPane<EstimateResponse, EstimateRequest>
                  mutation={estimate}
                  current={estimateBody}
                  idleTitle="No estimate yet"
                  idleDescription="Run Estimate for a quick view of the extra design and lab weeks and how many designers and chambers the change needs."
                  progressMessage="Estimating the extra load…"
                  onRetry={() => run('estimate')}
                  render={(d) => <EstimateView data={d} />}
                />
              </TabsContent>
              <TabsContent value="simulate">
                <ResultPane<SimulateResponse, SimulateRequest>
                  mutation={simulate}
                  current={simulateBody}
                  idleTitle="No simulation yet"
                  idleDescription="Run Simulate to see which projects slip or recover when the real scheduler runs on your change."
                  progressMessage="Running the scheduler on your scenario…"
                  onRetry={() => run('simulate')}
                  render={(d) => <SimulateView data={d} />}
                />
              </TabsContent>
              <TabsContent value="solve">
                <ResultPane<SolveResponse, SolveRequest>
                  mutation={solve}
                  current={solveBody}
                  idleTitle="No recommendation yet"
                  idleDescription="Run Find fewest additions to see the smallest set of designers and chambers that gets everything done."
                  progressMessage="Searching for the fewest additions…"
                  onRetry={() => run('solve')}
                  render={(d) => <SolveView data={d} />}
                />
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      </div>

      <ChatPanel onEditInBuilder={editInBuilder} />
    </div>
  );
}

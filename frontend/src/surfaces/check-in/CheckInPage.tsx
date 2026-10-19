import * as React from 'react';
import { Link } from 'react-router-dom';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Info, Send, TriangleAlert } from 'lucide-react';

import { SURFACES } from '@/app/nav';
import { PageHeader } from '@/components/layout/page-header';
import { EmptyState } from '@/components/shared/empty-state';
import { ErrorState } from '@/components/shared/error-state';
import { TrackingStatusChip } from '@/components/shared/tracking-status-chip';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { CHECKIN_BATCH_MAX, type CheckInDueProject, type CheckInDueSummary } from '@/lib/api/check-ins';
import { formatInteger, formatWeek } from '@/lib/format';
import { useHubFilter } from '@/stores/hub-filter';
import { CountrySegmented } from '@/components/shared/hub-filter/country-segmented';
import { HubFilterChip } from '@/components/shared/hub-filter/hub-filter-chip';

import { useCheckInsDue } from './api';
import { CheckInResultPanel } from './components/check-in-result-panel';
import { StageCheckInRow } from './components/stage-check-in-row';
import { useCheckInSubmit } from './hooks/use-check-in-submit';
import { initialDraft, planBatch, stageKey, type CheckInDraft, type CheckInErrors } from './lib/check-in-draft';

const SURFACE = SURFACES.find((s) => s.path === '/check-in');
/** Above this many project groups the list is virtualized (CLAUDE.md: any list over 100). */
const VIRTUALIZE_OVER = 100;
const NO_ERRORS: CheckInErrors = {};

/** Copy for a per-entry code when the server sent no message. */
const ENTRY_CODE_COPY: Record<string, string> = {
  NOT_DUE: 'This stage is no longer due this week.',
  FORBIDDEN_STAGE: 'You cannot check in this stage.',
  STEP_DONE_IMMUTABLE: 'This stage is already Done and cannot be reported again.',
  INCONSISTENT_PROGRESS: 'The status and % complete do not agree.',
  PROJECT_FROZEN: 'This project is frozen, so its progress cannot change.',
  DUPLICATE_STAGE: 'This stage appears twice in the batch.',
};

function Figure({ label, value, testId }: { label: string; value: number; testId: string }): React.JSX.Element {
  return (
    <div className="flex flex-col">
      <dt className="text-2xs text-text-muted">{label}</dt>
      <dd className="font-display text-lg font-bold tabular-nums text-text" data-numeric="" data-testid={testId}>
        {formatInteger(value)}
      </dd>
    </div>
  );
}

/** Served counts only (ADR 0021 §7: per project and per stage, never per engineer). */
function SummaryStrip({ week, summary }: { week: number; summary: CheckInDueSummary }): React.JSX.Element {
  return (
    <section aria-label="This week's check-in summary" className="mb-s4 rounded-dash border-[1.5px] border-dash-hairline bg-surface p-4 shadow-dashCard">
      <dl className="flex flex-wrap items-end gap-x-8 gap-y-3">
        <div className="flex flex-col">
          <dt className="text-2xs text-text-muted">Week</dt>
          <dd className="font-display text-lg font-bold tabular-nums text-text" data-numeric="" data-testid="check-in-week">
            {formatWeek(week)}
          </dd>
        </div>
        <Figure label="Stages due" value={summary.due_stages} testId="summary-due-stages" />
        <Figure label="Checked in" value={summary.checked_in_stages} testId="summary-checked-in" />
        <Figure label="Projects live" value={summary.projects_live} testId="summary-live" />
        <Figure label="Projects due" value={summary.projects_due} testId="summary-due" />
        <Figure label="Projects overdue" value={summary.projects_overdue} testId="summary-overdue" />
      </dl>
    </section>
  );
}

interface GroupProps {
  project: CheckInDueProject;
  drafts: Readonly<Record<string, CheckInDraft>>;
  errors: Readonly<Record<string, CheckInErrors>>;
  serverErrors: Readonly<Record<string, string>>;
  disabled: boolean;
  onChange: (key: string, next: CheckInDraft) => void;
}

const ProjectGroup = React.memo(function ProjectGroup({ project, drafts, errors, serverErrors, disabled, onChange }: GroupProps): React.JSX.Element {
  const headingId = React.useId();
  return (
    <section
      aria-labelledby={headingId}
      className="rounded-dash border-[1.5px] border-dash-hairline bg-surface px-4 py-3 shadow-dashCard"
      data-testid="check-in-project"
      data-project-id={project.project_id}
    >
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 id={headingId} className="text-sm font-bold text-text">
          <Link
            to={`/projects/${project.project_id}`}
            className="rounded-sm underline-offset-2 hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            {project.name}
          </Link>
        </h3>
        <span className="text-2xs text-text-muted">{project.hub}</span>
        <TrackingStatusChip status={project.tracking_status} />
      </header>
      <div className="mt-1">
        {project.stages.map((stage) => {
          const key = stageKey(project.project_id, stage.step_id);
          return (
            <StageCheckInRow
              key={key}
              projectId={project.project_id}
              projectName={project.name}
              stage={stage}
              draft={drafts[key] ?? initialDraft(stage)}
              errors={errors[key] ?? NO_ERRORS}
              serverError={serverErrors[key] ?? null}
              disabled={disabled}
              onChange={(next) => onChange(key, next)}
            />
          );
        })}
      </div>
    </section>
  );
});

function VirtualGroups({ projects, props }: { projects: CheckInDueProject[]; props: Omit<GroupProps, 'project'> }): React.JSX.Element {
  const scrollRef = React.useRef<HTMLDivElement>(null);
  // eslint-disable-next-line react-hooks/incompatible-library -- TanStack Virtual is the mandated virtualizer (see eslint.config.js).
  const virtualizer = useVirtualizer({
    count: projects.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 220,
    getItemKey: (index) => projects[index]?.project_id ?? index,
    overscan: 4,
  });
  return (
    <div ref={scrollRef} className="max-h-[calc(100vh-18rem)] overflow-y-auto pr-1" data-virtualized="true">
      <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
        {virtualizer.getVirtualItems().map((v) => {
          const project = projects[v.index];
          if (!project) return null;
          return (
            <div
              key={project.project_id}
              data-index={v.index}
              ref={virtualizer.measureElement}
              style={{ position: 'absolute', top: 0, left: 0, right: 0, transform: `translateY(${String(v.start)}px)`, paddingBottom: 12 }}
            >
              <ProjectGroup project={project} {...props} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * `/check-in` (ADR 0021, ADR 0023, P12-T05): the stages due this week from
 * `GET /check-ins/due`. For each stage the user can report status, % complete,
 * a hold reason (required when On Hold) and a note, or confirm it unchanged,
 * and submit the whole week as one batch (`POST /check-ins`). The server
 * decides which stages are due, who may check in (`can_check_in`), the
 * tracking status and the "per plan" %, and recalculates the timeline.
 */
export default function CheckInPage(): React.JSX.Element {
  const { hubId, region } = useHubFilter();
  const query = useCheckInsDue(hubId, true, region);
  const submitFlow = useCheckInSubmit();
  const [drafts, setDrafts] = React.useState<Record<string, CheckInDraft>>({});
  const [showErrors, setShowErrors] = React.useState(false);
  const [serverErrors, setServerErrors] = React.useState<Record<string, string>>({});
  const [formError, setFormError] = React.useState<string | null>(null);

  const projects = React.useMemo(() => query.data?.projects ?? [], [query.data]);
  const plan = React.useMemo(() => planBatch(projects, drafts), [projects, drafts]);
  const anyWritable = projects.some((p) => p.stages.some((s) => s.can_check_in));
  const invalidCount = Object.keys(plan.errors).length;

  const onChange = React.useCallback((key: string, next: CheckInDraft) => {
    setDrafts((cur) => ({ ...cur, [key]: next }));
    setServerErrors((cur) => {
      if (!(key in cur)) return cur;
      const copy = { ...cur };
      delete copy[key];
      return copy;
    });
  }, []);

  const onSubmit = async (): Promise<void> => {
    setFormError(null);
    setShowErrors(true);
    if (plan.entries.length === 0 || invalidCount > 0 || plan.entries.length > CHECKIN_BATCH_MAX) return;
    const keys = plan.keys;
    const result = await submitFlow.submit(plan.entries);
    if (result.ok) {
      setDrafts((cur) => {
        const copy = { ...cur };
        for (const key of keys) delete copy[key];
        return copy;
      });
      setServerErrors({});
      setShowErrors(false);
      return;
    }
    if (result.entryErrors.length > 0) {
      const mapped: Record<string, string> = {};
      for (const e of result.entryErrors) {
        const key = keys[e.index];
        if (key) mapped[key] = e.message || ENTRY_CODE_COPY[e.code] || e.code;
      }
      setServerErrors(mapped);
      setFormError(`${formatInteger(result.entryErrors.length)} of ${formatInteger(keys.length)} stages were rejected. Nothing was saved; fix them and submit again.`);
      return;
    }
    setFormError(result.message);
  };

  const groupProps: Omit<GroupProps, 'project'> = {
    drafts,
    errors: showErrors ? plan.errors : {},
    serverErrors,
    disabled: submitFlow.submitting,
    onChange,
  };

  const title = SURFACE?.title ?? 'Weekly Check-in';

  return (
    <>
      <PageHeader
        title={title}
        description="Report this week's progress on the stages due. Submitting saves the whole week at once and recalculates the timeline."
        actions={
          <>
            <CountrySegmented />
            <HubFilterChip />
          </>
        }
      />

      {query.isPending ? (
        <div className="space-y-3" aria-hidden="true">
          <Skeleton className="h-20 w-full" />
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-40 w-full" />
        </div>
      ) : query.isError ? (
        <ErrorState description="This week's check-in could not be loaded." onRetry={() => void query.refetch()} />
      ) : (
        <>
          <SummaryStrip week={query.data.week} summary={query.data.summary} />

          {projects.length === 0 ? (
            <EmptyState title="Nothing due this week" description="No stage in your scope is due for a check-in this week." />
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void onSubmit();
              }}
              aria-label="Weekly check-in"
              noValidate
            >
              {!anyWritable ? (
                <p className="mb-3 flex items-center gap-1.5 text-xs text-text-muted" role="note" data-testid="check-in-read-only">
                  <Info className="size-3.5 shrink-0" aria-hidden="true" />
                  You can view these stages. Checking in is for the stage&rsquo;s engineer, the project leader or a planner.
                </p>
              ) : null}

              {projects.length > VIRTUALIZE_OVER ? (
                <VirtualGroups projects={projects} props={groupProps} />
              ) : (
                <div className="space-y-3">
                  {projects.map((project) => (
                    <ProjectGroup key={project.project_id} project={project} {...groupProps} />
                  ))}
                </div>
              )}

              {anyWritable ? (
                <div className="sticky bottom-0 z-10 mt-4 flex flex-wrap items-center justify-end gap-3 rounded-dash border-[1.5px] border-dash-hairline bg-surface/95 px-4 py-3 shadow-pop backdrop-blur">
                  {formError ? (
                    <p role="alert" className="mr-auto flex items-center gap-1.5 text-xs text-danger" data-testid="check-in-form-error">
                      <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
                      {formError}
                    </p>
                  ) : showErrors && invalidCount > 0 ? (
                    <p role="alert" className="mr-auto flex items-center gap-1.5 text-xs text-danger" data-testid="check-in-form-error">
                      <TriangleAlert className="size-3.5 shrink-0" aria-hidden="true" />
                      {invalidCount === 1 ? '1 stage needs attention.' : `${formatInteger(invalidCount)} stages need attention.`}
                    </p>
                  ) : showErrors && plan.entries.length > CHECKIN_BATCH_MAX ? (
                    <p role="alert" className="mr-auto text-xs text-danger">
                      At most {CHECKIN_BATCH_MAX} stages can be submitted at once.
                    </p>
                  ) : (
                    <p className="mr-auto text-2xs text-text-muted" aria-live="polite">
                      {plan.entries.length === 0
                        ? 'Change a stage or confirm it unchanged to include it.'
                        : `${formatInteger(plan.entries.length)} ${plan.entries.length === 1 ? 'stage' : 'stages'} ready to submit.`}
                    </p>
                  )}
                  <Button type="submit" disabled={submitFlow.submitting || plan.entries.length === 0} data-testid="check-in-submit">
                    <Send aria-hidden="true" />
                    {submitFlow.submitting ? 'Submitting…' : 'Submit check-in'}
                  </Button>
                </div>
              ) : null}
            </form>
          )}
        </>
      )}

      <CheckInResultPanel
        flow={submitFlow.flow}
        runState={submitFlow.runState}
        changes={submitFlow.changes}
        watchingFollowUp={submitFlow.watchingFollowUp}
        onClose={submitFlow.close}
      />
    </>
  );
}

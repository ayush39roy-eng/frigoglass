import * as React from 'react';
import { Loader2, TriangleAlert } from 'lucide-react';

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
import { priorityDisplayText } from '@/lib/priority-applicability';
import { ApiError } from '@/lib/api/client';
import { apiErrorMessage } from '@/lib/api/error-messages';
import { isSuperAdminOnlyError, SUPER_ADMIN_ONLY_MESSAGE } from '@/lib/auth/super-admin';
import { formatFactor, formatInteger, formatWeek } from '@/lib/format';
import { cn } from '@/lib/utils';
import { ProjectRows } from '@/surfaces/workflow-settings/components/template-apply/project-rows';

import type {
  DeactivateResponse,
  DeactivationOpenProject,
  DeactivationPreview,
  DeactivationReason,
  EngineerRead,
} from '../api/types';
import { useDeactivateEngineer, useDeactivationPreview } from '../hooks/use-planning';
import {
  DEACTIVATION_COPY,
  DEACTIVATION_REASONS,
  blockedFrozenRows,
  buildDeactivateRequest,
  emptyRows,
  fillEmptyRows,
  keepValidChoices,
  needsSecondSentence,
  noEligibleCopy,
  noLeaderWarning,
  oneForAllOptions,
  type LeaderChoices,
} from '../lib/deactivation';

/**
 * P38-T06 (ADR 0053 §3, owner ruling 2026-11-17, API_CONTRACT_P38 §2): the
 * deactivation popup. It lists every open project the engineer leads with a
 * new-leader picker per row (the served candidates, in served order: eligible
 * active engineers of the capacity hub, least-loaded first), "Use one leader
 * for all" (fills only the empty rows), the reason (fixed codes), the served
 * supply effect and whether a login is linked.
 *
 * - Every row filled → "Deactivate". Any non-frozen row empty → "Deactivate
 *   anyway" with the contract's warning, verbatim, naming those projects.
 * - A frozen row must get a leader (R38-3): it is marked required and the
 *   confirm stays disabled until it has one; with no candidate the row says to
 *   unfreeze on the Timeline first. The request is never sent with a null
 *   frozen row.
 * - 409 LED_PROJECTS_CHANGED → the preview is refetched; choices are kept where
 *   the project and the chosen candidate are still listed.
 *
 * Nothing is computed here: eligibility, load, supply and the run decision are
 * the server's.
 */
const SELECT =
  'h-8 min-w-0 rounded border border-border-strong bg-surface px-2 text-xs text-text ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60 ' +
  'aria-[invalid=true]:border-danger aria-[invalid=true]:ring-1 aria-[invalid=true]:ring-danger';

export interface DeactivateEngineerDialogProps {
  /** The engineer to deactivate; `null` closes the dialog. */
  engineer: EngineerRead | null;
  onClose: () => void;
  onDeactivated: (result: DeactivateResponse, engineerName: string) => void;
  /** A 403: the page downgrades to read-only. */
  onForbidden: () => void;
}

export function DeactivateEngineerDialog({
  engineer,
  onClose,
  onDeactivated,
  onForbidden,
}: DeactivateEngineerDialogProps): React.JSX.Element {
  return (
    <Dialog
      open={engineer !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="max-h-[calc(100vh-2rem)] max-w-3xl overflow-y-auto" data-testid="deactivate-dialog">
        {engineer ? (
          <DeactivateBody key={engineer.id} engineer={engineer} onClose={onClose} onDeactivated={onDeactivated} onForbidden={onForbidden} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function previewErrorMessage(err: unknown): string {
  // P46 (ADR 0058 D1.3): deactivating is Super Admin only.
  if (isSuperAdminOnlyError(err)) return SUPER_ADMIN_ONLY_MESSAGE;
  if (err instanceof ApiError) {
    if (err.isForbidden || err.code === 'ENGINEER_STATUS_ADMIN_ONLY') return DEACTIVATION_COPY.adminOnly;
    if (err.code === 'ENGINEER_ALREADY_INACTIVE') return DEACTIVATION_COPY.alreadyInactive;
    if (err.status === 404) return 'This engineer was not found, or is outside your hubs.';
  }
  return apiErrorMessage(err, 'The projects this engineer leads could not be loaded. Nothing was changed.');
}

function DeactivateBody({
  engineer,
  onClose,
  onDeactivated,
  onForbidden,
}: {
  engineer: EngineerRead;
  onClose: () => void;
  onDeactivated: DeactivateEngineerDialogProps['onDeactivated'];
  onForbidden: () => void;
}): React.JSX.Element {
  const preview = useDeactivationPreview(engineer.id);
  const mutation = useDeactivateEngineer();
  const [rawChoices, setChoices] = React.useState<LeaderChoices>({});
  const [reason, setReason] = React.useState<DeactivationReason | ''>('');
  const [notice, setNotice] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const ids = React.useId();

  const data = preview.data;
  const rows = React.useMemo(() => data?.open_projects ?? [], [data]);

  // A refreshed list (409, or a refetch) keeps only choices still valid for it.
  const choices = React.useMemo(() => keepValidChoices(rows, rawChoices), [rows, rawChoices]);

  React.useEffect(() => {
    // A Super-Admin-only 403 refuses this one action; the page stays writable.
    if (preview.error instanceof ApiError && preview.error.isForbidden && !isSuperAdminOnlyError(preview.error)) onForbidden();
  }, [preview.error, onForbidden]);

  const empty = emptyRows(rows, choices);
  const blocked = blockedFrozenRows(rows, choices);
  // Frozen empty rows block the confirm instead (R38-3); only the others are "anyway".
  const anyway = empty.some((r) => !r.frozen);
  const canConfirm = data !== undefined && reason !== '' && blocked.length === 0 && !mutation.isPending && !preview.isFetching;

  const refresh = async (message: string): Promise<void> => {
    setNotice(message);
    await preview.refetch();
  };

  const confirm = async (): Promise<void> => {
    if (!data || reason === '' || blocked.length > 0) return;
    setError(null);
    setNotice(null);
    try {
      const result = await mutation.mutateAsync({
        engineerId: engineer.id,
        body: buildDeactivateRequest(rows, choices, reason, data.led_projects_token),
      });
      onDeactivated(result, engineer.name);
    } catch (err) {
      if (!(err instanceof ApiError)) {
        setError('The engineer could not be deactivated. Nothing was changed. Please try again.');
        return;
      }
      if (isSuperAdminOnlyError(err)) {
        // P46 (ADR 0058 D1.3): only this action is refused; the page stays writable.
        setError(SUPER_ADMIN_ONLY_MESSAGE);
      } else if (err.isForbidden) {
        onForbidden();
        setError(DEACTIVATION_COPY.adminOnly);
      } else if (err.code === 'LED_PROJECTS_CHANGED') {
        await refresh(DEACTIVATION_COPY.changed);
      } else if (err.code === 'FROZEN_NEEDS_LEADER') {
        await refresh(`A frozen project needs a leader. ${DEACTIVATION_COPY.frozenNeedsLeader} Nothing was changed.`);
      } else if (err.code === 'LEADER_INACTIVE' || err.code === 'UNKNOWN_LEADER') {
        await refresh('One of the chosen leaders is no longer available. The list is refreshed; choose again. Nothing was changed.');
      } else if (err.status === 503 || err.code === 'ENGINEER_STATUS_BUSY') {
        setError(DEACTIVATION_COPY.busy);
      } else if (err.code === 'ENGINEER_ALREADY_INACTIVE') {
        setError(DEACTIVATION_COPY.alreadyInactive);
      } else {
        setError(apiErrorMessage(err, 'The engineer could not be deactivated. Nothing was changed. Please try again.'));
      }
    }
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>Deactivate {engineer.name}?</DialogTitle>
        <DialogDescription>
          Their name stays on every project and schedule they are part of, with an &ldquo;Inactive&rdquo; tag. After
          the deactivation week they are not booked and do not count in capacity. Choose a new leader for each open
          project they lead.
        </DialogDescription>
      </DialogHeader>

      {preview.isPending ? (
        <p role="status" className="flex items-center gap-2 text-xs text-text-muted">
          <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
          Loading the projects {engineer.name} leads…
        </p>
      ) : preview.isError && !data ? (
        <p role="alert" className="text-xs text-danger" data-testid="deactivate-preview-error">
          {previewErrorMessage(preview.error)}
        </p>
      ) : data ? (
        <div className="flex flex-col gap-3">
          <Facts data={data} />

          {notice ? (
            <p role="status" className="rounded-md border border-warning/50 bg-warning-subtle px-3 py-2 text-xs text-warning-subtle-fg" data-testid="deactivate-notice">
              {notice}
            </p>
          ) : null}

          {rows.length === 0 ? (
            <p className="text-xs text-text-muted" data-testid="deactivate-no-projects">
              {DEACTIVATION_COPY.noOpenProjects}
            </p>
          ) : (
            <section aria-labelledby={`${ids}-projects`} className="flex flex-col gap-2">
              <div className="flex flex-wrap items-end justify-between gap-2">
                <h3 id={`${ids}-projects`} className="text-sm font-bold text-text">
                  Open projects ({formatInteger(rows.length)})
                </h3>
                <OneForAll rows={rows} disabled={mutation.isPending} onPick={(id) => setChoices(fillEmptyRows(rows, choices, id))} />
              </div>
              <ProjectRows
                rows={rows}
                rowKey={(r) => r.project_id}
                label={`Open projects led by ${engineer.name}`}
                testId="deactivate-project-list"
                renderRow={(r) => (
                  <ProjectRow
                    row={r}
                    value={choices[r.project_id] ?? ''}
                    disabled={mutation.isPending}
                    onChange={(v) => {
                      const next: Record<string, string> = { ...choices };
                      if (v) next[r.project_id] = v;
                      else delete next[r.project_id];
                      setChoices(next);
                    }}
                  />
                )}
              />
            </section>
          )}

          <div className="flex flex-col gap-1">
            <label htmlFor={`${ids}-reason`} className="text-xs font-semibold text-text">
              Reason<span className="text-danger" aria-hidden="true"> *</span>
            </label>
            <select
              id={`${ids}-reason`}
              className={cn(SELECT, 'w-56')}
              value={reason}
              required
              aria-required="true"
              disabled={mutation.isPending}
              onChange={(e) => setReason(e.currentTarget.value as DeactivationReason | '')}
              data-testid="deactivate-reason"
            >
              <option value="">Choose a reason…</option>
              {DEACTIVATION_REASONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
          </div>

          {blocked.length > 0 ? (
            <p className="flex items-start gap-1.5 text-xs text-danger" data-testid="deactivate-frozen-block">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <span>
                A frozen project cannot be left without a leader. Choose one for {blocked.map((r) => r.name).join(', ')}.
              </span>
            </p>
          ) : null}

          {anyway ? <NoLeaderWarning rows={empty} /> : null}

          {error ? (
            <p role="alert" className="text-xs text-danger" data-testid="deactivate-error">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}

      <DialogFooter>
        <Button type="button" variant="secondary" size="sm" onClick={onClose} disabled={mutation.isPending}>
          Cancel
        </Button>
        <Button
          type="button"
          variant="danger"
          size="sm"
          disabled={!canConfirm}
          onClick={() => void confirm()}
          data-testid="deactivate-confirm"
        >
          {mutation.isPending ? 'Deactivating…' : anyway ? 'Deactivate anyway' : 'Deactivate'}
        </Button>
      </DialogFooter>
    </>
  );
}

/** Served facts: the deactivation week, the supply effect, the linked login. */
function Facts({ data }: { data: DeactivationPreview }): React.JSX.Element {
  const s = data.supply_effect;
  return (
    <ul className="flex flex-col gap-1 text-xs text-text-muted" data-testid="deactivate-facts">
      <li>
        Deactivation week: <span className="font-semibold text-text tnum">{formatWeek(data.deactivation_week)}</span> (counts as worked).
      </li>
      {s ? (
        <li data-testid="deactivate-supply">
          Design capacity of {s.capacity_hub}: full year{' '}
          <span className="font-semibold text-text tnum">
            {formatInteger(s.yearly_design_capacity.before)} → {formatInteger(s.yearly_design_capacity.after)} wks
          </span>
          , remaining{' '}
          <span className="font-semibold text-text tnum">
            {formatInteger(s.remaining_design_capacity.before)} → {formatInteger(s.remaining_design_capacity.after)} wks
          </span>
          .
        </li>
      ) : (
        <li data-testid="deactivate-supply">Not on the capacity roster, so capacity does not change.</li>
      )}
      <li data-testid="deactivate-login">{data.has_linked_login ? DEACTIVATION_COPY.loginLinked : DEACTIVATION_COPY.loginNotLinked}</li>
    </ul>
  );
}

function OneForAll({
  rows,
  disabled,
  onPick,
}: {
  rows: readonly DeactivationOpenProject[];
  disabled: boolean;
  onPick: (engineerId: string) => void;
}): React.JSX.Element | null {
  const id = React.useId();
  const options = oneForAllOptions(rows);
  if (options.length === 0) return null;
  return (
    <div className="flex flex-col gap-0.5">
      <label htmlFor={id} className="text-2xs font-semibold text-text-muted">
        Use one leader for all
      </label>
      <select
        id={id}
        className={cn(SELECT, 'w-56')}
        value=""
        disabled={disabled}
        onChange={(e) => {
          if (e.currentTarget.value) onPick(e.currentTarget.value);
        }}
        aria-describedby={`${id}-hint`}
        data-testid="deactivate-one-for-all"
      >
        <option value="">Choose…</option>
        {options.map((o) => (
          <option key={o.engineer_id} value={o.engineer_id}>
            {o.name}
          </option>
        ))}
      </select>
      <span id={`${id}-hint`} className="text-2xs text-text-subtle">
        Fills the empty rows where this engineer is eligible.
      </span>
    </div>
  );
}

function ProjectRow({
  row,
  value,
  disabled,
  onChange,
}: {
  row: DeactivationOpenProject;
  value: string;
  disabled: boolean;
  onChange: (engineerId: string) => void;
}): React.JSX.Element {
  const id = React.useId();
  const meta = [row.hub, row.status, priorityDisplayText(row.status, row.priority), row.category].filter((x): x is string => Boolean(x)).join(' · ');
  const noCandidate = row.candidates.length === 0;
  const missingFrozen = row.frozen && !value;
  return (
    <div className="flex flex-wrap items-start justify-between gap-2" data-testid={`deactivate-row-${row.project_id}`}>
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="font-semibold text-text" id={`${id}-name`}>
          {row.name}
        </span>
        <span className="text-2xs text-text-muted">{meta}</span>
        <span className="flex flex-wrap gap-1">
          {row.frozen ? <Badge tone="warning">Frozen: leader required</Badge> : null}
          {row.progress_tracked ? <Badge tone="neutral">Progress tracked</Badge> : null}
          {row.done_stages > 0 ? (
            <Badge tone="neutral">
              {formatInteger(row.done_stages)} {row.done_stages === 1 ? 'stage' : 'stages'} done
            </Badge>
          ) : null}
          {row.in_flight_lab ? <Badge tone="warning">Lab test in progress</Badge> : null}
        </span>
      </div>
      <div className="flex w-64 max-w-full flex-col gap-0.5">
        {noCandidate ? (
          <>
            <span className="text-xs text-text-muted" data-testid="deactivate-no-candidate">
              {noEligibleCopy(row.hub)}
            </span>
            {row.frozen ? (
              <span className="text-2xs font-semibold text-danger" data-testid="deactivate-unfreeze">
                {DEACTIVATION_COPY.frozenNeedsLeader}
              </span>
            ) : (
              <span className="text-2xs text-text-subtle">This project will have no leader.</span>
            )}
          </>
        ) : (
          <>
            <label htmlFor={id} className="sr-only">
              New leader for {row.name}
            </label>
            <select
              id={id}
              className={SELECT}
              value={value}
              disabled={disabled}
              required={row.frozen}
              aria-required={row.frozen ? 'true' : undefined}
              aria-invalid={missingFrozen ? 'true' : undefined}
              aria-describedby={row.frozen ? `${id}-frozen` : undefined}
              onChange={(e) => onChange(e.currentTarget.value)}
              data-testid="deactivate-leader"
            >
              <option value="">{row.frozen ? 'Choose a leader…' : 'No leader'}</option>
              {row.candidates.map((c) => (
                <option key={c.engineer_id} value={c.engineer_id}>
                  {c.name} · {formatFactor(c.fte)} FTE · {formatInteger(c.load_weeks)} wks booked
                </option>
              ))}
            </select>
            {row.frozen ? (
              <span id={`${id}-frozen`} className="text-2xs text-text-muted">
                {DEACTIVATION_COPY.frozenRequired}
              </span>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}

/** Contract §2 warning, verbatim, naming the projects that will have no leader. */
function NoLeaderWarning({ rows }: { rows: readonly DeactivationOpenProject[] }): React.JSX.Element {
  const nonFrozen = rows.filter((r) => !r.frozen);
  if (nonFrozen.length === 0) return <></>;
  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-col gap-1 rounded-md border border-warning/60 bg-warning-subtle px-3 py-2 text-xs text-warning-subtle-fg"
      data-testid="deactivate-warning"
    >
      <p className="flex items-start gap-1.5 font-semibold">
        <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <span>
          {noLeaderWarning(nonFrozen.length)}
          {needsSecondSentence(nonFrozen) ? ` ${DEACTIVATION_COPY.warningSecond}` : ''}
        </span>
      </p>
      <ul className="ml-5 list-disc" aria-label="Projects that will have no leader">
        {nonFrozen.map((r) => (
          <li key={r.project_id}>{r.name}</li>
        ))}
      </ul>
    </div>
  );
}

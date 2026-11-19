import * as React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CalendarRange } from 'lucide-react';

import { RecalculateButton } from '@/components/shared/plan-week-notice';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Label } from '@/components/ui/label';
import { apiErrorMessage } from '@/lib/api/error-messages';
import { formatWeekWithYear } from '@/lib/format';
import { beyondHorizonText } from '@/lib/left-out-reason';
import { useSessionStore } from '@/stores/session';

import {
  fetchSchedulingSettings,
  HORIZON_YEARS_CHOICES,
  updateSchedulingSettings,
  type SchedulingSettings,
} from '../../api/scheduling-settings-api';

const SETTINGS_KEY = ['scheduling-settings'] as const;
const WRITE_ROLES = new Set(['Admin', 'Super Admin']);

/**
 * P53 (ADR 0063, R53-2): the Admin setting N — how many years ahead the
 * scheduler searches for a slot (1–10, default 5). P1, P2 and P3 are scheduled
 * to completion within it; a project with no slot reads "Cannot be scheduled
 * within N years — check resources". Changing N is an audited settings edit,
 * applied at the next run; the save offers the standard Recalculate. The
 * search limit week shown is served (`horizon_weeks_next_run`), never computed.
 */
export function SchedulingHorizonCard(): React.JSX.Element {
  const queryClient = useQueryClient();
  const refreshSession = useSessionStore((s) => s.refresh);
  const canWrite = useSessionStore((s) => s.me?.roles.some((r) => WRITE_ROLES.has(r)) ?? false);
  const query = useQuery({ queryKey: SETTINGS_KEY, queryFn: ({ signal }) => fetchSchedulingSettings({ signal }) });
  const [draft, setDraft] = React.useState<number | null>(null);
  const [saved, setSaved] = React.useState(false);
  const save = useMutation({
    mutationFn: (body: { horizon_years: number; version: number }) => updateSchedulingSettings(body),
    onSuccess: (data: SchedulingSettings) => {
      queryClient.setQueryData(SETTINGS_KEY, data);
      setDraft(null);
      setSaved(true);
      // /me serves the next run's search limit (`horizon_weeks`).
      void refreshSession();
    },
    onError: () => {
      void queryClient.invalidateQueries({ queryKey: SETTINGS_KEY });
    },
  });

  const data = query.data;
  const value = draft ?? data?.horizon_years ?? null;
  const dirty = data !== undefined && draft !== null && draft !== data.horizon_years;

  return (
    <Card className="mb-s4" data-testid="scheduling-horizon-card">
      <CardContent className="space-y-s2 pt-s4">
        <div className="flex flex-wrap items-center gap-2">
          <CalendarRange className="size-4 text-text-subtle" aria-hidden="true" />
          <h2 className="text-sm font-bold text-text">Scheduling search limit</h2>
        </div>
        <p className="text-xs text-text-muted">
          P1, P2 and P3 projects are scheduled to completion, however many years that takes, up to this limit. A
          project that finds no slot within it reads &quot;{beyondHorizonText(value)}&quot;. The change applies at the
          next recalculation.
        </p>
        {query.isPending ? (
          <p className="text-xs text-text-muted">Loading…</p>
        ) : query.isError || !data ? (
          <p className="text-xs text-danger" role="alert">
            {apiErrorMessage(query.error, 'The scheduling setting could not be loaded.')}
          </p>
        ) : (
          <form
            className="flex flex-wrap items-end gap-s3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!dirty || draft === null) return;
              setSaved(false);
              save.mutate({ horizon_years: draft, version: data.version });
            }}
          >
            <div className="flex flex-col gap-1">
              <Label htmlFor="horizon-years" className="text-2xs text-text-muted">
                Search up to (years ahead)
              </Label>
              <select
                id="horizon-years"
                className="h-8 rounded border border-border-strong bg-surface px-2 text-xs text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-60"
                value={value === null ? '' : String(value)}
                disabled={!canWrite || save.isPending}
                onChange={(e) => {
                  setSaved(false);
                  setDraft(Number(e.target.value));
                }}
                data-testid="horizon-years-select"
              >
                {HORIZON_YEARS_CHOICES.map((n) => (
                  <option key={n} value={String(n)}>
                    {n === 1 ? '1 year' : `${String(n)} years`}
                  </option>
                ))}
              </select>
            </div>
            <p className="pb-1.5 text-2xs text-text-muted" data-testid="horizon-next-run">
              Next run searches to {formatWeekWithYear(data.horizon_weeks_next_run)}
              {dirty ? ' (before this change)' : ''}.
            </p>
            {canWrite ? (
              <Button type="submit" size="sm" disabled={!dirty || save.isPending} data-testid="horizon-save">
                {save.isPending ? 'Saving…' : 'Save'}
              </Button>
            ) : (
              <p className="pb-1.5 text-2xs text-text-muted">Read-only for your role (Admin or Super Admin can change it).</p>
            )}
          </form>
        )}
        {save.isError ? (
          <p className="text-2xs text-danger" role="alert" data-testid="horizon-save-error">
            {apiErrorMessage(save.error, 'The setting could not be saved.')}
          </p>
        ) : null}
        {saved ? (
          <div className="flex flex-wrap items-center gap-2 text-2xs text-text" role="status" data-testid="horizon-saved">
            Saved. It applies at the next recalculation.
            <RecalculateButton />
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}

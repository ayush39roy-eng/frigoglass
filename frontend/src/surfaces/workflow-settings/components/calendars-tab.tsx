import * as React from 'react';
import { Save } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatDecimal } from '@/lib/format';

import type { HubCalendarSetting, HubCalendarUpdateRequest, WorkflowSettingsSaveResult } from '../api/types';
import { previewWorkingWeeksPerEngineer } from '../lib/preview';
import { saveErrorMessage } from './save-error';

/**
 * Hub work calendars (ADR 0008): the five editable fields per hub and the
 * derived working weeks per engineer. The SAVED figure is the server's; while
 * editing, a preview (labelled "preview") re-evaluates the formula client-side
 * so the editor sees the effect before saving.
 */
const FIELDS: { key: keyof HubCalendarUpdateRequest; label: string }[] = [
  { key: 'weekdays_per_week', label: 'Weekdays / week' },
  { key: 'national_holiday_days', label: 'National holidays (days)' },
  { key: 'medical_leave_days', label: 'Medical leave (days)' },
  { key: 'casual_leave_days', label: 'Casual leave (days)' },
  { key: 'annual_leave_days', label: 'Annual leave (days)' },
];

export interface CalendarsTabProps {
  calendars: HubCalendarSetting[];
  canWrite: boolean;
  onSave: (hubId: string, body: HubCalendarUpdateRequest) => Promise<WorkflowSettingsSaveResult>;
  saving: boolean;
}

export function CalendarsTab({ calendars, canWrite, onSave, saving }: CalendarsTabProps): React.JSX.Element {
  return (
    <div className="grid gap-4 xl:grid-cols-2">
      {calendars.map((c) => (
        <CalendarCard key={`${c.hub_id}-${String(c.working_weeks_per_engineer)}`} calendar={c} canWrite={canWrite} onSave={onSave} saving={saving} />
      ))}
    </div>
  );
}

function CalendarCard({
  calendar,
  canWrite,
  onSave,
  saving,
}: {
  calendar: HubCalendarSetting;
  canWrite: boolean;
  onSave: CalendarsTabProps['onSave'];
  saving: boolean;
}): React.JSX.Element {
  const initial: HubCalendarUpdateRequest = {
    weekdays_per_week: calendar.weekdays_per_week,
    national_holiday_days: calendar.national_holiday_days,
    medical_leave_days: calendar.medical_leave_days,
    casual_leave_days: calendar.casual_leave_days,
    annual_leave_days: calendar.annual_leave_days,
  };
  const [values, setValues] = React.useState<HubCalendarUpdateRequest>(initial);
  const [error, setError] = React.useState<string | null>(null);
  const dirty = FIELDS.some((f) => values[f.key] !== initial[f.key]);
  const invalid =
    !(values.weekdays_per_week >= 1 && values.weekdays_per_week <= 7) ||
    FIELDS.some((f) => !Number.isFinite(values[f.key]) || values[f.key] < 0);
  const preview = previewWorkingWeeksPerEngineer({ ...values, weeks_in_year: calendar.weeks_in_year });

  return (
    <Card data-testid={`calendar-${calendar.hub}`}>
      <CardHeader>
        <CardTitle>{calendar.hub}</CardTitle>
        {canWrite ? (
          <Button
            type="button"
            size="sm"
            disabled={!dirty || invalid || saving}
            onClick={() => {
              setError(null);
              onSave(calendar.hub_id, values).catch((err: unknown) => setError(saveErrorMessage(err)));
            }}
          >
            <Save />
            Save
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-2 sm:grid-cols-5">
          {FIELDS.map((f) => {
            const id = `cal-${calendar.hub_id}-${f.key}`;
            return (
              <div key={f.key} className="flex flex-col gap-1">
                <label htmlFor={id} className="text-2xs text-text-muted">
                  {f.label}
                </label>
                <input
                  id={id}
                  type="number"
                  min={f.key === 'weekdays_per_week' ? 1 : 0}
                  max={f.key === 'weekdays_per_week' ? 7 : undefined}
                  step="0.5"
                  readOnly={!canWrite}
                  value={String(values[f.key])}
                  onChange={(e) => setValues((prev) => ({ ...prev, [f.key]: Number(e.target.value) }))}
                  className="h-8 rounded border border-border-strong bg-surface px-2 text-right text-xs tabular-nums text-text read-only:bg-surface-sunken focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </div>
            );
          })}
        </div>
        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-2xs">
          <div>
            <dt className="text-text-subtle">Working weeks / engineer (saved)</dt>
            <dd className="font-mono text-sm font-semibold text-text" data-testid="saved-working-weeks">
              {formatDecimal(calendar.working_weeks_per_engineer)}
            </dd>
          </div>
          {dirty ? (
            <div>
              <dt className="text-text-subtle">Working weeks / engineer (preview)</dt>
              <dd className="font-mono text-sm font-semibold text-primary-subtle-fg" data-testid="preview-working-weeks">
                {Number.isFinite(preview) ? formatDecimal(preview) : '—'}{' '}
                <span className="text-2xs font-normal text-text-subtle">preview — not saved</span>
              </dd>
            </div>
          ) : null}
        </dl>
        <p className="text-2xs text-text-subtle">
          52 − Σ(days ÷ weekdays per week). The saved figure is computed by the server.
        </p>
        {invalid ? (
          <p role="alert" className="text-2xs text-danger">
            Weekdays per week must be 1–7 and day counts 0 or more.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-2xs text-danger">
            {error}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

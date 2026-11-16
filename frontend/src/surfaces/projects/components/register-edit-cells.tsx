import * as React from 'react';
import { ChevronDown, RotateCcw, TriangleAlert } from 'lucide-react';

import { formatPlanWeek } from '@/lib/format';
import { cn } from '@/lib/utils';
import { UI_PROJECT_STATUSES, type ProjectStatus } from '@/types/enums';

import type { EngineerOption } from '@/surfaces/registration/api/engineers-api';

import { dateInputToPlanWeek, PLAN_DATE_MAX, PLAN_DATE_MIN, planWeekToDateInput } from '../lib/plan-week-date';
import { parseEffortInput } from '../lib/register-edit';
import { statusMismatchText } from '../lib/status-mismatch';

/**
 * P35-T02 / T08: the Projects register's cells — the editable controls of
 * Edit mode and the read-mode renderings that share their colour code.
 *
 * Design / lab time (D35-1): with no typed figure the cell shows the served
 * `*_weeks_calculated` in green ("Calculated: N wk"); a typed figure shows in
 * orange ("Manual (calculated: N wk)") with "↺ reset", which clears the
 * figure (sends `null`). The figure is the client's design / lab time
 * (ADR 0041); the server splits it over the steps.
 */

/**
 * An editable control (owner 2026-11-17: "editable fields must clearly look
 * editable"): a visible border, the surface background and a slight inset
 * shadow, a primary border on hover and focus. Existing tokens only.
 */
export const EDIT_INPUT =
  'h-7 min-w-0 rounded border border-border-strong bg-surface px-1.5 text-xs text-text shadow-sm transition-colors ' +
  'hover:border-primary/60 hover:bg-primary-subtle/30 ' +
  'focus-visible:border-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ' +
  'aria-[invalid=true]:border-danger aria-[invalid=true]:ring-1 aria-[invalid=true]:ring-danger ' +
  'disabled:cursor-not-allowed disabled:opacity-60 disabled:hover:border-border-strong disabled:hover:bg-surface';

/** A native `<select>` with its own chevron (the browser arrow is hidden so
 *  every select reads the same in Edit mode and in the popup). */
export function NativeSelect({
  className,
  wrapperClassName,
  ...props
}: React.SelectHTMLAttributes<HTMLSelectElement> & { wrapperClassName?: string }): React.JSX.Element {
  return (
    <span className={cn('relative flex min-w-0', wrapperClassName)}>
      <select {...props} className={cn(EDIT_INPUT, 'w-full cursor-pointer appearance-none pr-6', className)} />
      <ChevronDown
        className="pointer-events-none absolute right-1.5 top-1/2 size-3.5 -translate-y-1/2 text-text-muted"
        aria-hidden="true"
      />
    </span>
  );
}

/** Marks a cell whose value differs from the served one. */
export const CHANGED = 'bg-warning-subtle/60 ring-1 ring-inset ring-warning/50 rounded';

/** P35-T08b: a status that differs from the one the current step implies. */
export const STATUS_MISMATCH = 'rounded ring-2 ring-inset ring-danger';

const CALCULATED_TEXT = 'text-success-subtle-fg';
const MANUAL_TEXT = 'text-warning-subtle-fg';

function weeksText(n: number): string {
  return `${String(n)} wk`;
}

/** `calculated` is null only where the served calculated weeks are not at
 *  hand (the popup opened from the project folder on an API without them). */
function calculatedTooltip(calculated: number | null): string {
  return calculated === null ? 'Calculated by the server' : `Calculated: ${weeksText(calculated)}`;
}

function manualTooltip(calculated: number | null): string {
  return calculated === null ? 'Manual' : `Manual (calculated: ${weeksText(calculated)})`;
}

/** Read mode: the served figure (orange) or the served calculated weeks (green). */
export function EffortValue({ figure, calculated }: { figure: number | null; calculated: number }): React.JSX.Element {
  const manual = figure !== null;
  const tip = manual ? manualTooltip(calculated) : calculatedTooltip(calculated);
  return (
    <span
      className={cn('text-xs font-semibold tabular-nums', manual ? MANUAL_TEXT : CALCULATED_TEXT)}
      title={tip}
      data-numeric=""
      data-source={manual ? 'manual' : 'calculated'}
      data-testid="effort-value"
    >
      {weeksText(manual ? figure : calculated)}
      <span className="sr-only">{` (${tip})`}</span>
    </span>
  );
}

function formatFigure(v: number | null): string {
  return v === null ? '' : String(v);
}

/** Edit mode: a design / lab time input with "↺ reset". */
export function EffortInput({
  figure,
  calculated,
  changed,
  label,
  invalid = false,
  onChange,
  id,
  inputClassName,
  describedBy,
}: {
  /** The draft figure (null = none: the calculated weeks apply). */
  figure: number | null;
  calculated: number | null;
  changed: boolean;
  /** "Design time of Cooler A". */
  label: string;
  /** A server error names this cell. */
  invalid?: boolean;
  onChange: (next: number | null) => void;
  /** The popup's id for its `<label htmlFor>`. */
  id?: string;
  /** Wider input (the popup). */
  inputClassName?: string;
  /** `aria-describedby` (the popup's inline error). */
  describedBy?: string | undefined;
}): React.JSX.Element {
  // Local text so a half-typed "4." is kept; re-synced when the draft changes
  // from outside (reset, bulk bar, Cancel).
  const [text, setText] = React.useState(formatFigure(figure));
  const [synced, setSynced] = React.useState(figure);
  if (synced !== figure) {
    setSynced(figure);
    if (parseEffortInput(text) !== figure) setText(formatFigure(figure));
  }
  const parsed = parseEffortInput(text);
  const bad = parsed === undefined;
  const manual = figure !== null;
  const tip = manual ? manualTooltip(calculated) : calculatedTooltip(calculated);
  return (
    <span className={cn('flex min-w-0 items-center gap-1 p-0.5', changed && CHANGED)}>
      <input
        id={id}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        className={cn(
          EDIT_INPUT,
          'w-14 text-right font-semibold tabular-nums',
          manual ? MANUAL_TEXT : CALCULATED_TEXT,
          'placeholder:font-semibold placeholder:text-success-subtle-fg',
          inputClassName,
        )}
        value={text}
        placeholder={calculated === null ? 'auto' : String(calculated)}
        aria-describedby={describedBy}
        title={tip}
        aria-label={`${label}, weeks. ${tip}. Empty uses the calculated weeks.`}
        aria-invalid={bad || invalid ? true : undefined}
        data-source={manual ? 'manual' : 'calculated'}
        data-changed={changed ? 'true' : undefined}
        data-testid="effort-input"
        onChange={(e) => {
          const next = e.currentTarget.value;
          setText(next);
          const value = parseEffortInput(next);
          if (value !== undefined) onChange(value);
        }}
      />
      {manual ? (
        <button
          type="button"
          className="inline-flex shrink-0 items-center gap-0.5 rounded px-1 text-2xs font-semibold text-warning-subtle-fg hover:bg-warning-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={calculated === null ? `Reset ${label} to the calculated weeks` : `Reset ${label} to the calculated ${weeksText(calculated)}`}
          title={calculated === null ? 'Reset to calculated' : `Reset to calculated (${weeksText(calculated)})`}
          data-testid="effort-reset"
          onClick={() => {
            setText('');
            onChange(null);
          }}
        >
          <RotateCcw className="size-3" aria-hidden="true" />
          reset
        </button>
      ) : null}
    </span>
  );
}

/** Edit mode: the project status, limited to the statuses an edit may set. */
export function StatusSelect({
  value,
  served,
  changed,
  label,
  invalid = false,
  mismatchExpected = null,
  onChange,
}: {
  value: ProjectStatus;
  /** The served status: a hidden one (In Buyoff) stays selectable as itself. */
  served: ProjectStatus;
  changed: boolean;
  label: string;
  invalid?: boolean;
  /** P35-T08b: the served expected status when `value` differs from it; null = no warning. */
  mismatchExpected?: ProjectStatus | null;
  onChange: (next: ProjectStatus) => void;
}): React.JSX.Element {
  const options = UI_PROJECT_STATUSES.includes(served) || served === 'Draft' ? UI_PROJECT_STATUSES : [served, ...UI_PROJECT_STATUSES];
  const descId = React.useId();
  const mismatch = mismatchExpected === null ? null : statusMismatchText(mismatchExpected);
  return (
    <span
      className={cn('flex min-w-0 p-0.5', changed && CHANGED, mismatch !== null && STATUS_MISMATCH)}
      title={mismatch ?? undefined}
      data-status-mismatch={mismatch !== null ? 'true' : undefined}
    >
      {mismatch !== null ? (
        <span id={descId} className="sr-only">
          {mismatch}
        </span>
      ) : null}
      <NativeSelect
        wrapperClassName="w-full"
        value={value}
        aria-label={`Status of ${label}`}
        aria-describedby={mismatch !== null ? descId : undefined}
        aria-invalid={invalid ? true : undefined}
        data-changed={changed ? 'true' : undefined}
        data-testid="status-select"
        onChange={(e) => onChange(e.currentTarget.value as ProjectStatus)}
      >
        {options.map((s) => (
          <option key={s} value={s}>
            {s}
          </option>
        ))}
      </NativeSelect>
    </span>
  );
}

/** Read mode: wraps the status badge with the red outline, tooltip and
 *  screen-reader text of the status-mismatch warning (P35-T08b). */
export function StatusMismatchMark({
  expected,
  children,
}: {
  expected: ProjectStatus | null;
  children: React.ReactNode;
}): React.JSX.Element {
  if (expected === null) return <>{children}</>;
  const text = statusMismatchText(expected);
  return (
    <span className={cn('inline-flex p-0.5', STATUS_MISMATCH)} title={text} data-status-mismatch="true" data-testid="status-mismatch">
      {children}
      <span className="sr-only">{` (${text})`}</span>
    </span>
  );
}

const UNASSIGNED = '';

/** Edit mode: the design resource (project leader), from the served
 *  `GET /engineers?hub_id=` list of the row's hub. */
export function LeaderSelect({
  value,
  servedId,
  servedName,
  options,
  loading,
  changed,
  label,
  invalid = false,
  onChange,
}: {
  value: string | null;
  servedId: string | null;
  servedName: string | null;
  options: readonly EngineerOption[] | undefined;
  loading: boolean;
  changed: boolean;
  label: string;
  invalid?: boolean;
  onChange: (next: string | null) => void;
}): React.JSX.Element {
  const list = options ?? [];
  // The served leader stays selectable even if the list does not carry it.
  const servedMissing = servedId !== null && !list.some((e) => e.id === servedId);
  return (
    <span className={cn('flex min-w-0 p-0.5', changed && CHANGED)}>
      <NativeSelect
        wrapperClassName="w-full"
        value={value ?? UNASSIGNED}
        aria-label={`Design resource (leader) of ${label}`}
        aria-invalid={invalid ? true : undefined}
        aria-busy={loading ? true : undefined}
        data-changed={changed ? 'true' : undefined}
        data-testid="leader-select"
        onChange={(e) => onChange(e.currentTarget.value === UNASSIGNED ? null : e.currentTarget.value)}
      >
        <option value={UNASSIGNED}>Unassigned</option>
        {servedMissing ? <option value={servedId}>{servedName ?? 'Current leader (name unavailable)'}</option> : null}
        {list.map((e) => (
          <option key={e.id} value={e.id}>
            {e.name}
          </option>
        ))}
      </NativeSelect>
    </span>
  );
}

/** Read and edit mode: "Unassigned ⚠" when there is no design resource (P35-T08). */
export function UnassignedFlag({ leftOut = false }: { leftOut?: boolean }): React.JSX.Element {
  return (
    <span className="flex min-w-0 flex-col" data-testid="unassigned-flag">
      <span
        className="inline-flex w-fit items-center gap-1 rounded-pill bg-warning-subtle px-1.5 py-0.5 text-2xs font-semibold text-warning-subtle-fg"
        title="No design resource (leader) assigned"
      >
        Unassigned
        <TriangleAlert className="size-3" aria-hidden="true" />
        <span className="sr-only">: no design resource assigned</span>
      </span>
      {leftOut ? <span className="truncate text-2xs text-warning-subtle-fg">Left out: no leader assigned</span> : null}
    </span>
  );
}

/** Read mode: a served actual week. */
export function WeekValue({ week }: { week: number | null }): React.JSX.Element {
  return week === null ? (
    <span className="text-text-subtle">—</span>
  ) : (
    <span className="text-xs font-semibold tabular-nums text-text" data-numeric="" title={planWeekToDateInput(week) || undefined}>
      {formatPlanWeek(week)}
    </span>
  );
}

/** Edit mode: an actual start / end picked as a date, stored as a plan week. */
export function WeekDateInput({
  week,
  changed,
  label,
  warning,
  invalid = false,
  onChange,
  id,
}: {
  week: number | null;
  changed: boolean;
  /** "Actual start of Cooler A". */
  label: string;
  /** Inline warning text (end before start), or null. */
  warning: string | null;
  invalid?: boolean;
  onChange: (next: number | null) => void;
  /** The popup's id for its `<label htmlFor>`. */
  id?: string;
}): React.JSX.Element {
  const [error, setError] = React.useState<string | null>(null);
  const warnId = React.useId();
  const message = error ?? warning;
  return (
    <span className={cn('flex min-w-0 flex-col gap-0.5 p-0.5', changed && CHANGED)}>
      <span className="flex items-center gap-1">
        <input
          id={id}
          type="date"
          className={cn(EDIT_INPUT, 'w-[8.5rem] cursor-pointer')}
          value={planWeekToDateInput(week)}
          min={PLAN_DATE_MIN}
          max={PLAN_DATE_MAX}
          aria-label={`${label} (date, stored as a plan week)`}
          aria-invalid={message !== null || invalid ? true : undefined}
          aria-describedby={message !== null ? warnId : undefined}
          data-changed={changed ? 'true' : undefined}
          data-testid="week-date-input"
          onChange={(e) => {
            const next = dateInputToPlanWeek(e.currentTarget.value);
            if (next === undefined) {
              setError('No plan week for this date (2026 W1 to W78)');
              return;
            }
            setError(null);
            onChange(next);
          }}
        />
        {week !== null ? (
          <span className="text-2xs font-semibold tabular-nums text-text-muted" data-numeric="">
            {formatPlanWeek(week)}
          </span>
        ) : null}
      </span>
      {message !== null ? (
        <span id={warnId} className="flex items-center gap-1 text-2xs font-semibold text-danger" data-testid="week-warning">
          <TriangleAlert className="size-3 shrink-0" aria-hidden="true" />
          {message}
        </span>
      ) : null}
    </span>
  );
}

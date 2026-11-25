import * as React from 'react';

import { formatWeek } from '@/lib/format';
import { usePlanYear } from '@/lib/plan-clock';
import { cn } from '@/lib/utils';
import { PLAN_YEAR_WEEKS, useBaseYear, weekOfYearNumber, yearOf, yearStart } from '@/lib/week-line';

/**
 * P62-F1 (owner 2026-11-25: "which year week 40 we are talking about"): a week
 * typed as week-of-year (1–52) plus an explicit year, instead of a bare number.
 *
 * The wire value is unchanged: `value` / `onChange` carry the ABSOLUTE plan
 * week of the one week line (ADR 0063, R53-1: weeks from `week_base_year` W1,
 * 2027 W1 = 53). The year list and the conversion use the SERVED base year and
 * plan year (`/me`), never the browser clock. Label arithmetic only (I9).
 *
 * An out-of-range week (0, 53, 1.5…) is reported as `NaN` so the caller's
 * validation refuses it; it is never silently turned into another year's week.
 * Before `/me` resolves (isolated tests) the field falls back to the plain
 * absolute week number.
 */
export interface WeekYearInputProps {
  id: string;
  label: string;
  /** Accessible name of the week number field; the year select gets "Year for <aria>". */
  aria: string;
  value: number | null;
  invalid?: boolean;
  disabled?: boolean;
  onChange: (absoluteWeek: number | null) => void;
  className?: string;
}

/**
 * P62-F1: under a field that takes the absolute plan week (counted from week 1
 * of the first plan year), the typed number read back as "= W5 '27", so the
 * year is never implicit. Nothing for a blank or non-week entry.
 */
export function ResolvedWeekHint({ raw, id }: { raw: unknown; id?: string }): React.JSX.Element | null {
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  if (text === '') return null;
  const n = Number(text);
  if (!Number.isInteger(n) || n < 1) return null;
  return (
    <span id={id} className="text-2xs font-medium text-text-muted" data-testid="resolved-week" aria-live="polite">
      = {formatWeek(n)}
    </span>
  );
}

const FIELD =
  'h-8 rounded border border-border-strong bg-surface px-2 text-xs tabular-nums text-text placeholder:text-text-subtle focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 aria-[invalid=true]:border-danger';

function isWeek(v: number | null): v is number {
  return v !== null && Number.isFinite(v) && v >= 1;
}

export function WeekYearInput({ id, label, aria, value, invalid = false, disabled, onChange, className }: WeekYearInputProps): React.JSX.Element {
  const planYear = usePlanYear();
  const base = useBaseYear() ?? planYear;

  const [text, setText] = React.useState(isWeek(value) ? String(weekOfYearNumber(value)) : '');
  const [chosenYear, setChosenYear] = React.useState<number | null>(null);
  // Adopt a value set from outside (a refetch, a status change that clears it);
  // a NaN this field emitted itself keeps the typed text.
  const [prev, setPrev] = React.useState<number | null>(value);
  if (!Object.is(prev, value)) {
    setPrev(value);
    if (value === null) setText('');
    else if (isWeek(value)) setText(String(weekOfYearNumber(value)));
  }

  if (base === null) {
    return (
      <div className={cn('flex flex-col gap-0.5', className)}>
        <label htmlFor={id} className="text-2xs text-text-muted">
          {label}
        </label>
        <input
          id={id}
          type="number"
          min={1}
          inputMode="numeric"
          placeholder="W"
          value={value === null || !Number.isFinite(value) ? '' : String(value)}
          disabled={disabled}
          onChange={(e) => {
            const raw = e.target.value.trim();
            onChange(raw === '' ? null : Number(raw));
          }}
          aria-label={aria}
          aria-invalid={invalid ? true : undefined}
          className={cn(FIELD, 'text-right')}
        />
      </div>
    );
  }

  const year = isWeek(value) ? yearOf(value, base) : (chosenYear ?? planYear ?? base);
  const lastYear = Math.max((planYear ?? base) + 1, year);
  const years: number[] = [];
  for (let y = base; y <= lastYear; y += 1) years.push(y);

  const emit = (rawText: string, y: number) => {
    const raw = rawText.trim();
    if (raw === '') {
      onChange(null);
      return;
    }
    const n = Number(raw);
    onChange(Number.isInteger(n) && n >= 1 && n <= PLAN_YEAR_WEEKS ? yearStart(y, base) + n - 1 : Number.NaN);
  };

  const resolved = isWeek(value) ? formatWeek(value) : null;
  const hintId = `${id}-resolved`;

  return (
    <div className={cn('flex flex-col gap-0.5', className)}>
      <label htmlFor={id} className="text-2xs text-text-muted">
        {label}
      </label>
      <div className="flex items-center gap-1">
        <span className="text-2xs text-text-subtle" aria-hidden="true">
          W
        </span>
        <input
          id={id}
          type="number"
          min={1}
          max={PLAN_YEAR_WEEKS}
          inputMode="numeric"
          placeholder="1–52"
          value={text}
          disabled={disabled}
          onChange={(e) => {
            setText(e.target.value);
            emit(e.target.value, year);
          }}
          aria-label={aria}
          aria-describedby={resolved ? hintId : undefined}
          aria-invalid={invalid ? true : undefined}
          className={cn(FIELD, 'w-14 text-right')}
        />
        <select
          value={String(year)}
          disabled={disabled}
          onChange={(e) => {
            const y = Number(e.target.value);
            setChosenYear(y);
            emit(text, y);
          }}
          aria-label={`Year for ${aria.charAt(0).toLowerCase()}${aria.slice(1)}`}
          className={cn(FIELD, 'w-[4.5rem] px-1')}
        >
          {years.map((y) => (
            <option key={y} value={y}>
              {y}
            </option>
          ))}
        </select>
      </div>
      {resolved ? (
        <span id={hintId} className="text-2xs text-text-subtle" data-testid={`${id}-resolved`}>
          {resolved}
        </span>
      ) : null}
    </div>
  );
}

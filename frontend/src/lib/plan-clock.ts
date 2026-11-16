import type { MeResponse, PlanWeek } from '@/lib/api/session';
import { useSessionStore } from '@/stores/session';

/**
 * P37 (ADR 0052, API_CONTRACT_P37 §1): the plan clock as SERVED by `GET /me`.
 *
 * The week, the weeks left, today's date and the planning year all come from
 * the server (Europe/Athens, or the `RPD_CURRENT_WEEK` pin). The browser never
 * derives any of them from its own clock, and there is no week or year
 * constant in the app any more (P32 finding F9). `<PlanClockSync>` keeps `/me`
 * fresh (at `week_ends_at`, on focus, and while the plan is behind).
 *
 * Two weeks exist (ADR 0052 §4): the CALENDAR week (`week`, for "now" markers,
 * facts and the remaining year) and the active run's week
 * (`planWeek.run_week`, for reading a stored run). The UI never subtracts one
 * from the other; it only shows both when they differ.
 */
export interface PlanClock {
  /** The calendar week, 1..52. */
  week: number;
  /** `52 − week`, served. */
  weeksLeft: number;
  /** Today in Europe/Athens, `YYYY-MM-DD`. */
  asOfDate: string;
  planYear: number;
  /** The year work past W52 spills into. A label: `plan_year + 1`. */
  spilloverYear: number;
  /** The year unfinished projects were carried over from. A label: `plan_year − 1`. */
  carryOverYear: number;
  closed: boolean;
  source: 'calendar' | 'pinned';
  weekEndsAt: string;
  planWeek: PlanWeek | null;
}

/** The served plan clock for a `/me` payload. Year labels are the served year ± 1. */
export function planClockFrom(me: MeResponse): PlanClock {
  return {
    week: me.current_week,
    weeksLeft: me.weeks_left_in_year,
    asOfDate: me.as_of_date,
    planYear: me.plan_year,
    spilloverYear: me.plan_year + 1,
    carryOverYear: me.plan_year - 1,
    closed: me.plan_year_closed,
    source: me.week_source,
    weekEndsAt: me.week_ends_at,
    planWeek: me.plan_week,
  };
}

/**
 * The served plan clock, or null before `/me` has resolved. Every surface
 * renders under `<SessionGate>`, so null only happens in isolated tests.
 */
export function usePlanClock(): PlanClock | null {
  const me = useSessionStore((s) => s.me);
  // `planClockFrom` is cheap; the fields are primitives the callers read.
  return me ? planClockFrom(me) : null;
}

/** The served calendar week, or null before `/me` has resolved. */
export function useCurrentWeek(): number | null {
  return useSessionStore((s) => s.me?.current_week ?? null);
}

/** The served planning year, or null before `/me` has resolved. */
export function usePlanYear(): number | null {
  return useSessionStore((s) => s.me?.plan_year ?? null);
}

/** Year words for copy, from the served `plan_year`. Before `/me` resolves
 *  they read "the plan year" / "next year" / "last year" instead of a number. */
export interface PlanYearLabels {
  planYear: string;
  spilloverYear: string;
  carryOverYear: string;
}

export function planYearLabels(planYear: number | null): PlanYearLabels {
  if (planYear === null) return { planYear: 'the plan year', spilloverYear: 'next year', carryOverYear: 'last year' };
  return { planYear: String(planYear), spilloverYear: String(planYear + 1), carryOverYear: String(planYear - 1) };
}

export function usePlanYearLabels(): PlanYearLabels {
  return planYearLabels(usePlanYear());
}

/**
 * The active run is behind the calendar week (R37-6: weeks differ ⇔ status
 * is not `current`). Null when there is no active run or it is current.
 */
export function planBehind(clock: PlanClock | null): PlanWeek | null {
  const pw = clock?.planWeek ?? null;
  return pw && pw.status !== 'current' ? pw : null;
}

/** "16 Nov 2026" for a served `YYYY-MM-DD`, formatted in UTC so the browser's
 *  timezone can never move the day. */
export function formatServedDate(isoDate: string): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  if (y === undefined || m === undefined || d === undefined || [y, m, d].some(Number.isNaN)) return isoDate;
  return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(Date.UTC(y, m - 1, d)),
  );
}

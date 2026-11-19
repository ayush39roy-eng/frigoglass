import { formatWeek } from '@/lib/format';
import { roundUpToYearEnd } from '@/lib/week-line';

import type { ImportOptions } from './import-rows';
import type { ImportSimulateResponse, PlanWeekChoice, PrioritySource } from './import-types';
import { planYearOf } from './week-labels';

/**
 * P50 (ADR 0061, R49-7..R49-21, I54/I56): the "Plan from" / "Plan until" window of a plan
 * import. Display and request plumbing only: the server resolves, validates and labels the
 * window (I40: the browser derives no dates), and every "within" figure is served against
 * its `plan_until_week`.
 */

type CutoffFields = Pick<ImportSimulateResponse, 'plan_year_end_week' | 'plan_until_week'>;

/** The served cut-off of every "within" figure: `plan_until_week`, else (pre-P50) `plan_year_end_week`. */
export function cutoffWeek(r: CutoffFields): number {
  return r.plan_until_week ?? r.plan_year_end_week;
}

export interface PlanScope {
  /** True when the server served a window label (the request set a u other than the preset). */
  windowed: boolean;
  /** "2027" or "the plan window" ("slipping out of …", "End of …"). */
  name: string;
  /** "in 2027" or "within the plan window" ("Finish …"). */
  inPhrase: string;
  /** "within the plan year" or "within the plan window". */
  withinWords: string;
  /** The served "W48 2026 – W20 2027", or null. */
  windowLabel: string | null;
  cutoffWeek: number;
}

/** The wording of a result's cut-off (R49-18): the plan year unless a window label is served. */
export function planScope(
  r: CutoffFields & Pick<ImportSimulateResponse, 'base_year' | 'plan_window_label'>,
): PlanScope {
  const cutoff = cutoffWeek(r);
  const label = r.plan_window_label ?? null;
  if (label !== null) {
    return {
      windowed: true,
      name: 'the plan window',
      inPhrase: 'within the plan window',
      withinWords: 'within the plan window',
      windowLabel: label,
      cutoffWeek: cutoff,
    };
  }
  const year = String(planYearOf(cutoff, r.base_year));
  return {
    windowed: false,
    name: year,
    inPhrase: `in ${year}`,
    withinWords: 'within the plan year',
    windowLabel: null,
    cutoffWeek: cutoff,
  };
}

/** The served label of an absolute week from `choices`, else the week-of-year label (never W53+). */
export function choiceLabel(choices: readonly PlanWeekChoice[] | undefined, week: number): string {
  return choices?.find((c) => c.week === week)?.label ?? formatWeek(week);
}

/** P53 (R53-4): the chosen "Plan year" end, else the server default — the end
 *  of the year of `minWeek` (today's week; `year_end(year_of(cw))`, the week-line
 *  mirror, I57). */
export function planYearEnd(options: Pick<ImportOptions, 'planYearEndWeek'>, minWeek: number | null): number | null {
  return options.planYearEndWeek ?? (minWeek === null ? null : roundUpToYearEnd(minWeek));
}

/** The "Plan until" in force: the chosen u, else the plan-year end. */
export function effectiveUntil(
  options: Pick<ImportOptions, 'planYearEndWeek' | 'planUntilWeek'>,
  minWeek: number | null = null,
): number {
  return options.planUntilWeek ?? planYearEnd(options, minWeek) ?? Number.POSITIVE_INFINITY;
}

export interface PickerChoices {
  from: PlanWeekChoice[];
  until: PlanWeekChoice[];
  /** The week "Plan from" shows (the chosen one, else today's). */
  fromWeek: number;
}

/**
 * The two pickers' options from the served choices (R49-7 / R49-15): Plan from = min..u
 * (u = the chosen Plan until, else the plan-year end), Plan until = f..H without the
 * preset week itself (that is the "end of the plan year" default entry). P53 (R53-4):
 * the upper bound is the served search limit — the server serves the choices only up to
 * H, so no week bound is held here. A chosen week outside its bounds is still listed so
 * the select names what is set.
 */
export function pickerChoices(
  choices: readonly PlanWeekChoice[],
  minWeek: number,
  options: Pick<ImportOptions, 'planYearEndWeek' | 'planFromWeek' | 'planUntilWeek'>,
): PickerChoices {
  const fromWeek = options.planFromWeek ?? minWeek;
  const until = effectiveUntil(options, minWeek);
  const preset = planYearEnd(options, minWeek);
  return {
    fromWeek,
    from: choices.filter((c) => (c.week >= minWeek && c.week <= until) || c.week === fromWeek),
    until: choices.filter(
      (c) => c.week !== preset && (c.week >= fromWeek || c.week === options.planUntilWeek),
    ),
  };
}

/** Why the window cannot be sent (I56 `cw ≤ f ≤ u ≤ H`), or null. The server stays the authority. */
export function windowBlockedReason(
  options: Pick<ImportOptions, 'planYearEndWeek' | 'planFromWeek' | 'planUntilWeek' | 'planWindowRerun'>,
  minWeek: number | null,
): string | null {
  if (options.planWindowRerun) return null;
  const f = options.planFromWeek ?? null;
  if (f === null) return null;
  if (minWeek !== null && f < minWeek) return 'The “Plan from” week has passed. Pick this week or a later one.';
  if (f > effectiveUntil(options, minWeek))
    return options.planUntilWeek == null
      ? '“Plan from” is after the end of the plan year. Pick a later “Plan until” or an earlier “Plan from”.'
      : '“Plan from” is after “Plan until”. Pick a later “Plan until” or an earlier “Plan from”.';
  return null;
}

/** The planner's window options from a served result (after a re-run raised them). */
export function windowOptionsOf(
  result: Pick<
    ImportSimulateResponse,
    'plan_from_week' | 'plan_from_min_week' | 'plan_until_week' | 'current_week' | 'plan_year_end_week'
  >,
  planYearEndWeek: number | null,
): Pick<ImportOptions, 'planFromWeek' | 'planUntilWeek' | 'planWindowRerun'> {
  // P53: null = the server default, which the result names as its plan-year end.
  const preset = planYearEndWeek ?? result.plan_year_end_week;
  const min = result.plan_from_min_week ?? result.current_week;
  const f = result.plan_from_week ?? null;
  const u = result.plan_until_week ?? null;
  return {
    planFromWeek: f === null || f === min ? null : f,
    planUntilWeek: u === null || u === preset ? null : u,
    planWindowRerun: false,
  };
}

/** "From Must Do / band column", "rank 3", … — the Review table's priority hint per source. */
export const PRIORITY_SOURCE_LABEL: Record<Exclude<PrioritySource, 'rank'>, string> = {
  band: 'From Must Do / band column',
  running: 'running',
  matched: 'from plan',
  default: 'default',
};

/** A file row's served (`file_band`, `rank`) under a band: "rank 3 in band" order hint. */
export function bandHint(rank: number | null): string {
  return rank === null ? PRIORITY_SOURCE_LABEL.band : `${PRIORITY_SOURCE_LABEL.band} · rank ${String(rank)} in band`;
}

/** "Plan from W47 to W52 '27" for a saved scenario (stored f and u, week-of-year labels). */
export function savedWindowText(s: {
  plan_from_week?: number | undefined;
  plan_until_week?: number | undefined;
}): string | null {
  if (s.plan_from_week === undefined || s.plan_until_week === undefined) return null;
  return `Plan from ${formatWeek(s.plan_from_week)} to ${formatWeek(s.plan_until_week)}`;
}

/** P50 issue codes with a short heading for the issue lists (the message stays the server's). */
export const PLAN_IMPORT_ISSUE_TITLES: Readonly<Record<string, string>> = {
  BAND_VALUE_INVALID: 'Band column not Yes / No',
  PRIORITY_BAND_CONFLICT: 'Several band columns say Yes',
  PRIORITY_BAND_OVER_RANK: 'Band column overrides the rank',
  PRIORITY_BAND_OVER_PLAN: 'Band differs from the plan',
  PLAN_FROM_LATER: 'File projects start later',
  PLAN_FROM_RAISED: 'Plan from moved to this week',
  PLAN_UNTIL_RAISED: 'Plan until moved',
};

/**
 * Year-aware week labels for the plan import (ADR 0044 §7): weeks are absolute
 * (`1..52` = `base_year`, `53..104` = `base_year + 1`, …). Formatting only — the
 * week numbers are the server's fields.
 */

const WEEKS_PER_YEAR = 52;

export function weekYear(week: number, baseYear: number): { year: number; week: number } {
  const zero = Math.max(0, Math.floor(week) - 1);
  return {
    year: baseYear + Math.floor(zero / WEEKS_PER_YEAR),
    week: (zero % WEEKS_PER_YEAR) + 1,
  };
}

/** "W5 '27" — the short axis / cell label. */
export function shortWeekLabel(week: number, baseYear: number): string {
  const yw = weekYear(week, baseYear);
  return `W${String(yw.week)} '${String(yw.year % 100).padStart(2, '0')}`;
}

/** "2027 W5" — the long label (tooltips, screen readers). */
export function longWeekLabel(week: number, baseYear: number): string {
  const yw = weekYear(week, baseYear);
  return `${String(yw.year)} W${String(yw.week)}`;
}

/** A nullable served week, "—" when the project has none. */
export function weekOrDash(week: number | null, baseYear: number): string {
  return week === null ? '—' : shortWeekLabel(week, baseYear);
}

/** The year a plan-year end week closes ("2027" for 104 with base 2026). */
export function planYearOf(planYearEndWeek: number, baseYear: number): number {
  return weekYear(planYearEndWeek, baseYear).year;
}

/**
 * Axis ticks between `from` and `to` (inclusive): every `every` weeks counted from
 * each year's W1, plus the first week of each year, plus `from` itself.
 */
export function axisTicks(
  from: number,
  to: number,
  baseYear: number,
  every = 4,
): { week: number; label: string; yearStart: boolean }[] {
  const out: { week: number; label: string; yearStart: boolean }[] = [];
  for (let w = from; w <= to; w += 1) {
    const yw = weekYear(w, baseYear);
    const yearStart = yw.week === 1;
    const crowded = w !== from && !yearStart && w - from < Math.ceil(every / 2) + 1;
    if (w === from || yearStart || ((yw.week - 1) % every === 0 && !crowded)) {
      out.push({ week: w, label: shortWeekLabel(w, baseYear), yearStart });
    }
  }
  return out;
}

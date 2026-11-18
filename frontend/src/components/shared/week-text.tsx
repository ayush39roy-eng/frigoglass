import * as React from 'react';

import { formatWeek, weekTitleIfNextYear } from '@/lib/format';

/**
 * A served absolute week as text (owner rule 2026-11-18): `W47`, or `W5 '27`
 * for a week past W52 with "Week 5 of 2027" on hover. Display only — the
 * week itself is the server's field.
 */
export function WeekText({
  week,
  className,
  title,
}: {
  week: number;
  className?: string;
  /** Overrides the default hover text (the year of a next-year week). */
  title?: string;
}): React.JSX.Element {
  return (
    <span className={className} title={title ?? weekTitleIfNextYear(week)}>
      {formatWeek(week)}
    </span>
  );
}

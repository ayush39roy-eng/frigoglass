import { afterEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { seedSession } from '@/test/session';

import { makeWeekScale, weekToX } from '../lib/gantt-coordinates';
import { GanttWeekAxis, GanttYearRow } from './gantt-time-axis';

afterEach(() => {
  seedSession(null);
});

describe('GanttWeekAxis "now" line (P37)', () => {
  it('sits at the served calendar week', () => {
    seedSession({ current_week: 47, weeks_left_in_year: 5 });
    const scale = makeWeekScale('weeks');
    const { container } = render(<GanttWeekAxis scale={scale} />);
    expect(screen.getByText('W47 now')).toBeInTheDocument();
    const x = String(weekToX(47, scale));
    expect(container.querySelector(`line[x1="${x}"][x2="${x}"]`)).not.toBeNull();
  });

  it('draws no "now" line before /me has resolved', () => {
    seedSession(null);
    render(<GanttWeekAxis scale={makeWeekScale('weeks')} />);
    expect(screen.queryByText(/now$/)).not.toBeInTheDocument();
  });
});

describe('P51 (ADR 0062): year header row and an axis past W52', () => {
  const scale = makeWeekScale(16, 130);

  function tickLabel(tick: Element): string {
    return tick.lastChild?.textContent ?? '';
  }

  it('labels each calendar year from the served plan year, spanning its weeks', () => {
    seedSession({ plan_year: 2026 });
    render(<GanttYearRow scale={scale} baseYear={2026} />);
    const bands = screen.getAllByTestId('gantt-year-band');
    expect(bands.map((b) => b.textContent)).toEqual(['2026', '2027', '2028']);
    expect(bands.map((b) => [b.getAttribute('data-start-week'), b.getAttribute('data-end-week')])).toEqual([
      ['1', '52'],
      ['53', '104'],
      ['105', '130'],
    ]);
    expect(bands[2]).toHaveStyle({ width: `${String(26 * 16)}px` });
    // Only the years after the plan year are shaded.
    expect(bands[0]?.style.background).toBe('');
    expect(bands[1]?.style.background).not.toBe('');
  });

  it('reads "Plan year" / "Next year" before /me resolves, and clips to an origin past W1', () => {
    render(<GanttYearRow scale={{ originWeek: 42, horizonWeeks: 30, weekWidthPx: 10, totalWidthPx: 300 }} baseYear={null} />);
    const bands = screen.getAllByTestId('gantt-year-band');
    expect(bands.map((b) => b.textContent)).toEqual(['Plan year', 'Next year']);
    expect(bands[0]).toHaveStyle({ width: '110px' });
    expect(bands[1]).toHaveAttribute('title', 'Next year: week 1 to week 19');
  });

  it('week ticks past W52 restart at 1 and never print a week ≥ 53; hover names the year', () => {
    seedSession({ plan_year: 2026 });
    render(<GanttWeekAxis scale={scale} />);
    const axis = screen.getByRole('img', { name: 'Week axis, Week 1 of 2026 to Week 26 of 2028' });
    const ticks = screen.getAllByTestId('gantt-week-tick');
    expect(ticks.length).toBeGreaterThan(26);
    for (const t of ticks) expect(Number(tickLabel(t))).toBeLessThanOrEqual(52);
    const w105 = ticks.find((t) => t.getAttribute('data-week') === '105');
    expect(w105 && tickLabel(w105)).toBe('1');
    expect(w105?.querySelector('title')).toHaveTextContent('Week 1 of 2028');
    expect(axis.textContent).not.toMatch(/\b(5[3-9]|[6-9]\d|1\d\d)\b/);
  });
});

describe('P53 (R53-6): plan year 2027 on the one week line', () => {
  it('"now" reads the week of its year and the year-end line sits at the served plan-year end', () => {
    seedSession({ current_week: 57, weeks_left_in_year: 47, plan_year: 2027, plan_year_start_week: 53, plan_year_end_week: 104 });
    const scale = makeWeekScale(16, 104, 53);
    render(<GanttWeekAxis scale={scale} />);
    expect(screen.getByText('W5 now')).toBeInTheDocument();
    expect(screen.getByTestId('gantt-year-end-label')).toHaveTextContent('W52 year-end');
  });

  it('year bands are labelled from the base year, with years after the plan year shaded', () => {
    render(<GanttYearRow scale={makeWeekScale(16, 156, 53)} baseYear={2026} planYearOffset={1} />);
    const bands = screen.getAllByTestId('gantt-year-band');
    expect(bands.map((b) => b.textContent)).toEqual(['2027', '2028', '2029']);
    expect(bands[0]?.style.background).toBe('');
    expect(bands[1]?.style.background).not.toBe('');
  });
});

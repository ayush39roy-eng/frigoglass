import { afterEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { seedSession } from '@/test/session';

import { makeWeekScale, weekToX } from '../lib/gantt-coordinates';
import { GanttWeekAxis } from './gantt-time-axis';

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

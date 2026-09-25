import type * as React from 'react';
import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';

import { makeWeekScale, WEEK_WIDTH_PX } from '../lib/gantt-coordinates';
import { GANTT_HATCH_PATTERN_ID, GanttBarGroup, GanttHatchDefs } from './gantt-bars';

const scale = makeWeekScale('weeks');
const w = WEEK_WIDTH_PX.weeks;

function renderGroup(props: Partial<React.ComponentProps<typeof GanttBarGroup>>) {
  return render(
    <svg>
      <GanttHatchDefs />
      <GanttBarGroup
        scale={scale}
        y={0}
        rowHeight={40}
        planned={{ startWeek: 5, endWeek: 8 }}
        actual={null}
        plannedEndWeek={8}
        delayedEndWeek={null}
        frozen={false}
        title="Test bar"
        {...props}
      />
    </svg>,
  );
}

describe('GanttBarGroup', () => {
  it('renders a solid planned bar positioned purely from the week numbers', () => {
    const { container } = renderGroup({});
    const rects = [...container.querySelectorAll('rect')];
    const planned = rects.find((r) => r.getAttribute('x') === String(4 * w));
    expect(planned).toBeTruthy();
    expect(planned?.getAttribute('width')).toBe(String(4 * w)); // weeks 5..8 inclusive
  });

  it('a delayed project renders the hatched actual bar AND a red delay connector', () => {
    const { container } = renderGroup({
      actual: { startWeek: 5, endWeek: 11 },
      plannedEndWeek: 8,
      delayedEndWeek: 11,
    });
    const hatched = [...container.querySelectorAll('rect')].find(
      (r) => r.getAttribute('fill') === `url(#${GANTT_HATCH_PATTERN_ID})`,
    );
    expect(hatched).toBeTruthy();

    const connector = [...container.querySelectorAll('line')].find(
      (l) => l.getAttribute('stroke') === 'hsl(var(--color-gantt-delay))',
    );
    expect(connector).toBeTruthy();
    // connector starts at the planned end edge (end of week 8) …
    expect(connector?.getAttribute('x1')).toBe(String(8 * w));
    // … and runs to the delayed end edge (end of week 11): 3 weeks of delay
    expect(connector?.getAttribute('x2')).toBe(String(11 * w));

    // arrowhead
    expect(container.querySelector('path')).toBeTruthy();
  });

  it('a frozen project bar is drawn with the frozen fill token', () => {
    const { container } = renderGroup({ frozen: true });
    const planned = [...container.querySelectorAll('rect')].find(
      (r) => r.getAttribute('x') === String(4 * w),
    );
    expect(planned?.getAttribute('fill')).toBe('hsl(var(--color-gantt-planned-frozen))');
  });

  it('renders nothing when there are no planned or actual weeks', () => {
    const { container } = renderGroup({ planned: null, actual: null, plannedEndWeek: null });
    expect(container.querySelectorAll('rect')).toHaveLength(1); // only the <pattern> backdrop rect
  });
});

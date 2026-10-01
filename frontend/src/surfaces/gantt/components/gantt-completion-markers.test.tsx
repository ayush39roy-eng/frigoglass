import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { makeWeekScale, WEEK_WIDTH_PX, completionMarkerX, slipBracketGeometry } from '../lib/gantt-coordinates';
import { GanttCompletionMarkers } from './gantt-completion-markers';
import { expectedLabel, slipLabel } from '../lib/completion-labels';

const scale = makeWeekScale('weeks');
const w = WEEK_WIDTH_PX.weeks;

describe('completion-marker geometry (pure, from server week numbers only)', () => {
  it('a completion marker sits on the END edge of its week — the year-end convention', () => {
    // done by end of week 40 → start edge of week 41
    expect(completionMarkerX(40, scale)).toBe(40 * w);
  });

  it('slip bracket spans the two markers regardless of order and is null when they coincide or are missing', () => {
    expect(slipBracketGeometry(40, 44, scale)).toEqual({ x: 40 * w, width: 4 * w });
    expect(slipBracketGeometry(44, 40, scale)).toEqual({ x: 40 * w, width: 4 * w });
    expect(slipBracketGeometry(40, 40, scale)).toBeNull();
    expect(slipBracketGeometry(null, 40, scale)).toBeNull();
    expect(slipBracketGeometry(40, undefined, scale)).toBeNull();
  });

  it('labels come from the API sign, never recomputed', () => {
    expect(slipLabel(4)).toBe('+4 wk');
    expect(slipLabel(-3)).toBe('−3 wk');
    expect(slipLabel(0)).toBe('0 wk');
    expect(expectedLabel(null)).toBe('Expected (process-derived)');
    expect(expectedLabel(40)).toBe('Expected (target)');
  });
});

function renderMarkers(props: Partial<React.ComponentProps<typeof GanttCompletionMarkers>>) {
  return render(
    <svg>
      <GanttCompletionMarkers
        scale={scale}
        rowHeight={40}
        projectName="Cooler A"
        targetEndWeek={40}
        expectedEndWeek={40}
        projectedEndWeek={44}
        slipWeeks={4}
        {...props}
      />
    </svg>,
  );
}

describe('GanttCompletionMarkers', () => {
  it('draws two lines at the server weeks with distinct colours AND dash patterns (colour never the only signal)', () => {
    const { container } = renderMarkers({});
    const expected = container.querySelector('[data-testid="gantt-marker-expected"] line');
    const projected = container.querySelector('[data-testid="gantt-marker-projected"] line');
    expect(expected?.getAttribute('x1')).toBe(String(40 * w));
    expect(projected?.getAttribute('x1')).toBe(String(44 * w));
    expect(expected?.getAttribute('stroke')).toBe('hsl(var(--color-gantt-expected))');
    expect(projected?.getAttribute('stroke')).toBe('hsl(var(--color-gantt-projected))');
    expect(expected?.getAttribute('stroke-dasharray')).toBeNull();
    expect(projected?.getAttribute('stroke-dasharray')).toBe('5 2 1.5 2');
    // neither line is the red delay token
    expect(expected?.getAttribute('stroke')).not.toContain('delay');
    expect(projected?.getAttribute('stroke')).not.toContain('delay');
  });

  it('brackets the two with the +N wk label from slip_weeks, tinted late', () => {
    const { container } = renderMarkers({});
    const bracket = screen.getByTestId('gantt-slip-bracket');
    expect(bracket).toHaveTextContent('+4 wk');
    expect(bracket.querySelector('text')?.getAttribute('fill')).toBe('hsl(var(--color-danger))');
    const line = container.querySelector('[data-testid="gantt-slip-bracket"] line');
    expect(line?.getAttribute('x1')).toBe(String(40 * w));
    expect(line?.getAttribute('x2')).toBe(String(44 * w));
  });

  it('an early project gets a −N wk label tinted early', () => {
    renderMarkers({ expectedEndWeek: 44, projectedEndWeek: 40, slipWeeks: -4 });
    const bracket = screen.getByTestId('gantt-slip-bracket');
    expect(bracket).toHaveTextContent('−4 wk');
    expect(bracket.querySelector('text')?.getAttribute('fill')).toBe('hsl(var(--color-success))');
  });

  it('draws only the expected line when the project is left out (projected null) and no bracket', () => {
    renderMarkers({ projectedEndWeek: null, slipWeeks: null });
    expect(screen.getByTestId('gantt-marker-expected')).toBeInTheDocument();
    expect(screen.queryByTestId('gantt-marker-projected')).not.toBeInTheDocument();
    expect(screen.queryByTestId('gantt-slip-bracket')).not.toBeInTheDocument();
  });

  it('names both weeks and the expected-line basis in the accessible description', () => {
    renderMarkers({ targetEndWeek: null, expectedEndWeek: 38, projectedEndWeek: 44, slipWeeks: 6 });
    expect(
      screen.getByRole('img', {
        name: 'Cooler A · Expected (process-derived) W38 · will be completed W44 · slip +6 wk',
      }),
    ).toBeInTheDocument();
  });

  it('renders nothing when neither week exists', () => {
    const { container } = renderMarkers({ expectedEndWeek: null, projectedEndWeek: null, slipWeeks: null });
    expect(container.querySelector('[data-testid="gantt-completion-markers"]')).toBeNull();
  });
});

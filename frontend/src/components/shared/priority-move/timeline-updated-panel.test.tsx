import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';

import type { ScheduleRunChangeRow, ScheduleRunChanges } from '@/lib/api/priority-move';

// jsdom has no layout, so a real virtualizer would render zero rows. Stub it
// to "render the first N" so the virtualized branch is still observable.
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count, estimateSize }: { count: number; estimateSize: () => number }) => ({
    getTotalSize: () => count * estimateSize(),
    getVirtualItems: () =>
      Array.from({ length: Math.min(count, 10) }, (_, index) => ({ index, start: index * estimateSize(), key: index })),
  }),
}));

import { TimelineUpdatedPanel } from './timeline-updated-panel';

function row(overrides: Partial<ScheduleRunChangeRow> = {}): ScheduleRunChangeRow {
  return {
    project_id: 'p9',
    project_name: 'Other Cooler',
    hub: 'R&D-Greece',
    priority: 'P3',
    before_projected_end_week: 30,
    after_projected_end_week: 33,
    delta_weeks: 3,
    before_within_year: true,
    after_within_year: true,
    before_left_out: false,
    after_left_out: false,
    before_blocked: false,
    after_blocked: false,
    is_new: false,
    is_removed: false,
    ...overrides,
  };
}

function changes(rows: ScheduleRunChangeRow[], hidden = 0): ScheduleRunChanges {
  return { run_id: 'r2', run_version: 8, against_run_id: 'r1', against_run_version: 7, hidden_count: hidden, rows };
}

function renderPanel(data: ScheduleRunChanges) {
  return render(
    <TimelineUpdatedPanel changes={data} projectId="p1" projectName="Cooler One" priorityBefore="P1" priorityAfter="P2" />,
  );
}

describe('TimelineUpdatedPanel', () => {
  it('prints each served row verbatim: weeks, delta and flag flips', () => {
    renderPanel(
      changes([
        row({ project_id: 'a', project_name: 'Spills Now', before_projected_end_week: 50, after_projected_end_week: 54, delta_weeks: 4, before_within_year: true, after_within_year: false }),
        row({ project_id: 'b', project_name: 'Dropped Out', before_projected_end_week: 60, after_projected_end_week: null, delta_weeks: null, before_left_out: false, after_left_out: true }),
        row({ project_id: 'c', project_name: 'Now Held', before_blocked: false, after_blocked: true, delta_weeks: -2, after_projected_end_week: 28 }),
      ]),
    );
    const rows = screen.getAllByTestId('timeline-change-row');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('W50');
    // ADR 0024: a week past W52 prints "After W52", never W54.
    expect(rows[0]).toHaveTextContent('After W52');
    expect(rows[0]).not.toHaveTextContent('W54');
    expect(rows[0]).toHaveTextContent('+4 wk');
    expect(rows[0]).toHaveTextContent('Within year');
    expect(rows[0]).toHaveTextContent('Past W52');
    // A null projected week prints as "—", and a null delta prints no chip.
    expect(rows[1]).toHaveTextContent('—');
    expect(rows[1]).not.toHaveTextContent(/wk/);
    expect(rows[1]).toHaveTextContent('Spillover · unplaced');
    expect(rows[2]).toHaveTextContent('−2 wk');
    expect(rows[2]).toHaveTextContent('On hold at a stage');
    expect(screen.getByText(/Run v8 compared with v7/)).toBeInTheDocument();
  });

  it('when the moved project is not among the rows, says its finish did not change', () => {
    renderPanel(changes([row()]));
    expect(screen.getByTestId('timeline-own-change')).toHaveTextContent("This project's finish week did not change.");
  });

  it('with no other visible rows, says so, and still shows the hidden count', () => {
    renderPanel(changes([row({ project_id: 'p1', project_name: 'Cooler One' })], 5));
    expect(screen.getByText('No other project you can see moved.')).toBeInTheDocument();
    expect(screen.getByTestId('timeline-hidden-count')).toHaveTextContent('+5 more in hubs outside your scope');
  });

  it('hides the hidden-count line when hidden_count is 0', () => {
    renderPanel(changes([row()], 0));
    expect(screen.queryByTestId('timeline-hidden-count')).not.toBeInTheDocument();
  });

  it('marks new / removed outcome rows', () => {
    renderPanel(changes([row({ project_id: 'n', is_new: true, before_projected_end_week: null, delta_weeks: null }), row({ project_id: 'r', is_removed: true })]));
    expect(screen.getByText('New in this run')).toBeInTheDocument();
    expect(screen.getByText('Not in this run')).toBeInTheDocument();
  });

  it('virtualizes a list of more than 100 rows', () => {
    const many = Array.from({ length: 140 }, (_, i) => row({ project_id: `x${String(i)}`, project_name: `Project ${String(i)}` }));
    renderPanel(changes(many));
    const list = screen.getByTestId('timeline-change-list');
    expect(list).toHaveAttribute('data-virtualized', 'true');
    // Only the virtualizer's window is in the DOM, not all 140.
    expect(within(list).getAllByTestId('timeline-change-row').length).toBeLessThan(140);
    expect(screen.getByText('(140)')).toBeInTheDocument();
  });

  it('renders 100 rows or fewer without virtualization', () => {
    renderPanel(changes(Array.from({ length: 12 }, (_, i) => row({ project_id: `y${String(i)}` }))));
    expect(screen.getByTestId('timeline-change-list')).toHaveAttribute('data-virtualized', 'false');
    expect(screen.getAllByTestId('timeline-change-row')).toHaveLength(12);
  });
});

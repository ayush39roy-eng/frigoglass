import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { seedSession } from '@/test/session';
import { renderWithProviders } from '@/test/render';
import { seriousAxeViolations } from '@/test/axe';

import type { GanttProjectRow, GanttStepRow } from '../api/types';
import { makeWeekScale, WEEK_WIDTH_PX } from '../lib/gantt-coordinates';
import { roomPhrase, stepBarTitle } from '../lib/step-row-text';
import { P13_GANTT_ROW_DEFAULTS, P40_GANTT_STEP_PIN_DEFAULTS } from '../test-fixtures';
import { GanttHatchDefs } from './gantt-bars';
import { GanttLegend } from './gantt-legend';
import { StepBarGraphic, StepLeftCell } from './gantt-step-row';

/** P62 (ADR 0071, API_CONTRACT_P62 §5): the held (room) weeks of a lab step on the Gantt. */
const scale = makeWeekScale('weeks');
const W = WEEK_WIDTH_PX.weeks;

function labStep(over: Partial<GanttStepRow> = {}): GanttStepRow {
  return {
    step_id: 'PDD-J',
    step_name: 'Pre-Production (Pr. Pr)',
    kind: 'lab',
    sequence_order: 10,
    skipped: false,
    status: 'Not Started',
    percent_complete: 0,
    duration_weeks: 3,
    planned_start_week: 30,
    planned_end_week: 32,
    actual_start_week: null,
    actual_end_week: null,
    assigned_engineer_name: null,
    assigned_chamber_code: 'IN-CH4',
    eng_conflict: false,
    chamber_overlap: false,
    lead_time_weeks: 3,
    span_fte: null,
    effort_weeks: null,
    plan_weeks: 3,
    gap_weeks: 0,
    own_effort: false,
    predecessor_ids: [],
    ...P40_GANTT_STEP_PIN_DEFAULTS,
    lab_hold_weeks: 1,
    plan_lab_hold_weeks: 1,
    room_start_week: 32,
    room_end_week: 32,
    ...over,
  };
}

function project(steps: GanttStepRow[]): GanttProjectRow {
  return {
    project_id: 'p1',
    project_name: 'Cooler Alpha',
    hub: 'R&D-India',
    category: 'A',
    priority: 'P1',
    frozen: false,
    delay_weeks: 0,
    left_out: false,
    spillover: false,
    cat_not_allowed: false,
    target_end_week: null,
    expected_end_week: null,
    projected_end_week: null,
    unconstrained_end_week: null,
    slip_weeks: null,
    blocked: false,
    schedule_stale: false,
    workflow_id: 'PDD',
    is_vip: false,
    tracking_status: 'idle',
    ...P13_GANTT_ROW_DEFAULTS,
    steps,
  };
}

function renderBar(step: GanttStepRow) {
  return render(
    <svg>
      <GanttHatchDefs />
      <StepBarGraphic project={project([step])} step={step} scale={scale} height={24} />
    </svg>,
  );
}

describe('Gantt room weeks (P62)', () => {
  beforeEach(() => {
    seedSession({});
  });
  afterEach(() => {
    seedSession(null);
  });

  it('draws the served room weeks solid over a light lab bar', () => {
    const { container } = renderBar(labStep());
    const planned = container.querySelector('rect[data-bar="planned"]');
    expect(planned).toHaveAttribute('data-room-split', 'held');
    const room = container.querySelector('rect[data-bar="room"]');
    expect(room).toBeTruthy();
    // Week 32 only: one week wide, at the bar's right end.
    expect(room).toHaveAttribute('width', String(W));
    expect(Number(room?.getAttribute('x'))).toBe(Number(planned?.getAttribute('x')) + 2 * W);
  });

  it('tooltip: "Room booked W21 \'27" with the year; a range when more than one week', () => {
    expect(roomPhrase(labStep())).toBe("Room booked W32 '26");
    // Absolute week 73 is W21 of 2027.
    expect(roomPhrase(labStep({ room_start_week: 72, room_end_week: 73 }))).toBe("Room booked W20 '27–W21 '27");
    const title = stepBarTitle(labStep(), { startWeek: 30, endWeek: 32 }, null);
    expect(title).toContain("Room booked W32 '26");
    expect(roomPhrase(labStep({ kind: 'design' }))).toBeNull();
    expect(roomPhrase(labStep({ skipped: true }))).toBeNull();
  });

  it('0 room weeks: light bar only, "no room" in the tooltip and instead of a chamber', () => {
    const step = labStep({ lab_hold_weeks: 0, room_start_week: null, room_end_week: null, assigned_chamber_code: null });
    const { container } = renderBar(step);
    expect(container.querySelector('rect[data-bar="planned"]')).toHaveAttribute('data-room-split', 'none');
    expect(container.querySelector('rect[data-bar="room"]')).toBeNull();
    expect(container.querySelector('title')?.textContent).toContain('no room');
    render(<StepLeftCell step={step} />);
    expect(screen.getByText('no room')).toBeInTheDocument();
  });

  it('non-lab and pre-split rows draw as before (no room rect)', () => {
    const design = labStep({ kind: 'design', lab_hold_weeks: null, room_start_week: null, room_end_week: null });
    const { container } = renderBar(design);
    expect(container.querySelector('rect[data-bar="planned"]')).not.toHaveAttribute('data-room-split');
    expect(container.querySelector('rect[data-bar="room"]')).toBeNull();
  });

  it('legend explains solid vs light lab bars; axe clean', async () => {
    const { container } = renderWithProviders(<GanttLegend rows={[project([labStep()])]} />);
    expect(screen.getByTestId('gantt-legend-lab-room')).toHaveTextContent(
      'Lab step: solid = room booked (chamber), light = in the lab, no room booked',
    );
    expect(await seriousAxeViolations(container)).toEqual([]);
  });
});

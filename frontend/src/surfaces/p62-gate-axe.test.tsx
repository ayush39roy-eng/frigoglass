import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';

import { renderWithProviders } from '@/test/render';
import { ROLE_MATRIX } from '@/test/roles';
import { seedSession } from '@/test/session';
import type { ChamberRead } from '@/surfaces/planning/api/types';

import type { GanttProjectRow, GanttStepRow } from './gantt/api/types';
import { makeWeekScale } from './gantt/lib/gantt-coordinates';
import { P13_GANTT_ROW_DEFAULTS, P40_GANTT_STEP_PIN_DEFAULTS } from './gantt/test-fixtures';
import { GanttHatchDefs } from './gantt/components/gantt-bars';
import { StepBarGraphic, StepLeftCell } from './gantt/components/gantt-step-row';
import { timelineFixture } from './workflow-settings/test-fixtures';
import type { SavedCell } from './workflow-settings/lib/template-drafts';
import { CategoryTimelineList, ControlledCategoryTimeline } from './workflow-settings/components/category-timeline';

const api = { fetchChambers: vi.fn(), updateChamber: vi.fn() };
vi.mock('@/surfaces/planning/api/planning-api', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchChambers: (...a: unknown[]) => api.fetchChambers(...a) as unknown,
  updateChamber: (...a: unknown[]) => api.updateChamber(...a) as unknown,
}));

import { ChamberStagesGrid, type LabStepColumn } from './workflow-settings/components/chamber-stages';

/**
 * P62-T07 (qa-inspector gate): axe over the new P62 UI, counting EVERY impact
 * level (minor / moderate / serious / critical), not only the serious filter of
 * `@/test/axe`. `color-contrast` is off (jsdom has no layout) and `region` off
 * (component in isolation), exactly as the shared helper.
 */
async function allAxeViolations(node: Element): Promise<string[]> {
  const result = await axe.run(node, {
    rules: { 'color-contrast': { enabled: false }, region: { enabled: false } },
    resultTypes: ['violations'],
  });
  return result.violations.map(
    (v) => `${v.id} (${v.impact ?? 'unknown'}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
  );
}

// --- Room control (template timeline editor) --------------------------------

function roomTimeline(category = 'A+') {
  return timelineFixture(
    category,
    {
      'PDD-J': { resource_kind: 'lab', duration_weeks: 3, lab_hold_weeks: 1, room_weeks: 1, room_start_week: 38 },
      'PDD-L': { resource_kind: 'lab', lab_hold_weeks: 0, room_weeks: 0, room_start_week: null },
    },
    { lab_weeks: 13, lab_length_weeks: 18 },
  );
}

const SAVED: Record<string, SavedCell> = {
  'PDD-F': { weeks: 6, gap_weeks: 0, lab_hold_weeks: null },
  'PDD-J': { weeks: 3, gap_weeks: 0, lab_hold_weeks: 1 },
  'PDD-L': { weeks: 3, gap_weeks: 0, lab_hold_weeks: 0 },
};

describe('P62 gate axe — Room control', () => {
  it('editor with a saved value, a drafted Full and a 0-room step: no violations at any impact', async () => {
    const { container } = renderWithProviders(
      <ControlledCategoryTimeline
        timeline={roomTimeline()}
        drafts={{ 'PDD-J': { lab_hold_weeks: null } } as never}
        saved={SAVED}
        canWrite
        disabled={false}
        defaultOpen
        onNudge={vi.fn()}
        onHold={vi.fn()}
        onResetStep={vi.fn()}
      />,
    );
    expect(screen.getByRole('group', { name: 'Room weeks of PDD-J' })).toBeInTheDocument();
    expect(await allAxeViolations(container)).toEqual([]);
  });

  it('read-only editor (no write) and the plain timeline list: no violations at any impact', async () => {
    const { container } = renderWithProviders(
      <div>
        <ControlledCategoryTimeline
          timeline={roomTimeline()}
          drafts={{}}
          saved={SAVED}
          canWrite={false}
          disabled
          defaultOpen
          onNudge={vi.fn()}
          onHold={vi.fn()}
          onResetStep={vi.fn()}
        />
        <CategoryTimelineList timelines={[roomTimeline('B')]} />
      </div>,
    );
    expect(await allAxeViolations(container)).toEqual([]);
  });
});

// --- Chamber tick grid (P62-F2) ---------------------------------------------

const LAB_STEPS: LabStepColumn[] = [
  { workflowId: 'PDD', stepId: 'PDD-F', name: 'Proof of Concept' },
  { workflowId: 'PDD', stepId: 'PDD-H', name: 'Certification Testing & Compliance' },
  { workflowId: 'PDD', stepId: 'PDD-J', name: 'Pre-Production (Pr. Pr)' },
  { workflowId: 'PDD', stepId: 'PDD-L', name: 'Pilot Production' },
];

function chamber(over: Partial<ChamberRead>): ChamberRead {
  return {
    id: 'ch-4',
    code: 'IN-CH4',
    lab_region: 'India',
    max_concurrent: 1,
    platforms: 1,
    efficiency: 1,
    maintenance_weeks: 2,
    breakdown_weeks: 0,
    calibration_weeks: 1,
    working_weeks_per_chamber: 40,
    efficient_lab_weeks: 40,
    allowed_stages: ['PDD-J', 'PDD-L'],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    weekdays_per_week: 5,
    working_weeks: 40,
    capacity_weeks: { full_year: 40, remaining: 5 },
    capacity_days: { full_year: 200, remaining: 25 },
    ...over,
  } as ChamberRead;
}

const SUPER = { session: { roles: ['Super Admin' as const], permissions: ROLE_MATRIX['Super Admin'] } };
const READER = { session: { roles: ['Portfolio Manager' as const], permissions: ROLE_MATRIX['Portfolio Manager'] } };

describe('P62 gate axe — chamber tick grid', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    api.fetchChambers.mockResolvedValue([
      chamber({}),
      chamber({ id: 'ch-1', code: 'IN-CH1', max_concurrent: 1, allowed_stages: ['PDD-F', 'PDD-H', 'PDD-J', 'PDD-L'] }),
    ]);
    api.updateChamber.mockImplementation((_id: string, body: { allowed_stages: string[] }) =>
      Promise.resolve(chamber({ allowed_stages: body.allowed_stages })),
    );
  });

  it('view, edit and after-save notice: no violations at any impact', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ChamberStagesGrid labSteps={LAB_STEPS} />, SUPER);
    const grid = await screen.findByTestId('chamber-stages-IN-CH4');
    expect(await allAxeViolations(screen.getByTestId('chamber-stages'))).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Edit accepted steps for IN-CH4' }));
    expect(await allAxeViolations(screen.getByTestId('chamber-stages'))).toEqual([]);
    await user.click(screen.getByRole('checkbox', { name: 'IN-CH4 accepts Proof of Concept' }));
    await user.click(screen.getByRole('button', { name: /Save/ }));
    await screen.findByRole('status');
    expect(grid).toBeInTheDocument();
    expect(await allAxeViolations(screen.getByTestId('chamber-stages'))).toEqual([]);
  });

  it('read-only role: no violations at any impact', async () => {
    renderWithProviders(<ChamberStagesGrid labSteps={LAB_STEPS} />, READER);
    await screen.findByTestId('chamber-stages-IN-CH4');
    expect(await allAxeViolations(screen.getByTestId('chamber-stages'))).toEqual([]);
  });
});

// --- Gantt room segment ------------------------------------------------------

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
    planned_start_week: 70,
    planned_end_week: 72,
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
    lab_hold_weeks: 2,
    plan_lab_hold_weeks: 2,
    room_start_week: 71,
    room_end_week: 72,
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

describe('P62 gate axe — Gantt room segment', () => {
  beforeEach(() => seedSession({}));
  afterEach(() => seedSession(null));

  it.each([
    ['held weeks across the year boundary', labStep()],
    ['0 room weeks', labStep({ lab_hold_weeks: 0, room_start_week: null, room_end_week: null, assigned_chamber_code: null })],
    ['full room (pre-split)', labStep({ lab_hold_weeks: 3, plan_lab_hold_weeks: null, room_start_week: 70, room_end_week: 72 })],
  ])('%s: bar + left cell have no violations at any impact', async (_label, step) => {
    const scale = makeWeekScale('weeks', 104);
    const { container } = render(
      <div>
        <svg role="img" aria-label="Gantt step bar">
          <GanttHatchDefs />
          <StepBarGraphic project={project([step])} step={step} scale={scale} height={24} />
        </svg>
        <StepLeftCell step={step} />
      </div>,
    );
    if (step.room_start_week !== null) expect(container.querySelector('rect[data-bar="room"]')).toBeTruthy();
    expect(await allAxeViolations(container)).toEqual([]);
  });
});

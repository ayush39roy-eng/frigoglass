import { SEEDED_TEST_CATEGORIES } from '@/test/category-fixtures';
import type { CategoryTimeline, TimelineStep, WorkflowSettings, WorkflowStepSetting } from './api/types';

const PDD: [string, string, string, WorkflowStepSetting['kind']][] = [
  ['A', 'MKTG_BRF', 'Marketing Brief', 'design'],
  ['B', 'FEAS_STD', 'Feasibility Study (Conceptual Design)', 'design'],
  ['C', 'BUS_CASE', 'Business Case Approval', 'elapsed'],
  ['D', 'TECH_BRIEF', 'Final Technical Brief & Project Kick-off', 'design'],
  ['E', 'DESIGN', 'Design Detailing', 'design'],
  ['F', 'POC', 'Proof of Concept', 'lab'],
  ['G', 'CAPEX', 'Online CAPEX Approval', 'elapsed'],
  ['H', 'CERT', 'Certification Testing & Compliance', 'lab'],
  ['I', 'TF_1', 'TF-1', 'design'],
  ['J', 'PROD_PR', 'Pre-Production (Pr. Pr)', 'design'],
  ['K', 'TF_2', 'TF-2', 'design'],
  ['L', 'PILOT', 'Pilot', 'elapsed'],
  ['M', 'TF_3', 'TF-3', 'design'],
  ['N', 'COMM', 'Commercialization', 'elapsed'],
];
const A_PLUS = [1, 8, 4, 1, 6, 6, 2, 6, 2, 1, 2, 3, 1, 1];

export function settingsFixture(): WorkflowSettings {
  const steps = PDD.map(([letter, code, name, kind], i) => ({
    step_id: `PDD-${letter}`,
    code,
    name,
    kind,
    sequence_order: i + 1,
    predecessor_ids: i === 0 ? [] : [`PDD-${PDD[i - 1]![0]}`],
  }));
  return {
    workflows: [{ id: 'PDD', name: 'Frigoglass in-house', steps }],
    lead_times: steps.map((s, i) => ({
      workflow_id: 'PDD',
      category: 'A+',
      step_id: s.step_id,
      weeks: A_PLUS[i]!,
      gap_weeks: 0,
      effort_weight_weeks: A_PLUS[i]!,
      // P62: room weeks Full everywhere (the seed; J/L are design / elapsed here).
      lab_hold_weeks: null,
    })),
    categories: SEEDED_TEST_CATEGORIES.map((c) => ({ ...c, template_version: 1 })),
    hub_calendars: [
      {
        hub_id: 'hub-gr',
        hub: 'R&D-Greece',
        weekdays_per_week: 5,
        national_holiday_days: 12,
        medical_leave_days: 0,
        casual_leave_days: 0,
        annual_leave_days: 25,
        weeks_in_year: 52,
        working_weeks_per_engineer: 44.6,
      },
    ],
    chambers: [
      {
        chamber_id: 'ch-2',
        code: 'IN-CH-2',
        lab_region: 'India',
        platforms: 4,
        efficiency: 0.6,
        maintenance_weeks: 2,
        breakdown_weeks: 11,
        calibration_weeks: 1,
        working_weeks_per_chamber: 35.4,
        efficient_lab_weeks: 84.96,
      },
    ],
    current_week: 31,
    horizon_weeks: 78,
    within_year_week: 52,
    updated_at: '2026-09-27T09:00:00Z',
    updated_by: 'Sam Super',
  };
}

/**
 * P33: a served C2 timeline for A+ — the strict chain with every gap 0, so the
 * starts are the running sum of the lengths (as `template_timeline` serves
 * them). `patch` overrides individual steps (e.g. a flag or a wait).
 */
export function timelineFixture(
  category = 'A+',
  patch: Record<string, Partial<TimelineStep>> = {},
  extra: Partial<CategoryTimeline> = {},
): CategoryTimeline {
  let start = 0;
  const steps: TimelineStep[] = PDD.map(([letter, , name, kind], i) => {
    const code = `PDD-${letter}`;
    const duration = A_PLUS[i]!;
    const step: TimelineStep = {
      code,
      name,
      resource_kind: kind,
      start_week: start,
      duration_weeks: duration,
      gap_weeks: 0,
      effective_gap_weeks: 0,
      flags: [],
      predecessor_ids: i === 0 ? [] : [`PDD-${PDD[i - 1]![0]}`],
      // P62: Full room weeks — a lab step holds its whole length.
      lab_hold_weeks: null,
      room_weeks: kind === 'lab' ? duration : 0,
      room_start_week: kind === 'lab' && duration > 0 ? start : null,
      ...patch[code],
    };
    start += duration;
    return step;
  });
  return {
    category,
    label: category,
    workflow_id: 'PDD',
    rank: 1,
    template_version: 1,
    note: 'This is the category template with no capacity limits. Real projects also wait for engineers and chambers.',
    total_weeks: 44,
    design_weeks: 22,
    lab_weeks: 12,
    lab_length_weeks: 12,
    steps,
    ...extra,
  };
}

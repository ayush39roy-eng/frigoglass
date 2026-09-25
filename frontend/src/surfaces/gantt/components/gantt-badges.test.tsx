import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { ProjectRowBadges, StepRowBadges } from './gantt-badges';
import type { GanttProjectRow, GanttStepRow } from '../api/types';

const baseProject: GanttProjectRow = {
  project_id: 'p1',
  project_name: 'Cooler A',
  hub: 'R&D-Greece',
  category: 'A',
  priority: 'P1',
  frozen: false,
  delay_weeks: 0,
  left_out: false,
  spillover: false,
  cat_not_allowed: false,
  steps: [],
};

const baseStep: GanttStepRow = {
  step_id: 'PDD-F',
  step_name: 'Proof of Concept',
  kind: 'lab',
  sequence_order: 6,
  duration_weeks: 3,
  planned_start_week: 10,
  planned_end_week: 12,
  actual_start_week: null,
  actual_end_week: null,
  assigned_engineer_name: null,
  assigned_chamber_code: 'CH-1',
  eng_conflict: false,
  chamber_overlap: false,
};

describe('ProjectRowBadges — each chip is a server flag rendered verbatim', () => {
  it('LEFT_OUT badge renders from row.left_out', () => {
    render(<ProjectRowBadges project={{ ...baseProject, left_out: true }} />);
    expect(screen.getByText('Left out')).toBeInTheDocument();
  });

  it('SPILLOVER badge renders from row.spillover', () => {
    render(<ProjectRowBadges project={{ ...baseProject, spillover: true }} />);
    expect(screen.getByText('Spillover')).toBeInTheDocument();
  });

  it('CAT_NOT_ALLOWED badge renders from row.cat_not_allowed', () => {
    render(<ProjectRowBadges project={{ ...baseProject, cat_not_allowed: true }} />);
    expect(screen.getByText('Category not allowed')).toBeInTheDocument();
  });

  it('frozen pill + delay pill render from row.frozen / row.delay_weeks', () => {
    render(<ProjectRowBadges project={{ ...baseProject, frozen: true, delay_weeks: 4 }} />);
    expect(screen.getByText('Frozen')).toBeInTheDocument();
    expect(screen.getByText('+4w')).toBeInTheDocument();
  });

  it('renders no outcome chips when every flag is false', () => {
    render(<ProjectRowBadges project={baseProject} />);
    expect(screen.queryByText('Left out')).not.toBeInTheDocument();
    expect(screen.queryByText('Spillover')).not.toBeInTheDocument();
    expect(screen.queryByText('Frozen')).not.toBeInTheDocument();
  });
});

describe('StepRowBadges', () => {
  it('ENG_CONFLICT badge renders from step.eng_conflict', () => {
    render(<StepRowBadges step={{ ...baseStep, eng_conflict: true }} />);
    expect(screen.getByText('Eng. conflict')).toBeInTheDocument();
  });

  it('OVERLAP badge renders from step.chamber_overlap', () => {
    render(<StepRowBadges step={{ ...baseStep, chamber_overlap: true }} />);
    expect(screen.getByText('Chamber overlap')).toBeInTheDocument();
  });

  it('renders nothing when neither conflict flag is set', () => {
    const { container } = render(<StepRowBadges step={baseStep} />);
    expect(container).toBeEmptyDOMElement();
  });
});

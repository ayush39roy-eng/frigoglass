import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { renderWithProviders } from '@/test/render';

import type { GanttProjectRow } from '../api/types';
import { projectStatusLabels } from '../lib/gantt-status-labels';
import { P13_GANTT_ROW_DEFAULTS } from '../test-fixtures';
import { ProjectRowBadges } from './gantt-badges';
import { GanttLegend } from './gantt-legend';

/**
 * P42-T04 (ADR 0056): the Gantt shows the served `outcome_label` of a queued
 * P3 or a P4 / Q never planned, in the badge column, the narrow-layout status
 * words and the legend — and never the left-out / spillover words for them.
 */

const base: GanttProjectRow = {
  project_id: 'p1',
  project_name: 'Cooler A',
  hub: 'R&D-Greece',
  category: 'A',
  priority: 'P3',
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
  steps: [],
};

describe('P42 Gantt band outcomes', () => {
  it('a queued P3 with no slot shows "Queued — no slot", not the left-out chip', () => {
    const p: GanttProjectRow = {
      ...base,
      left_out: true,
      counts_toward_year: false,
      not_scheduled_priority: false,
      outcome: 'QUEUED',
      outcome_label: 'Queued — no slot',
    };
    render(<ProjectRowBadges project={p} />);
    expect(screen.getByTestId('band-outcome-chip')).toHaveTextContent('Queued — no slot');
    expect(screen.queryByText('Spillover · unplaced')).toBeNull();
    expect(projectStatusLabels(p)).toEqual(['Queued — no slot']);
  });

  it('a P4 never planned shows "Not scheduled (P4)"', () => {
    const p: GanttProjectRow = {
      ...base,
      priority: 'P4',
      counts_toward_year: false,
      not_scheduled_priority: true,
      outcome: 'NOT_SCHEDULED_PRIORITY',
      outcome_label: 'Not scheduled (P4)',
    };
    render(<ProjectRowBadges project={p} />);
    expect(screen.getByTestId('band-outcome-chip')).toHaveTextContent('Not scheduled (P4)');
    expect(projectStatusLabels(p)).toEqual(['Not scheduled (P4)']);
  });

  it('a counting project keeps its pre-P42 chips', () => {
    const p: GanttProjectRow = { ...base, left_out: true, outcome: 'LEFT_OUT', outcome_label: null };
    render(<ProjectRowBadges project={p} />);
    expect(screen.queryByTestId('band-outcome-chip')).toBeNull();
    expect(screen.getByText('Spillover · unplaced')).toBeInTheDocument();
    expect(projectStatusLabels(p)).toEqual(['Spillover · unplaced']);
  });

  it('the legend names both outcomes', () => {
    renderWithProviders(<GanttLegend rows={[]} />);
    const legend = screen.getByTestId('gantt-legend');
    expect(legend).toHaveTextContent('P3 in queue — planned with spare capacity, not counted this year');
    expect(legend).toHaveTextContent('Not scheduled (P4) — never planned, no bars');
  });
});

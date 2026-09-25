import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';

import { renderWithProviders } from '@/test/render';
import type { ScheduleRunSummary } from '../api/types';
import { ScheduleRunProvenance } from './schedule-run-provenance';

const greedyRun: ScheduleRunSummary = {
  id: 'run-1',
  version: 7,
  solver_type: 'greedy',
  status: 'completed',
  is_active: true,
  horizon_weeks: 78,
  current_week: 31,
  trigger_reason: 'manual_recalc',
  created_at: '2026-08-31T09:00:00Z',
};

describe('ScheduleRunProvenance', () => {
  it('names the exact active schedule run version the figures come from', () => {
    renderWithProviders(
      <ScheduleRunProvenance scheduleRunVersion={7} activeRun={greedyRun} />,
    );
    expect(screen.getByTestId('schedule-run-provenance')).toHaveTextContent(
      /active schedule run\s+v7/i,
    );
    expect(screen.getByText(/greedy scheduler/i)).toBeInTheDocument();
  });

  it('falls back to the version from the I9 endpoint when /schedule-runs/active is unavailable', () => {
    renderWithProviders(
      <ScheduleRunProvenance scheduleRunVersion={5} activeRun={null} />,
    );
    expect(screen.getByTestId('schedule-run-provenance')).toHaveTextContent(/v5/);
  });

  it('exposes the counting-method explanation as an affordance', () => {
    renderWithProviders(
      <ScheduleRunProvenance scheduleRunVersion={1} activeRun={undefined} />,
    );
    expect(
      screen.getByRole('button', { name: /how the count is defined/i }),
    ).toBeInTheDocument();
  });
});

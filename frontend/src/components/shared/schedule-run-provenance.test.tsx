import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';

import { renderWithProviders } from '@/test/render';
import { ScheduleRunProvenance, type ProvenanceRun } from './schedule-run-provenance';

const run: ProvenanceRun = {
  version: 9,
  solver_type: 'cp_sat',
  created_at: '2026-08-31T09:00:00Z',
};

describe('shared ScheduleRunProvenance', () => {
  it('names the active run version and solver, and honours a custom lead-in', () => {
    renderWithProviders(
      <ScheduleRunProvenance
        scheduleRunVersion={9}
        activeRun={run}
        leadIn="Load figures below are read directly from"
      />,
    );
    const line = screen.getByTestId('schedule-run-provenance');
    expect(line).toHaveTextContent(/Load figures below are read directly from active schedule run\s+v9/i);
    expect(line).toHaveTextContent(/CP-SAT solver/i);
  });

  it('falls back to the endpoint version when /schedule-runs/active is unavailable', () => {
    renderWithProviders(<ScheduleRunProvenance scheduleRunVersion={2} activeRun={null} />);
    expect(screen.getByTestId('schedule-run-provenance')).toHaveTextContent(/v2/);
  });

  it('renders the explanation affordance only when a body is supplied', () => {
    const { rerender } = renderWithProviders(
      <ScheduleRunProvenance scheduleRunVersion={1} activeRun={undefined} />,
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();

    rerender(
      <ScheduleRunProvenance
        scheduleRunVersion={1}
        activeRun={undefined}
        affordanceLabel="How load and capacity are defined"
      >
        <span>explanation</span>
      </ScheduleRunProvenance>,
    );
    expect(
      screen.getByRole('button', { name: /how load and capacity are defined/i }),
    ).toBeInTheDocument();
  });
});

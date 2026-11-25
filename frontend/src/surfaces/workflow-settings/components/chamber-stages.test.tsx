import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import { ROLE_MATRIX } from '@/test/roles';
import { seriousAxeViolations } from '@/test/axe';
import type { ChamberRead } from '@/surfaces/planning/api/types';

const api = {
  fetchChambers: vi.fn(),
  updateChamber: vi.fn(),
};
vi.mock('@/surfaces/planning/api/planning-api', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  fetchChambers: (...a: unknown[]) => api.fetchChambers(...a) as unknown,
  updateChamber: (...a: unknown[]) => api.updateChamber(...a) as unknown,
}));

import { ChamberStagesGrid, type LabStepColumn } from './chamber-stages';

const LAB_STEPS: LabStepColumn[] = [
  { workflowId: 'PDD', stepId: 'PDD-F', name: 'Proof of Concept' },
  { workflowId: 'PDD', stepId: 'PDD-H', name: 'Certification Testing & Compliance' },
  { workflowId: 'PDD', stepId: 'PDD-J', name: 'Pre-Production (Pr. Pr)' },
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
    allowed_stages: ['PDD-H'],
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

beforeEach(() => {
  vi.clearAllMocks();
  api.fetchChambers.mockResolvedValue([chamber({})]);
  api.updateChamber.mockImplementation((_id: string, body: { allowed_stages: string[] }) =>
    Promise.resolve(chamber({ allowed_stages: body.allowed_stages })),
  );
});

describe('P62-F2 — per-chamber lab-step tick boxes', () => {
  it('shows the served ticks; Edit, tick, Save sends PATCH allowed_stages with base, then the stale notice', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ChamberStagesGrid labSteps={LAB_STEPS} />, SUPER);
    const box = await screen.findByRole('checkbox', { name: 'IN-CH4 accepts Pre-Production (Pr. Pr)' });
    expect(box).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'IN-CH4 accepts Certification Testing & Compliance' })).toBeChecked();
    expect(box).not.toBeChecked();

    await user.click(screen.getByRole('button', { name: 'Edit accepted steps for IN-CH4' }));
    expect(box).toBeEnabled();
    const save = screen.getByRole('button', { name: 'Save accepted steps for IN-CH4' });
    expect(save).toBeDisabled();
    await user.click(box);
    expect(box).toBeChecked();
    await user.click(save);

    await waitFor(() => expect(api.updateChamber).toHaveBeenCalledTimes(1));
    expect(api.updateChamber).toHaveBeenCalledWith('ch-4', {
      allowed_stages: ['PDD-H', 'PDD-J'],
      base: { allowed_stages: ['PDD-H'] },
    });
    expect(await screen.findByTestId('chamber-stages-stale')).toHaveTextContent('IN-CH4 saved — the plan is not recalculated.');
    expect(screen.getByTestId('chamber-stages-stale')).toHaveAttribute('role', 'status');
  });

  it('Cancel restores the served ticks and sends nothing', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ChamberStagesGrid labSteps={LAB_STEPS} />, SUPER);
    await user.click(await screen.findByRole('button', { name: 'Edit accepted steps for IN-CH4' }));
    const h = screen.getByRole('checkbox', { name: 'IN-CH4 accepts Certification Testing & Compliance' });
    await user.click(h);
    expect(h).not.toBeChecked();
    await user.click(screen.getByRole('button', { name: 'Cancel editing IN-CH4' }));
    expect(screen.getByRole('checkbox', { name: 'IN-CH4 accepts Certification Testing & Compliance' })).toBeChecked();
    expect(api.updateChamber).not.toHaveBeenCalled();
  });

  it('keeps a served id the grid does not show', async () => {
    api.fetchChambers.mockResolvedValue([chamber({ allowed_stages: ['OEM-H', 'PDD-H'] })]);
    const user = userEvent.setup();
    renderWithProviders(<ChamberStagesGrid labSteps={LAB_STEPS} />, SUPER);
    await user.click(await screen.findByRole('button', { name: 'Edit accepted steps for IN-CH4' }));
    await user.click(screen.getByRole('checkbox', { name: 'IN-CH4 accepts Proof of Concept' }));
    await user.click(screen.getByRole('button', { name: 'Save accepted steps for IN-CH4' }));
    await waitFor(() => expect(api.updateChamber).toHaveBeenCalled());
    expect(api.updateChamber.mock.calls[0]?.[1]).toMatchObject({ allowed_stages: ['PDD-F', 'PDD-H', 'OEM-H'] });
  });

  it('a reader sees read-only ticks and no Edit', async () => {
    renderWithProviders(<ChamberStagesGrid labSteps={LAB_STEPS} />, READER);
    const row = await screen.findByTestId('chamber-stages-IN-CH4');
    for (const box of within(row).getAllByRole('checkbox')) expect(box).toBeDisabled();
    expect(screen.queryByRole('button', { name: /Edit accepted steps/ })).toBeNull();
    expect(screen.getByText(/Read-only for your role/)).toBeInTheDocument();
  });

  it('has no serious axe violations while editing', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ChamberStagesGrid labSteps={LAB_STEPS} />, SUPER);
    await user.click(await screen.findByRole('button', { name: 'Edit accepted steps for IN-CH4' }));
    expect(await seriousAxeViolations(screen.getByTestId('chamber-stages'))).toEqual([]);
  });
});

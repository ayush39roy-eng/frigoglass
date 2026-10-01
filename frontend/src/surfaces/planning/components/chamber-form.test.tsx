import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@/lib/api/reference', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/reference')>('@/lib/api/reference');
  return { ...actual, useWorkflowStepTemplates: vi.fn() };
});

import { renderWithProviders } from '@/test/render';
import { useWorkflowStepTemplates } from '@/lib/api/reference';

import { ChamberFormDialog } from './chamber-form';

const STEP_TEMPLATES = [
  { id: 'PDD-A', name: 'Marketing Brief', kind: 'design' as const, base_weeks: 2 },
  { id: 'PDD-F', name: 'Proof of Concept', kind: 'lab' as const, base_weeks: 3 },
  { id: 'PDD-H', name: 'Certification', kind: 'lab' as const, base_weeks: 4 },
];

function mockStepTemplates() {
  vi.mocked(useWorkflowStepTemplates).mockReturnValue({
    data: STEP_TEMPLATES,
    isPending: false,
  } as unknown as ReturnType<typeof useWorkflowStepTemplates>);
}

describe('ChamberFormDialog', () => {
  it('requires a lab region before submitting in create mode', async () => {
    mockStepTemplates();
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderWithProviders(
      <ChamberFormDialog mode="create" chamber={null} open onOpenChange={() => {}} onSubmit={onSubmit} />,
    );
    await user.type(screen.getByLabelText(/^Code/), 'GR-CH1');
    await user.click(screen.getByRole('button', { name: 'Add chamber' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Lab region is required.');
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('only offers lab-kind steps in the allowed-stages picker, never design-kind', () => {
    mockStepTemplates();
    renderWithProviders(
      <ChamberFormDialog mode="create" chamber={null} open onOpenChange={() => {}} onSubmit={vi.fn()} />,
    );
    expect(screen.getByRole('checkbox', { name: /PDD-F/ })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /PDD-H/ })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /PDD-A/ })).not.toBeInTheDocument();
  });

  it('submits code, lab region, max concurrent and selected allowed stages, defaulting the optional reporting fields', async () => {
    mockStepTemplates();
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderWithProviders(
      <ChamberFormDialog mode="create" chamber={null} open onOpenChange={() => {}} onSubmit={onSubmit} />,
    );
    await user.type(screen.getByLabelText(/^Code/), 'GR-CH1');
    await user.click(screen.getByRole('combobox', { name: /^Lab region/ }));
    await user.click(await screen.findByRole('option', { name: 'Greece' }));
    const maxConcurrent = screen.getByLabelText(/^Max concurrent/);
    await user.clear(maxConcurrent);
    await user.type(maxConcurrent, '2');
    await user.click(screen.getByRole('checkbox', { name: /PDD-F/ }));
    await user.click(screen.getByRole('button', { name: 'Add chamber' }));

    expect(onSubmit).toHaveBeenCalledWith({
      code: 'GR-CH1',
      lab_region: 'Greece',
      max_concurrent: 2,
      platforms: 1,
      efficiency: 1.0,
      maintenance_weeks: 2,
      breakdown_weeks: 0,
      calibration_weeks: 1,
      allowed_stages: ['PDD-F'],
    });
  });

  it('pre-fills the form from the existing chamber in edit mode', () => {
    mockStepTemplates();
    renderWithProviders(
      <ChamberFormDialog
        mode="edit"
        chamber={{
          id: 'c1',
          code: 'IN-CH2',
          lab_region: 'India',
          max_concurrent: 3,
          platforms: 2,
          efficiency: 0.7,
          maintenance_weeks: 2,
          breakdown_weeks: 11,
          calibration_weeks: 1,
          working_weeks_per_chamber: 35.4,
          efficient_lab_weeks: 84.96,
          allowed_stages: ['PDD-H'],
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        }}
        open
        onOpenChange={() => {}}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByDisplayValue('IN-CH2')).toBeInTheDocument();
    expect(screen.getByDisplayValue('3')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /PDD-H/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /PDD-F/ })).not.toBeChecked();
    // P9 (ADR 0008): downtime fields replace weeks_per_chamber; derived figures are read-only, from the server
    expect(screen.getByLabelText(/^Breakdown/)).toHaveValue(11);
    expect(screen.getByLabelText(/^Maintenance/)).toHaveValue(2);
    expect(screen.getByLabelText(/^Calibration/)).toHaveValue(1);
    expect(screen.queryByLabelText(/Weeks per chamber/i)).not.toBeInTheDocument();
    const derived = screen.getByTestId('chamber-derived');
    expect(derived).toHaveTextContent('35.4');
    expect(derived).toHaveTextContent('84.96');
    expect(derived.querySelector('input')).toBeNull();
  });

  it('rejects negative downtime', async () => {
    mockStepTemplates();
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderWithProviders(
      <ChamberFormDialog mode="create" chamber={null} open onOpenChange={() => {}} onSubmit={onSubmit} />,
    );
    const breakdown = screen.getByLabelText(/^Breakdown/);
    await user.clear(breakdown);
    await user.type(breakdown, '-1');
    expect(await screen.findByText(/Enter a number|Must be 0 or more/)).toBeInTheDocument();
  });
});

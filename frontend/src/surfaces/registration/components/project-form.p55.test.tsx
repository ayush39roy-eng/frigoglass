import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import type { Hub } from '@/lib/api/reference';
import { ApiError } from '@/lib/api/client';

import type { ProjectRead } from '../api/types';

const hooks = { useEngineerOptions: vi.fn() };
vi.mock('../hooks/use-registration', () => ({
  useEngineerOptions: (hubId: string | undefined) => hooks.useEngineerOptions(hubId),
}));

import { ProjectForm, START_WEEK_PLACEHOLDER } from './project-form';
import { REQUIRED_FIELD_KEYS, missingRequiredFields, startWeekErrorFromApi, startWeekRequiredFor } from './required-fields-hint';

vi.setConfig({ testTimeout: 30_000 });

const hubs: Hub[] = [
  { id: 'hub-1', name: 'R&D-Greece', lab_region: 'Greece', is_oem: false, capacity_hub_id: null, capacity_hub_name: null },
];

function project(overrides: Partial<ProjectRead> = {}): ProjectRead {
  return {
    id: 'p9', name: 'Old cooler', external_code: null, hub_id: 'hub-1', leader_engineer_id: null, leader_is_provisional: false,
    category: null, type: null, priority: 'P2', status: 'In Queue', frozen: false, actual_start_week: 40, actual_end_week: null,
    delay_weeks: 0, reg_year: null, carry_over: false, comments: null, customer_name: null, tcogs_eur: null,
    selling_price_eur: null, gross_margin_pct: null, capex_keur: null, rm_savings_keur: null,
    target_end_week: null, certification_testing_required: true, estimated_design_weeks: null,
    estimated_lab_weeks: null, design_effort_weeks: null, lab_effort_weeks: null, safety_lab_weeks: null, actual_design_weeks: null,
    actual_testing_weeks: null, safety_certification_required: false, capacity_flag: false, plant: null, requesting_department: null,
    product_type: null, scoring_tags: [], tag_dimension_keys: [], schedule_stale: false, workflow_id: 'PDD',
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', band_rank: null, band_size: null,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  hooks.useEngineerOptions.mockReturnValue({ data: [] });
});

describe('ADR 0065 (P55): actual start week optional at registration', () => {
  it('the hard-gate mirror no longer lists the start week', () => {
    expect(REQUIRED_FIELD_KEYS).not.toContain('actual_start_week');
    expect(missingRequiredFields({ actual_start_week: null } as never)).not.toHaveProperty('actual_start_week');
  });

  it('only a started status (In Progress, Blocked, Done) makes it required', () => {
    for (const s of ['In Progress', 'Blocked', 'Done']) expect(startWeekRequiredFor(s)).toBe(true);
    for (const s of ['Not Started', 'In Queue', 'In Development', null, undefined]) expect(startWeekRequiredFor(s)).toBe(false);
  });

  it('create: empty shows the placeholder, no required mark', () => {
    renderWithProviders(
      <ProjectForm mode="create" variant="inline" project={null} hubs={hubs} onOpenChange={vi.fn()} onSubmit={vi.fn()} />,
    );
    const input = screen.getByLabelText(/^Actual start week/);
    expect(input).toHaveAttribute('placeholder', START_WEEK_PLACEHOLDER);
    expect(START_WEEK_PLACEHOLDER).toBe('Unset — scheduled by the scheduler');
    expect(screen.getByText('Actual start week').textContent).not.toContain('*');
  });

  it('a week after the served current week (31) shows "Won\'t start before W{n}"; at or before it, no hint', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <ProjectForm mode="create" variant="inline" project={null} hubs={hubs} onOpenChange={vi.fn()} onSubmit={vi.fn()} />,
    );
    const input = screen.getByLabelText(/^Actual start week/);
    await user.type(input, '40');
    expect(screen.getByTestId('reg-start-week-hint')).toHaveTextContent("Won't start before W40");
    await user.clear(input);
    await user.type(input, '31');
    expect(screen.queryByTestId('reg-start-week-hint')).not.toBeInTheDocument();
    await user.clear(input);
    await user.type(input, '12');
    expect(screen.queryByTestId('reg-start-week-hint')).not.toBeInTheDocument();
  });

  it('the required mark shows only for a started progress status', () => {
    const { unmount } = renderWithProviders(
      <ProjectForm mode="edit" variant="inline" project={project()} hubs={hubs} onOpenChange={vi.fn()} onSubmit={vi.fn()} progressStatus="In Queue" />,
    );
    expect(screen.getByText('Actual start week').parentElement?.textContent).not.toContain('*');
    unmount();
    renderWithProviders(
      <ProjectForm mode="edit" variant="inline" project={project()} hubs={hubs} onOpenChange={vi.fn()} onSubmit={vi.fn()} progressStatus="In Progress" />,
    );
    expect(screen.getByText('Actual start week').parentElement?.textContent).toContain('*');
  });

  it('clearing the value sends null', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderWithProviders(
      <ProjectForm mode="edit" variant="inline" project={project()} hubs={hubs} onOpenChange={vi.fn()} onSubmit={onSubmit} />,
    );
    await user.clear(screen.getByLabelText(/^Actual start week/));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ actual_start_week: null }));
  });

  it("a started status without a start week: the server's message lands on the field", async () => {
    const user = userEvent.setup();
    const detail = JSON.stringify([{ loc: ['body', 'actual_start_week'], msg: 'is required when status is In Progress' }]);
    const onSubmit = vi.fn().mockRejectedValue(new ApiError(422, 'invalid', detail));
    renderWithProviders(
      <ProjectForm
        mode="edit"
        variant="inline"
        project={project({ actual_start_week: null })}
        hubs={hubs}
        onOpenChange={vi.fn()}
        onSubmit={onSubmit}
        progressStatus="In Progress"
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('is required when status is In Progress')).toBeInTheDocument();
    expect(screen.getByLabelText(/^Actual start week/)).toHaveAttribute('aria-invalid', 'true');
  });

  it('startWeekErrorFromApi reads the field_errors map and the errors list', () => {
    const a = new ApiError(422, 'x', JSON.stringify({ field_errors: { actual_start_week: 'needed' } }));
    const b = new ApiError(422, 'x', JSON.stringify({ errors: [{ field: 'actual_start_week', message: 'needed too' }] }));
    expect(startWeekErrorFromApi(a)).toBe('needed');
    expect(startWeekErrorFromApi(b)).toBe('needed too');
    expect(startWeekErrorFromApi(new ApiError(400, 'x', '{}'))).toBeNull();
  });
});

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import { permissionsFrom } from '@/test/session';
import type { Hub } from '@/lib/api/reference';
import type { PriorityMoveApi } from '@/components/shared/priority-move/priority-move-context';

import type { ProjectRead } from '../api/types';

const hooks = { useEngineerOptions: vi.fn() };
vi.mock('../hooks/use-registration', () => ({
  useEngineerOptions: (hubId: string | undefined) => hooks.useEngineerOptions(hubId),
}));

import { ProjectForm } from './project-form';
import { RANK_WHEN_SAVED } from './band-rank-request';

vi.setConfig({ testTimeout: 30_000 });

const hubs: Hub[] = [
  { id: 'hub-1', name: 'R&D-Greece', lab_region: 'Greece', is_oem: false, capacity_hub_id: null, capacity_hub_name: null },
];

function project(overrides: Partial<ProjectRead> = {}): ProjectRead {
  return {
    priority_applicable: true,
    id: 'p9', name: 'Old cooler', external_code: null, hub_id: 'hub-1', leader_engineer_id: null, leader_is_provisional: false,
    category: null, type: null, priority: 'P1', status: 'In Development', frozen: false, actual_start_week: 20, actual_end_week: null,
    delay_weeks: 0, reg_year: null, carry_over: false, comments: null, customer_name: null, tcogs_eur: null,
    selling_price_eur: null, gross_margin_pct: null, capex_keur: null, rm_savings_keur: null,
    target_end_week: null, certification_testing_required: true, estimated_design_weeks: null,
    estimated_lab_weeks: null, design_effort_weeks: null, lab_effort_weeks: null, safety_lab_weeks: null, actual_design_weeks: null,
    actual_testing_weeks: null, safety_certification_required: false, capacity_flag: false, plant: null, requesting_department: null,
    product_type: null, scoring_tags: [], tag_dimension_keys: [], schedule_stale: false, workflow_id: 'PDD',
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', band_rank: 3, band_size: 42,
    ...overrides,
  };
}

function host(): PriorityMoveApi {
  return { requestMove: vi.fn(), requestRankMove: vi.fn(), followPatch: vi.fn(), busy: false };
}

beforeEach(() => {
  vi.clearAllMocks();
  hooks.useEngineerOptions.mockReturnValue({ data: [] });
});

describe('P54 (ADR 0064 R3): rank inside the band on the registration form', () => {
  it('edit: "Rank in P1: 3 of 42"; typing a position opens the shared preview with { to_rank }', async () => {
    const user = userEvent.setup();
    const api = host();
    renderWithProviders(
      <ProjectForm mode="edit" variant="inline" project={project()} hubs={hubs} onOpenChange={vi.fn()} onSubmit={vi.fn()} rankMoveHost={api} />,
    );
    const line = screen.getByTestId('reg-band-rank');
    expect(line).toHaveTextContent('Rank in P1:');
    expect(line).toHaveTextContent('of 42');
    const input = screen.getByRole('textbox', { name: /Position of Old cooler in P1/ });
    expect(input).toHaveValue('3');
    await user.clear(input);
    await user.type(input, '1{Enter}');
    expect(api.requestRankMove).toHaveBeenCalledWith(
      { projectId: 'p9', projectName: 'Old cooler', priority: 'P1', status: 'In Development' },
      { to_rank: 1 },
      expect.objectContaining({ position: 1, fromPosition: 3 }),
    );
  });

  it('create: "Ranked last in its band when saved", input disabled', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <ProjectForm mode="create" variant="inline" project={null} hubs={hubs} onOpenChange={vi.fn()} onSubmit={vi.fn()} rankMoveHost={host()} />,
    );
    // No band chosen yet: nothing shown.
    expect(screen.queryByTestId('reg-band-rank')).not.toBeInTheDocument();
    await user.click(screen.getByRole('combobox', { name: /^Priority/ }));
    await user.click(await screen.findByRole('option', { name: /^P2( ·|$)/ }));
    expect(screen.getByTestId('reg-band-rank')).toHaveTextContent(RANK_WHEN_SAVED);
    expect(screen.getByTestId('reg-band-rank-disabled')).toBeDisabled();
    expect(screen.queryByTestId('board-rank-input')).not.toBeInTheDocument();
  });

  it('edit with the priority changed in the unsaved form: disabled, ranked last when saved', async () => {
    const user = userEvent.setup();
    const api = host();
    renderWithProviders(
      <ProjectForm mode="edit" variant="inline" project={project()} hubs={hubs} onOpenChange={vi.fn()} onSubmit={vi.fn()} rankMoveHost={api} />,
    );
    await user.click(screen.getByRole('combobox', { name: /^Priority/ }));
    await user.click(await screen.findByRole('option', { name: /^P2( ·|$)/ }));
    expect(screen.getByTestId('reg-band-rank')).toHaveTextContent(RANK_WHEN_SAVED);
    expect(screen.getByTestId('reg-band-rank-disabled')).toBeDisabled();
    expect(api.requestRankMove).not.toHaveBeenCalled();
  });

  it('without the priority-move right: the rank is shown read-only', () => {
    renderWithProviders(
      <ProjectForm mode="edit" variant="inline" project={project()} hubs={hubs} onOpenChange={vi.fn()} onSubmit={vi.fn()} rankMoveHost={host()} />,
      { session: { permissions: permissionsFrom({ project_registration: 'r' }) } },
    );
    expect(screen.queryByTestId('board-rank-input')).not.toBeInTheDocument();
    expect(screen.getByTestId('band-rank-readonly')).toHaveTextContent('3');
    expect(screen.getByTestId('reg-band-rank')).toHaveTextContent('of 42');
  });

  it('an unranked project shows "—"', () => {
    renderWithProviders(
      <ProjectForm mode="edit" variant="inline" project={project({ band_rank: null, band_size: null })} hubs={hubs} onOpenChange={vi.fn()} onSubmit={vi.fn()} rankMoveHost={host()} />,
    );
    expect(screen.getByTestId('reg-band-rank')).toHaveTextContent(/Rank in P1:\s*—/);
  });
});

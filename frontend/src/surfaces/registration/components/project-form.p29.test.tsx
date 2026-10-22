import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import { seriousAxeViolations } from '@/test/axe';
import type { Hub } from '@/lib/api/reference';

import type { ProjectRead } from '../api/types';

const hooks = { useEngineerOptions: vi.fn() };
vi.mock('../hooks/use-registration', () => ({
  useEngineerOptions: (hubId: string | undefined) => hooks.useEngineerOptions(hubId),
}));

import { ProjectForm } from './project-form';

/**
 * P29-T03 / P29-T04 frontend on Project Registration: member hubs read
 * "(Greece)" in the hub select, the served provisional-leader flag shows a
 * badge while the saved leader is selected, and the RC type is labelled
 * "Regulatory / Business Compliance".
 */
vi.setConfig({ testTimeout: 30_000 });

const hubs: Hub[] = [
  { id: 'h-gr', name: 'R&D-Greece', lab_region: 'Greece', is_oem: false, capacity_hub_id: null, capacity_hub_name: null },
  { id: 'h-ro', name: 'PD-Romania', lab_region: 'Romania', is_oem: false, capacity_hub_id: null, capacity_hub_name: null },
  { id: 'h-hck', name: 'OEM-HCK', lab_region: 'Greece', is_oem: true, capacity_hub_id: 'h-gr', capacity_hub_name: 'R&D-Greece' },
  { id: 'h-sel', name: 'OEM-Seitek', lab_region: 'Greece', is_oem: true, capacity_hub_id: 'h-gr', capacity_hub_name: 'R&D-Greece' },
];

function oemProject(overrides: Partial<ProjectRead> = {}): ProjectRead {
  return {
    id: 'p-oem', name: 'HCK cooler', external_code: null, hub_id: 'h-hck', leader_engineer_id: 'eng-dim',
    leader_is_provisional: true, category: 'B-OEM', type: 'RC', priority: 'P2', status: 'In Queue', frozen: false,
    actual_start_week: 10, delay_weeks: 0, reg_year: 2026, carry_over: false, comments: null, customer_name: null,
    tcogs_eur: null, selling_price_eur: null, gross_margin_pct: null, capex_keur: null, rm_savings_keur: null,
    target_end_week: null, certification_testing_required: true, estimated_design_weeks: null, estimated_lab_weeks: null, design_effort_weeks: null, lab_effort_weeks: null, safety_lab_weeks: null, actual_design_weeks: null, actual_testing_weeks: null, safety_certification_required: false, capacity_flag: false,
    plant: null, requesting_department: null, product_type: null, scoring_tags: [], tag_dimension_keys: [],
    schedule_stale: false, workflow_id: 'OEM', created_at: '', updated_at: '',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  hooks.useEngineerOptions.mockReturnValue({
    data: [
      { id: 'eng-dim', name: 'Dimopoulou' },
      { id: 'eng-lio', name: 'Lioumis' },
    ],
  });
});

function renderEdit(project: ProjectRead) {
  return renderWithProviders(
    <ProjectForm mode="edit" project={project} hubs={hubs} variant="inline" onOpenChange={vi.fn()} onSubmit={vi.fn()} />,
  );
}

describe('Project Registration — P29', () => {
  it('labels member hubs "(Greece)" in the hub select', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProjectForm mode="create" project={null} hubs={hubs} variant="inline" onOpenChange={vi.fn()} onSubmit={vi.fn()} />);
    await user.click(screen.getByRole('combobox', { name: /^Hub/ }));
    const options = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(options).toEqual(['R&D-Greece', 'PD-Romania', 'OEM-HCK (Greece)', 'OEM-Seitek (Greece)']);
  });

  it('shows the provisional badge next to the saved provisional leader; picking another leader removes it', async () => {
    const user = userEvent.setup();
    renderEdit(oemProject());
    const hint = screen.getByTestId('reg-leader-provisional');
    expect(within(hint).getByTestId('provisional-leader')).toHaveTextContent('Provisional');
    expect(hint).toHaveTextContent('Assigned by the data load, not by a person.');
    // The badge sits outside the label: the select keeps its plain name.
    expect(screen.getByRole('combobox', { name: /^Leader/ })).not.toHaveAccessibleName(/Provisional/);
    await user.click(screen.getByRole('combobox', { name: /^Leader/ }));
    await user.click(await screen.findByRole('option', { name: 'Lioumis' }));
    expect(screen.queryByTestId('provisional-leader')).toBeNull();
  });

  it('no badge for a leader a person chose', () => {
    renderEdit(oemProject({ leader_is_provisional: false }));
    expect(screen.queryByTestId('provisional-leader')).toBeNull();
  });

  it('the RC type reads "Regulatory / Business Compliance" (P29-T04)', async () => {
    const user = userEvent.setup();
    renderEdit(oemProject());
    expect(screen.getByRole('combobox', { name: /^Type/ })).toHaveTextContent('Regulatory / Business Compliance');
    await user.click(screen.getByRole('combobox', { name: /^Type/ }));
    expect(await screen.findByRole('option', { name: 'Regulatory / Business Compliance' })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Regulatory / Compliance' })).toBeNull();
  });

  it('is axe-clean with the provisional badge', async () => {
    const { container } = renderEdit(oemProject());
    expect(await seriousAxeViolations(container)).toEqual([]);
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ApiError } from '@/lib/api/client';
import type { Hub } from '@/lib/api/reference';
import { renderWithProviders } from '@/test/render';
import { seriousAxeViolations } from '@/test/axe';

import type { ProjectRead } from '../api/types';

const hooks = { useEngineerOptions: vi.fn() };
vi.mock('../hooks/use-registration', () => ({
  useEngineerOptions: (hubId: string | undefined) => hooks.useEngineerOptions(hubId),
}));

import { ProjectForm } from './project-form';
import { EFFORT_SPLIT_REJECTED_COPY, effortSplitField } from './effort-fields';

/**
 * P30-T03 (ADR 0041, API_CONTRACT_P30 §2): the client's two effort figures are
 * editable (0..9999.99, ≤ 2 dp) with 422 `EFFORT_SPLIT_REJECTED` mapped onto
 * the figure it names; the display-only workbook figures are read-only; AC and
 * SER carry the served labels.
 */
vi.setConfig({ testTimeout: 30_000 });

const hubs: Hub[] = [
  { id: 'h-ro', name: 'PD-Romania', lab_region: 'Romania', is_oem: false, capacity_hub_id: null, capacity_hub_name: null },
];

function project(overrides: Partial<ProjectRead> = {}): ProjectRead {
  return {
    id: 'p-1', name: 'Romania cooler', external_code: null, hub_id: 'h-ro', leader_engineer_id: 'eng-1',
    leader_is_provisional: false, category: 'B', type: 'AC', priority: 'P2', status: 'In Queue', frozen: false,
    actual_start_week: 10, delay_weeks: 0, reg_year: 2026, carry_over: false, comments: null, customer_name: null,
    tcogs_eur: null, selling_price_eur: null, gross_margin_pct: null, capex_keur: null, rm_savings_keur: null,
    target_end_week: null, certification_testing_required: true, estimated_design_weeks: 12, estimated_lab_weeks: null,
    design_effort_weeks: 20, lab_effort_weeks: 70, safety_lab_weeks: 3.5, actual_design_weeks: 18.25,
    actual_testing_weeks: null, safety_certification_required: true, capacity_flag: true,
    plant: null, requesting_department: null, product_type: null, scoring_tags: [], tag_dimension_keys: [],
    schedule_stale: false, workflow_id: 'PDD', created_at: '', updated_at: '',
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  hooks.useEngineerOptions.mockReturnValue({ data: [{ id: 'eng-1', name: 'Elena Micu' }] });
});

function renderEdit(onSubmit = vi.fn().mockResolvedValue(undefined), p = project()) {
  renderWithProviders(<ProjectForm mode="edit" project={p} hubs={hubs} variant="inline" onOpenChange={vi.fn()} onSubmit={onSubmit} />);
  return onSubmit;
}

describe('Project form — client effort figures (P30)', () => {
  it('loads the served figures and sends edited ones as numbers; an empty field sends null (the table applies)', async () => {
    const user = userEvent.setup();
    const onSubmit = renderEdit();
    const design = screen.getByLabelText('Design effort (client, weeks)');
    const lab = screen.getByLabelText('Lab effort (client, weeks)');
    expect(design).toHaveValue(20);
    expect(lab).toHaveValue(70);
    await user.clear(design);
    await user.type(design, '4.25');
    await user.clear(lab);
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({ design_effort_weeks: 4.25, lab_effort_weeks: null }));
    const body = onSubmit.mock.calls[0]![0] as Record<string, unknown>;
    // R13: the deprecated estimates are not sent; the display-only figures are never written.
    for (const key of ['estimated_design_weeks', 'estimated_lab_weeks', 'safety_lab_weeks', 'actual_design_weeks', 'actual_testing_weeks', 'safety_certification_required', 'capacity_flag']) {
      expect(body).not.toHaveProperty(key);
    }
  });

  it('validates at most 2 decimals and 0..9999.99 before sending anything', async () => {
    const user = userEvent.setup();
    const onSubmit = renderEdit();
    const design = screen.getByLabelText('Design effort (client, weeks)');
    await user.clear(design);
    await user.type(design, '4.256');
    expect(await screen.findByText('At most 2 decimal places')).toBeInTheDocument();
    expect(design).toHaveAttribute('aria-invalid', 'true');
    await user.clear(design);
    await user.type(design, '10000');
    expect(await screen.findByText('Must be 9999.99 or less')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('maps 422 EFFORT_SPLIT_REJECTED onto the figure it names, and clears it when that figure changes', async () => {
    const user = userEvent.setup();
    const err = new ApiError(
      422,
      'Unprocessable',
      JSON.stringify([{ loc: ['body', 'lab_effort_weeks'], msg: "effort figure 300 puts step 'PDD-H' at 300 weeks", type: 'value_error' }]),
      'EFFORT_SPLIT_REJECTED',
    );
    const onSubmit = renderEdit(vi.fn().mockRejectedValue(err));
    const lab = screen.getByLabelText('Lab effort (client, weeks)');
    await user.clear(lab);
    await user.type(lab, '300');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(await screen.findByText(EFFORT_SPLIT_REJECTED_COPY)).toBeInTheDocument();
    expect(lab).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText('Design effort (client, weeks)')).not.toHaveAttribute('aria-invalid');
    expect(screen.getByText('Nothing was saved. Lower the effort figure marked below.')).toBeInTheDocument();
    await user.clear(lab);
    await user.type(lab, '30');
    expect(screen.queryByText(EFFORT_SPLIT_REJECTED_COPY)).not.toBeInTheDocument();
  });

  it('effortSplitField reads detail[].loc and falls back to the design figure', () => {
    const at = (detail: string | undefined) => effortSplitField(new ApiError(422, 'x', detail, 'EFFORT_SPLIT_REJECTED'));
    expect(at(JSON.stringify([{ loc: ['body', 'design_effort_weeks'], msg: 'm', type: 't' }]))).toBe('design_effort_weeks');
    expect(at(JSON.stringify([{ loc: ['body', 'lab_effort_weeks'], msg: 'm', type: 't' }]))).toBe('lab_effort_weeks');
    expect(at('plain text')).toBe('design_effort_weeks');
    expect(at(undefined)).toBe('design_effort_weeks');
  });

  it('shows the display-only workbook figures read-only (served values, no inputs)', () => {
    renderEdit();
    const block = screen.getByTestId('client-workbook-figures');
    expect(block).toHaveTextContent('From the client workbook (read-only)');
    expect(block).toHaveTextContent('Safety lab3.5 wk');
    expect(block).toHaveTextContent('Actual design18.25 wk');
    expect(block).toHaveTextContent('Actual testing–');
    expect(block).toHaveTextContent('Safety cert. requiredYes');
    expect(block).toHaveTextContent('Capacity flagYes');
    expect(within(block).queryByRole('textbox')).toBeNull();
    expect(within(block).queryByRole('spinbutton')).toBeNull();
  });

  it('the create form has no read-only block (nothing is served yet)', () => {
    renderWithProviders(<ProjectForm mode="create" project={null} hubs={hubs} variant="inline" onOpenChange={vi.fn()} onSubmit={vi.fn()} />);
    expect(screen.queryByTestId('client-workbook-figures')).toBeNull();
    expect(screen.getByLabelText('Design effort (client, weeks)')).toHaveValue(null);
  });

  it('offers AC "Alternative Component" and SER "Service" as types', async () => {
    const user = userEvent.setup();
    renderEdit();
    expect(screen.getByRole('combobox', { name: /^Type/ })).toHaveTextContent('Alternative Component');
    await user.click(screen.getByRole('combobox', { name: /^Type/ }));
    const options = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(options).toEqual(expect.arrayContaining(['Alternative Component', 'Service']));
  });

  it('has no serious/critical axe violations, including a field error', async () => {
    const user = userEvent.setup();
    renderEdit();
    await user.type(screen.getByLabelText('Design effort (client, weeks)'), '.555');
    const form = screen.getByRole('form');
    expect(await seriousAxeViolations(form)).toEqual([]);
  });
});

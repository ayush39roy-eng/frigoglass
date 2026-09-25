import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import type { Hub } from '@/lib/api/reference';

const hooks = { useEngineerOptions: vi.fn() };
vi.mock('../hooks/use-registration', () => ({
  useEngineerOptions: (hubId: string | undefined) => hooks.useEngineerOptions(hubId),
}));

import { ProjectFormDialog } from './project-form';

const hubs: Hub[] = [
  { id: 'hub-1', name: 'R&D-Greece', lab_region: 'Greece', is_oem: false },
  { id: 'hub-2', name: 'PD-Romania', lab_region: 'Romania', is_oem: false },
];

beforeEach(() => {
  vi.clearAllMocks();
  hooks.useEngineerOptions.mockReturnValue({ data: [] });
});

describe('ProjectFormDialog', () => {
  it('create mode: only name and hub are required to save', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderWithProviders(
      <ProjectFormDialog
        mode="create"
        project={null}
        open
        onOpenChange={vi.fn()}
        hubs={hubs}
        onSubmit={onSubmit}
      />,
    );

    expect(screen.getByRole('heading', { name: 'Register a project' })).toBeInTheDocument();
    await user.type(screen.getByLabelText(/^Name/), 'Cooler A');
    await user.click(screen.getByRole('combobox', { name: /^Hub/ }));
    await user.click(await screen.findByRole('option', { name: 'R&D-Greece' }));
    await user.click(screen.getByRole('button', { name: 'Create draft' }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Cooler A',
        hub_id: 'hub-1',
        category: null,
        leader_engineer_id: null,
        carry_over: false,
        delay_weeks: 0,
      }),
    );
  });

  it('does not submit without a name (zod validation)', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderWithProviders(
      <ProjectFormDialog
        mode="create"
        project={null}
        open
        onOpenChange={vi.fn()}
        hubs={hubs}
        onSubmit={onSubmit}
      />,
    );
    await user.click(screen.getByRole('combobox', { name: /^Hub/ }));
    await user.click(await screen.findByRole('option', { name: 'R&D-Greece' }));
    await user.click(screen.getByRole('button', { name: 'Create draft' }));
    expect(await screen.findByText('Name is required')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('edit mode: pre-fills from the existing project and shows the required-field asterisks', () => {
    renderWithProviders(
      <ProjectFormDialog
        mode="edit"
        project={{
          id: 'p1',
          name: 'Cooler A',
          external_code: null,
          hub_id: 'hub-1',
          leader_engineer_id: null,
          category: null,
          type: null,
          priority: null,
          status: 'Draft',
          frozen: false,
          actual_start_week: null,
          delay_weeks: 0,
          reg_year: null,
          carry_over: false,
          comments: null,
          customer_name: null,
          tcogs_eur: 1000,
          selling_price_eur: null,
          gross_margin_pct: null,
          capex_keur: null,
          rm_savings_keur: null,
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        }}
        open
        onOpenChange={vi.fn()}
        hubs={hubs}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Edit Cooler A' })).toBeInTheDocument();
    expect(screen.getByLabelText(/^Name/)).toHaveValue('Cooler A');
    expect(screen.getByLabelText(/TCOGS/)).toHaveValue(1000);
  });

  it('submits every financial field, the leader/category/type/priority selects, the carry-over checkbox, and comments', async () => {
    // P4-T09 (qa-inspector): the "Financial — commercially sensitive" fieldset
    // (customer name / TCOGS / selling price / gross margin / CAPEX / RM savings),
    // the leader/category/type/priority selects, the carry-over checkbox, and the
    // comments textarea were previously never interacted with by any test in this
    // file (only name + hub were ever filled) — leaving every one of those
    // onChange/onCheckedChange/onValueChange handlers uncovered.
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    hooks.useEngineerOptions.mockReturnValue({
      data: [{ id: 'eng-1', name: 'Nikos Papas' }],
    });
    renderWithProviders(
      <ProjectFormDialog
        mode="create"
        project={null}
        open
        onOpenChange={vi.fn()}
        hubs={hubs}
        onSubmit={onSubmit}
      />,
    );

    await user.type(screen.getByLabelText(/^Name/), 'Cooler B');
    await user.click(screen.getByRole('combobox', { name: /^Hub/ }));
    await user.click(await screen.findByRole('option', { name: 'R&D-Greece' }));

    await user.click(screen.getByRole('combobox', { name: /^Leader/ }));
    await user.click(await screen.findByRole('option', { name: 'Nikos Papas' }));

    await user.click(screen.getByRole('combobox', { name: /^Category/ }));
    await user.click(await screen.findByRole('option', { name: 'A' }));

    await user.click(screen.getByRole('combobox', { name: /^Type/ }));
    await user.click(await screen.findByRole('option', { name: /New Model/i }));

    await user.click(screen.getByRole('combobox', { name: /^Priority/ }));
    await user.click(await screen.findByRole('option', { name: 'P1' }));

    await user.click(screen.getByRole('checkbox', { name: /Carried over from a prior year/ }));

    await user.type(screen.getByLabelText(/^Customer name/), 'Acme Retail');
    await user.type(screen.getByLabelText(/^TCOGS/), '1000');
    await user.type(screen.getByLabelText(/^Selling price/), '1500');
    await user.type(screen.getByLabelText(/^Gross margin/), '20');
    await user.type(screen.getByLabelText(/^CAPEX/), '45');
    await user.type(screen.getByLabelText(/^RM savings/), '12');
    await user.type(screen.getByLabelText(/^Actual start week/), '10');
    await user.type(screen.getByLabelText(/^Registration year/), '2026');

    const comments = document.getElementById('reg-comments');
    if (comments) await user.type(comments, 'Needs a second review.');

    await user.click(screen.getByRole('button', { name: 'Create draft' }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Cooler B',
        hub_id: 'hub-1',
        leader_engineer_id: 'eng-1',
        category: 'A',
        type: 'NM',
        priority: 'P1',
        carry_over: true,
        customer_name: 'Acme Retail',
        tcogs_eur: 1000,
        selling_price_eur: 1500,
        gross_margin_pct: 20,
        capex_keur: 45,
        rm_savings_keur: 12,
        actual_start_week: 10,
        reg_year: 2026,
        comments: 'Needs a second review.',
      }),
    );
  });

  it('surfaces a non-ApiError submit failure with a generic retry message', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockRejectedValue(new Error('network down'));
    renderWithProviders(
      <ProjectFormDialog
        mode="create"
        project={null}
        open
        onOpenChange={vi.fn()}
        hubs={hubs}
        onSubmit={onSubmit}
      />,
    );
    await user.type(screen.getByLabelText(/^Name/), 'Cooler C');
    await user.click(screen.getByRole('combobox', { name: /^Hub/ }));
    await user.click(await screen.findByRole('option', { name: 'R&D-Greece' }));
    await user.click(screen.getByRole('button', { name: 'Create draft' }));

    expect(await screen.findByText('The project could not be saved. Please try again.')).toBeInTheDocument();
  });

  it('surfaces a non-forbidden ApiError detail message from the server', async () => {
    const user = userEvent.setup();
    const { ApiError } = await import('@/lib/api/client');
    const onSubmit = vi.fn().mockRejectedValue(new ApiError(422, 'invalid', 'reg_year is out of range'));
    renderWithProviders(
      <ProjectFormDialog
        mode="create"
        project={null}
        open
        onOpenChange={vi.fn()}
        hubs={hubs}
        onSubmit={onSubmit}
      />,
    );
    await user.type(screen.getByLabelText(/^Name/), 'Cooler D');
    await user.click(screen.getByRole('combobox', { name: /^Hub/ }));
    await user.click(await screen.findByRole('option', { name: 'R&D-Greece' }));
    await user.click(screen.getByRole('button', { name: 'Create draft' }));

    expect(await screen.findByText('reg_year is out of range')).toBeInTheDocument();
  });

  it('surfaces a 403 as a role-specific message and never logs the financial fields', async () => {
    const user = userEvent.setup();
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { ApiError } = await import('@/lib/api/client');
    const onSubmit = vi.fn().mockRejectedValue(new ApiError(403, 'forbidden'));
    renderWithProviders(
      <ProjectFormDialog
        mode="create"
        project={null}
        open
        onOpenChange={vi.fn()}
        hubs={hubs}
        onSubmit={onSubmit}
      />,
    );
    await user.type(screen.getByLabelText(/^Name/), 'Cooler A');
    await user.click(screen.getByRole('combobox', { name: /^Hub/ }));
    await user.click(await screen.findByRole('option', { name: 'R&D-Greece' }));
    await user.click(screen.getByRole('button', { name: 'Create draft' }));

    expect(await screen.findByText(/cannot create or edit projects/i)).toBeInTheDocument();
    for (const call of consoleSpy.mock.calls) {
      expect(JSON.stringify(call)).not.toMatch(/tcogs|selling_price|gross_margin|customer_name/i);
    }
    consoleSpy.mockRestore();
  });
});

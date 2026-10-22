import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import type { Hub } from '@/lib/api/reference';

const hooks = { useEngineerOptions: vi.fn() };
vi.mock('../hooks/use-registration', () => ({
  useEngineerOptions: (hubId: string | undefined) => hooks.useEngineerOptions(hubId),
}));

import { ProjectForm, ProjectFormDialog } from './project-form';

// P23: create-mode tests now fill the seven required fields through Radix
// selects and typed inputs, which is slow under a parallel full-suite run.
vi.setConfig({ testTimeout: 30_000 });

const hubs: Hub[] = [
  { id: 'hub-1', name: 'R&D-Greece', lab_region: 'Greece', is_oem: false },
  { id: 'hub-2', name: 'PD-Romania', lab_region: 'Romania', is_oem: false },
];

beforeEach(() => {
  vi.clearAllMocks();
  hooks.useEngineerOptions.mockReturnValue({ data: [{ id: 'eng-1', name: 'Nikos Papas' }] });
});

type User = ReturnType<typeof userEvent.setup>;

/** P23: `POST /projects` requires the eight hard-gate fields (no Draft; ADR 0034
 *  added priority). Fills
 *  them for create-mode tests about something else. Pick a hub first. */
async function fillRequired(
  user: User,
  { category = 'A', priority = 'P2' }: { category?: string | null; priority?: string | null } = {},
): Promise<void> {
  await user.click(screen.getByRole('combobox', { name: /^Leader/ }));
  await user.click(await screen.findByRole('option', { name: 'Nikos Papas' }));
  if (category !== null) {
    await user.click(screen.getByRole('combobox', { name: /^Category/ }));
    await user.click(await screen.findByRole('option', { name: category }));
  }
  await user.click(screen.getByRole('combobox', { name: /^Type/ }));
  await user.click(await screen.findByRole('option', { name: /New Model/i }));
  await user.type(screen.getByLabelText(/^Actual start week/), '10');
  await user.type(screen.getByLabelText(/^TCOGS/), '1000');
  await user.type(screen.getByLabelText(/^Selling price/), '1500');
  await user.type(screen.getByLabelText(/^Gross margin/), '20');
  if (priority !== null) {
    await user.click(screen.getByRole('combobox', { name: /^Priority/ }));
    await user.click(await screen.findByRole('option', { name: priority }));
  }
}

describe('ProjectFormDialog', () => {
  it('create mode (P23): one "Register project" action, no Draft wording, and the hard-gate fields block submit inline', async () => {
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
    expect(screen.queryByRole('button', { name: 'Create draft' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Draft/)).not.toBeInTheDocument();
    await user.type(screen.getByLabelText(/^Name/), 'Cooler A');
    await user.click(screen.getByRole('combobox', { name: /^Hub/ }));
    await user.click(await screen.findByRole('option', { name: 'R&D-Greece' }));
    await user.click(screen.getByRole('button', { name: 'Register project' }));

    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText('Fill in the required fields marked * to register the project.')).toBeInTheDocument();
    for (const msg of [
      'Leader is required.',
      'Category is required.',
      'Type is required.',
      'Actual start week is required.',
      'TCOGS is required.',
      'Selling price is required.',
      'Gross margin is required.',
      'Priority is required.',
    ]) {
      expect(screen.getByText(msg)).toBeInTheDocument();
    }
    expect(screen.getByRole('combobox', { name: /^Leader/ })).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByLabelText(/^TCOGS/)).toHaveAttribute('aria-invalid', 'true');
    // The first missing field gets focus (after paint).
    await vi.waitFor(() => expect(screen.getByRole('combobox', { name: /^Leader/ })).toHaveFocus());

    // Filling a field clears its own message only.
    await user.type(screen.getByLabelText(/^TCOGS/), '1000');
    expect(screen.queryByText('TCOGS is required.')).not.toBeInTheDocument();
    expect(screen.getByText('Gross margin is required.')).toBeInTheDocument();
  });

  it('create mode (P23): with every required field set, submits the whole body', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderWithProviders(
      <ProjectFormDialog mode="create" project={null} open onOpenChange={vi.fn()} hubs={hubs} onSubmit={onSubmit} />,
    );
    await user.type(screen.getByLabelText(/^Name/), 'Cooler A');
    await user.click(screen.getByRole('combobox', { name: /^Hub/ }));
    await user.click(await screen.findByRole('option', { name: 'R&D-Greece' }));
    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: 'Register project' }));

    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Cooler A',
        hub_id: 'hub-1',
        leader_engineer_id: 'eng-1',
        category: 'A',
        type: 'NM',
        actual_start_week: 10,
        tcogs_eur: 1000,
        selling_price_eur: 1500,
        gross_margin_pct: 20,
        priority: 'P2',
        carry_over: false,
        delay_weeks: 0,
      }),
    );
    expect(screen.queryByText(/is required\./)).not.toBeInTheDocument();
  });

  it('create mode (P23-T02): a 422 with the gate shape lands on the fields it names', async () => {
    const user = userEvent.setup();
    const { ApiError } = await import('@/lib/api/client');
    // docs/API_CONTRACT_P23.md §2: labels in missing_fields, request field names in field_errors.
    const detail = JSON.stringify({
      message: 'Project cannot be registered: required fields missing.',
      missing_fields: ['actual start date', 'TCOGS'],
      field_errors: { actual_start_week: 'Actual start week is required.', tcogs_eur: 'TCOGS is required.' },
    });
    const onSubmit = vi.fn().mockRejectedValue(new ApiError(422, 'invalid', detail, 'HARD_GATE_FIELDS_MISSING'));
    renderWithProviders(
      <ProjectFormDialog mode="create" project={null} open onOpenChange={vi.fn()} hubs={hubs} onSubmit={onSubmit} />,
    );
    await user.type(screen.getByLabelText(/^Name/), 'Cooler Z');
    await user.click(screen.getByRole('combobox', { name: /^Hub/ }));
    await user.click(await screen.findByRole('option', { name: 'R&D-Greece' }));
    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: 'Register project' }));

    expect(await screen.findByText('The server needs the required fields marked below.')).toBeInTheDocument();
    expect(screen.getByText('TCOGS is required.')).toBeInTheDocument();
    expect(screen.getByText('Actual start week is required.')).toBeInTheDocument();
    expect(screen.queryByText('Leader is required.')).not.toBeInTheDocument();
    expect(screen.getByLabelText(/^TCOGS/)).toHaveAttribute('aria-invalid', 'true');
    // Never echoes a submitted financial value.
    expect(screen.queryByText(/1000/)).not.toBeInTheDocument();
  });

  it('edit mode does not block on the required fields (existing projects may predate the rule)', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderWithProviders(
      <ProjectFormDialog
        mode="edit"
        project={{
          id: 'p9', name: 'Old cooler', external_code: null, hub_id: 'hub-1', leader_engineer_id: null,
          category: null, type: null, priority: null, status: 'In Queue', frozen: false, actual_start_week: null,
          delay_weeks: 0, reg_year: null, carry_over: false, comments: null, customer_name: null, tcogs_eur: null,
          selling_price_eur: null, gross_margin_pct: null, capex_keur: null, rm_savings_keur: null,
          target_end_week: null, certification_testing_required: true, estimated_design_weeks: null,
          estimated_lab_weeks: null, plant: null, requesting_department: null, product_type: null, scoring_tags: [], tag_dimension_keys: [], schedule_stale: false, workflow_id: 'PDD',
          created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
        }}
        open
        onOpenChange={vi.fn()}
        hubs={hubs}
        onSubmit={onSubmit}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('P27: "Project nature" offers the six tags in order with the helper text; edit pre-ticks the served set and sends the FULL new set', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onDirtyChange = vi.fn();
    renderWithProviders(
      <ProjectForm
        mode="edit"
        variant="inline"
        onDirtyChange={onDirtyChange}
        project={{
          id: 'p9', name: 'Old cooler', external_code: null, hub_id: 'hub-1', leader_engineer_id: null,
          category: null, type: 'NO', priority: null, status: 'In Queue', frozen: false, actual_start_week: null,
          delay_weeks: 0, reg_year: null, carry_over: false, comments: null, customer_name: null, tcogs_eur: null,
          selling_price_eur: null, gross_margin_pct: null, capex_keur: null, rm_savings_keur: null,
          target_end_week: null, certification_testing_required: true, estimated_design_weeks: null,
          estimated_lab_weeks: null, plant: null, requesting_department: null, product_type: null,
          scoring_tags: ['new_options', 'improvement'], tag_dimension_keys: ['new_options', 'quality_improvements'],
          schedule_stale: false, workflow_id: 'PDD',
          created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
        }}
        onOpenChange={vi.fn()}
        hubs={hubs}
        onSubmit={onSubmit}
      />,
    );
    const group = screen.getByRole('group', { name: 'Project nature' });
    const boxes = within(group).getAllByRole('checkbox');
    expect(boxes.map((b) => b.getAttribute('aria-checked') === 'true' ? `[x] ${b.closest('label')?.textContent ?? ''}` : b.closest('label')?.textContent)).toEqual([
      'New Customer',
      'Strategic Project',
      '[x] New Options',
      'Regulatory / Business Compliance',
      'New Models',
      '[x] Improvement',
    ]);
    expect(group).toHaveAccessibleDescription(
      'Ticking one gives that dimension full score (5); it can still be changed in the Matrix.',
    );
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);

    await user.click(within(group).getByRole('checkbox', { name: 'Improvement' }));
    await user.click(within(group).getByRole('checkbox', { name: 'New Customer' }));
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0]?.[0]).toMatchObject({ scoring_tags: ['new_customer', 'new_options'] });
  });

  it('P27: removing every tag sends an empty list (never null or omitted)', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderWithProviders(
      <ProjectForm
        mode="edit"
        variant="inline"
        project={{
          id: 'p9', name: 'Old cooler', external_code: null, hub_id: 'hub-1', leader_engineer_id: null,
          category: null, type: null, priority: null, status: 'In Queue', frozen: false, actual_start_week: null,
          delay_weeks: 0, reg_year: null, carry_over: false, comments: null, customer_name: null, tcogs_eur: null,
          selling_price_eur: null, gross_margin_pct: null, capex_keur: null, rm_savings_keur: null,
          target_end_week: null, certification_testing_required: true, estimated_design_weeks: null,
          estimated_lab_weeks: null, plant: null, requesting_department: null, product_type: null,
          scoring_tags: ['new_models'], tag_dimension_keys: ['new_models'],
          schedule_stale: false, workflow_id: 'PDD',
          created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
        }}
        onOpenChange={vi.fn()}
        hubs={hubs}
        onSubmit={onSubmit}
      />,
    );
    await user.click(screen.getByRole('checkbox', { name: 'New Models' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(onSubmit.mock.calls[0]?.[0]).toHaveProperty('scoring_tags', []);
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
    await user.click(screen.getByRole('button', { name: 'Register project' }));
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
          target_end_week: null,
          certification_testing_required: true,
          estimated_design_weeks: null,
          estimated_lab_weeks: null,
          plant: null,
          requesting_department: null,
          product_type: null, scoring_tags: [], tag_dimension_keys: [],
          schedule_stale: false,
          workflow_id: 'PDD',
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
    // P11 (ADR 0015): an existing project's priority change recalculates.
    expect(screen.getByText('Changing priority recalculates the timeline.')).toBeInTheDocument();
  });

  it('create mode has no recalculation note (a new project waits for the next run)', () => {
    renderWithProviders(
      <ProjectFormDialog mode="create" project={null} open onOpenChange={vi.fn()} hubs={hubs} onSubmit={vi.fn()} />,
    );
    expect(screen.queryByText('Changing priority recalculates the timeline.')).not.toBeInTheDocument();
  });

  it('P11: a 409 HARD_GATE_FORCES_P1 on save shows the hard-gate copy', async () => {
    const user = userEvent.setup();
    const { ApiError } = await import('@/lib/api/client');
    const onSubmit = vi.fn().mockRejectedValue(new ApiError(409, 'conflict', 'hard gates', 'HARD_GATE_FORCES_P1'));
    renderWithProviders(
      <ProjectFormDialog mode="create" project={null} open onOpenChange={vi.fn()} hubs={hubs} onSubmit={onSubmit} />,
    );
    await user.type(screen.getByLabelText(/^Name/), 'Cooler G');
    await user.click(screen.getByRole('combobox', { name: /^Hub/ }));
    await user.click(await screen.findByRole('option', { name: 'R&D-Greece' }));
    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: 'Register project' }));
    expect(
      await screen.findByText('This project has a hard gate (regulatory / certification / safety), so it must stay P1.'),
    ).toBeInTheDocument();
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

    await user.click(screen.getByRole('button', { name: 'Register project' }));

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
        certification_testing_required: true,
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
    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: 'Register project' }));

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
    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: 'Register project' }));

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
    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: 'Register project' }));

    expect(await screen.findByText(/cannot create or edit projects/i)).toBeInTheDocument();
    for (const call of consoleSpy.mock.calls) {
      expect(JSON.stringify(call)).not.toMatch(/tcogs|selling_price|gross_margin|customer_name/i);
    }
    consoleSpy.mockRestore();
  });
});

describe('ProjectFormDialog — P9 planning fields and category-by-hub (ADR 0007)', () => {
  const mixedHubs: Hub[] = [
    { id: 'hub-1', name: 'R&D-Greece', lab_region: 'Greece', is_oem: false },
    { id: 'hub-oem', name: 'OEM-HCK', lab_region: 'Greece', is_oem: true },
  ];

  async function pickHub(user: ReturnType<typeof userEvent.setup>, name: string) {
    await user.click(screen.getByRole('combobox', { name: /^Hub/ }));
    await user.click(await screen.findByRole('option', { name }));
  }

  it('offers OEM categories for an OEM hub and PDD categories for a non-OEM hub (fallback split, no server list)', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <ProjectFormDialog mode="create" project={null} open onOpenChange={vi.fn()} hubs={mixedHubs} onSubmit={vi.fn()} />,
    );
    await pickHub(user, 'OEM-HCK');
    await user.click(screen.getByRole('combobox', { name: /^Category/ }));
    const oemOptions = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(oemOptions).toEqual(['Unset', 'A-OEM', 'B-OEM', 'C-OEM']);
    await user.keyboard('{Escape}');

    await pickHub(user, 'R&D-Greece');
    await user.click(screen.getByRole('combobox', { name: /^Category/ }));
    const pddOptions = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(pddOptions).toEqual(['Unset', 'A+', 'A', 'B', 'C']);
  });

  it('clears a category that is invalid for the newly selected hub', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderWithProviders(
      <ProjectFormDialog mode="create" project={null} open onOpenChange={vi.fn()} hubs={mixedHubs} onSubmit={onSubmit} />,
    );
    await user.type(screen.getByLabelText(/^Name/), 'Cooler OEM');
    await pickHub(user, 'R&D-Greece');
    await fillRequired(user, { category: 'A+' });
    await pickHub(user, 'OEM-HCK');
    await user.click(screen.getByRole('button', { name: 'Register project' }));
    // The cleared category is now the one missing required field (P23).
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText('Category is required.')).toBeInTheDocument();
    expect(screen.queryByText('Leader is required.')).not.toBeInTheDocument();
  });

  it('submits target_end_week, certification_testing_required (default on) and the estimated weeks', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderWithProviders(
      <ProjectFormDialog mode="create" project={null} open onOpenChange={vi.fn()} hubs={mixedHubs} onSubmit={onSubmit} />,
    );
    await user.type(screen.getByLabelText(/^Name/), 'Cooler P');
    await pickHub(user, 'R&D-Greece');
    await user.type(screen.getByLabelText(/^Expected completion \(week\)/), '44');
    await user.type(screen.getByLabelText(/^Estimated design weeks/), '18');
    await user.type(screen.getByLabelText(/^Estimated lab weeks/), '10');
    expect(screen.getByRole('checkbox', { name: /Certification testing required/ })).toHaveAttribute('data-state', 'checked');
    expect(screen.getByText('Lab steps are skipped when off.')).toBeInTheDocument();
    await user.click(screen.getByRole('checkbox', { name: /Certification testing required/ }));
    await fillRequired(user);
    await user.click(screen.getByRole('button', { name: 'Register project' }));
    expect(onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        target_end_week: 44,
        certification_testing_required: false,
        estimated_design_weeks: 18,
        estimated_lab_weeks: 10,
      }),
    );
  });

  it('rejects an expected-completion week outside the 52-week plan year (ADR 0024)', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    renderWithProviders(
      <ProjectFormDialog mode="create" project={null} open onOpenChange={vi.fn()} hubs={mixedHubs} onSubmit={onSubmit} />,
    );
    await user.type(screen.getByLabelText(/^Name/), 'Cooler Q');
    await pickHub(user, 'R&D-Greece');
    await user.type(screen.getByLabelText(/^Expected completion \(week\)/), '53');
    await user.click(screen.getByRole('button', { name: 'Register project' }));
    expect(await screen.findByText('Must be 52 or less')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('ProjectForm — unsaved-changes reporting (P22-T01)', () => {
  const existing = {
    id: 'p-1', name: 'Cooler A', external_code: null, hub_id: 'hub-1', leader_engineer_id: null,
    category: 'A' as const, type: null, priority: 'P2' as const, status: 'In Queue' as const, frozen: false,
    actual_start_week: null, delay_weeks: 0, reg_year: 2026, carry_over: false, comments: 'one\r\ntwo',
    customer_name: null, tcogs_eur: 100.5, selling_price_eur: null, gross_margin_pct: null, capex_keur: null,
    rm_savings_keur: null, target_end_week: null, certification_testing_required: true,
    estimated_design_weeks: null, estimated_lab_weeks: null, plant: null, requesting_department: null, product_type: null, scoring_tags: [], tag_dimension_keys: [], schedule_stale: false, workflow_id: 'PDD' as const,
    created_at: '', updated_at: '',
  };

  it('a freshly opened edit form is clean; an edit makes it dirty; undoing the edit makes it clean again', async () => {
    const user = userEvent.setup();
    const onDirtyChange = vi.fn();
    renderWithProviders(
      <ProjectForm
        mode="edit"
        project={existing}
        hubs={hubs}
        variant="inline"
        onOpenChange={vi.fn()}
        onSubmit={vi.fn()}
        onDirtyChange={onDirtyChange}
      />,
    );
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
    expect(onDirtyChange).not.toHaveBeenCalledWith(true);

    const name = screen.getByLabelText(/^Name/);
    await user.type(name, 'X');
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    await user.type(name, '{Backspace}');
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);

    await user.click(screen.getByRole('combobox', { name: /^Priority/ }));
    await user.click(await screen.findByRole('option', { name: 'P3' }));
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  });

  it('a fresh create form is clean until something is typed', async () => {
    const user = userEvent.setup();
    const onDirtyChange = vi.fn();
    renderWithProviders(
      <ProjectForm mode="create" project={null} hubs={hubs} variant="inline" onOpenChange={vi.fn()} onSubmit={vi.fn()} onDirtyChange={onDirtyChange} />,
    );
    expect(onDirtyChange).not.toHaveBeenCalledWith(true);
    await user.type(screen.getByLabelText('Comments'), 'note');
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
  });
});

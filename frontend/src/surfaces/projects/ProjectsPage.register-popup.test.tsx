import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UseQueryResult } from '@tanstack/react-query';

import { renderWithProviders } from '@/test/render';
import { seriousAxeViolations } from '@/test/axe';
import type { ProjectFilterParams, ProjectFilterResult, ProjectFilterRow } from '@/surfaces/dashboard/api/types';
import { P13_ROW_DEFAULTS } from '@/surfaces/dashboard/test-fixtures';
import type { ProjectRead } from '@/surfaces/registration/api/types';

import type { RegisterStepsResponse } from './api/register-edits';

/**
 * P44-T01 (owner 2026-11-18): the Projects row "Edit" edits the row in place
 * and no longer opens this popup; the popup stays as the project folder's
 * "Edit". These tests open it through the folder's host
 * (`test-folder-edit.tsx` → `WorkspaceEditHost`), and pin that the Projects
 * row does not open it.
 *
 * Register popup (owner 2026-11-17): the folder's "Edit" opens ONE popup with the
 * identity fields AND the register fields (status, hub, leader, actual dates,
 * design / lab time, lab testing, current step, step chips). One Save: the
 * changed identity fields through `PATCH /projects/{id}`, the register fields
 * as ONE patch of ONE `POST /projects/register-edits`. The list hook is mocked
 * at the hook; every request at the HTTP client.
 */

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 60,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ key: index, index, start: index * 60, size: 60 })),
    measureElement: () => undefined,
    measure: () => undefined,
    scrollToIndex: () => undefined,
  }),
}));

const useDashboardProjects = vi.fn();
vi.mock('@/surfaces/dashboard/hooks/use-dashboard', () => ({
  useDashboardProjects: (params: ProjectFilterParams) => useDashboardProjects(params),
  useProjectFacets: () => ({ data: { leaders: [], steps: [] } }),
}));
vi.mock('@/lib/api/reference', () => ({
  useHubs: () => ({
    data: [
      { id: 'hub-1', name: 'R&D-Greece', lab_region: 'Greece', is_oem: false, capacity_hub_id: null, capacity_hub_name: null },
      { id: 'hub-2', name: 'PD-India', lab_region: 'India', is_oem: false, capacity_hub_id: null, capacity_hub_name: null },
      { id: 'hub-3', name: 'OEM-HCK', lab_region: 'Romania', is_oem: true, capacity_hub_id: null, capacity_hub_name: null },
    ],
  }),
  useCategoriesForHub: () => ({ data: undefined, options: ['A+', 'A', 'B', 'C'] }),
}));
vi.mock('@/surfaces/project-workspace/api/workspace-api', () => ({ askAgent: vi.fn() }));
vi.mock('@/lib/download', () => ({ saveBlob: vi.fn() }));
vi.mock('@/lib/api/sse', () => ({ streamSolverProgress: vi.fn() }));

const http = vi.hoisted(() => ({ get: vi.fn(), send: vi.fn(), sendWithHeaders: vi.fn(), download: vi.fn() }));
vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return {
    ...actual,
    apiGet: (path: string, opts?: unknown) => http.get(path, opts),
    apiSend: (method: string, path: string, body?: unknown) => http.send(method, path, body),
    apiSendWithHeaders: (method: string, path: string, body?: unknown) => http.sendWithHeaders(method, path, body),
    apiDownload: (path: string, opts: unknown) => http.download(path, opts),
  };
});

import { ApiError } from '@/lib/api/client';
import ProjectsPage from './ProjectsPage';
import { FolderEditHarness } from './test-folder-edit';

vi.setConfig({ testTimeout: 30_000 });

const P1 = '3f2b8c1e-9a4d-4e6f-8b2a-1c0d9e8f7a65';

function ok(rows: ProjectFilterRow[]): UseQueryResult<ProjectFilterResult> {
  return { data: { total_count: rows.length, rows }, isPending: false, isError: false, refetch: vi.fn() } as unknown as UseQueryResult<ProjectFilterResult>;
}

const ROW: ProjectFilterRow = {
  project_id: P1,
  project_name: 'Cooler A',
  hub: 'R&D-Greece',
  category: 'B',
  status: 'In Development',
  priority: 'P2',
  is_vip: false,
  tracking_status: 'idle',
  ...P13_ROW_DEFAULTS,
  leader_engineer_id: 'eng-1',
  leader_name: 'Nikos Papas',
  design_weeks_calculated: 10,
  lab_weeks_calculated: 6,
  end_week: 44,
} as ProjectFilterRow;

const PROJECT: ProjectRead = {
  id: P1,
  name: 'Cooler A',
  external_code: null,
  hub_id: 'hub-1',
  leader_engineer_id: 'eng-1',
  leader_is_provisional: false,
  category: 'B',
  type: null,
  priority: 'P2',
  status: 'In Development',
  frozen: false,
  actual_start_week: 10,
  actual_end_week: null,
  delay_weeks: 0,
  reg_year: null,
  carry_over: false,
  comments: null,
  customer_name: null,
  tcogs_eur: null,
  selling_price_eur: null,
  gross_margin_pct: null,
  capex_keur: null,
  rm_savings_keur: null,
  target_end_week: null,
  certification_testing_required: true,
  estimated_design_weeks: null,
  estimated_lab_weeks: null,
  design_effort_weeks: null,
  lab_effort_weeks: 4,
  safety_lab_weeks: null,
  actual_design_weeks: null,
  actual_testing_weeks: null,
  safety_certification_required: false,
  capacity_flag: false,
  plant: null,
  requesting_department: null,
  product_type: null,
  scoring_tags: [],
  tag_dimension_keys: [],
  schedule_stale: false,
  workflow_id: 'PDD',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

const STEPS: RegisterStepsResponse = {
  project_id: P1,
  current_step_code: 'PDD-B',
  end_week: 44,
  design_weeks_calculated: 10,
  lab_weeks_calculated: 6,
  steps: [
    { step_code: 'PDD-A', step_name: 'Concept', kind: 'design', status: 'Done', step_excluded: false, applicable: true, excludable: false, is_current: false },
    { step_code: 'PDD-B', step_name: 'Feasibility', kind: 'design', status: 'In Progress', step_excluded: false, applicable: true, excludable: true, is_current: true },
    { step_code: 'PDD-C', step_name: 'Design review', kind: 'design', status: 'Not Started', step_excluded: false, applicable: true, excludable: true, is_current: false },
    { step_code: 'PDD-D', step_name: 'Prototype', kind: 'design', status: 'Skipped', step_excluded: false, applicable: false, excludable: false, is_current: false },
    { step_code: 'PDD-E', step_name: 'Design detailing', kind: 'design', status: 'Skipped', step_excluded: true, applicable: true, excludable: false, is_current: false },
    { step_code: 'PDD-F', step_name: 'Safety lab', kind: 'lab', status: 'Not Started', step_excluded: false, applicable: true, excludable: true, is_current: false },
    { step_code: 'PDD-G', step_name: 'Certification', kind: 'lab', status: 'Not Started', step_excluded: false, applicable: true, excludable: true, is_current: false },
    // An applicable step the split gave 0 weeks (R35-2: "0 wk (split)", excludable, never N/A).
    { step_code: 'PDD-H', step_name: 'Tooling', kind: 'design', status: 'Skipped', step_excluded: false, applicable: true, excludable: true, is_current: false },
    // Elapsed (waiting) steps are served too (contract §1).
    { step_code: 'PDD-L', step_name: 'Supplier lead time', kind: 'elapsed', status: 'Not Started', step_excluded: false, applicable: true, excludable: true, is_current: false },
  ],
};

const ENGINEERS = [
  { id: 'eng-1', name: 'Nikos Papas', hub_id: 'hub-1' },
  { id: 'eng-2', name: 'Maria Kosta', hub_id: 'hub-1' },
];

const NOT_NEEDED = {
  project_ids: [P1],
  projects_marked_stale: [],
  recalc_status: 'not_needed',
  schedule_run_id: null,
  baseline_run_id: null,
  task_id: null,
};

const batchCalls = () => http.send.mock.calls.filter((c) => c[1] === '/projects/register-edits');

beforeEach(() => {
  vi.clearAllMocks();
  http.get.mockImplementation((path: string) => {
    if (path === `/projects/${P1}`) return Promise.resolve(PROJECT);
    if (path === `/projects/${P1}/register-steps`) return Promise.resolve(STEPS);
    if (path === '/engineers') return Promise.resolve(ENGINEERS);
    return Promise.reject(new ApiError(404, 'not found'));
  });
  http.send.mockResolvedValue(NOT_NEEDED);
  http.sendWithHeaders.mockResolvedValue({ data: PROJECT, headers: new Headers() });
  useDashboardProjects.mockReturnValue(ok([ROW]));
});

async function openPopup(user: ReturnType<typeof userEvent.setup>): Promise<HTMLElement> {
  renderWithProviders(<FolderEditHarness projectId={P1} projectName="Cooler A" />);
  await user.click(screen.getByTestId('folder-edit'));
  const dialog = await screen.findByRole('dialog', { name: 'Edit Cooler A' });
  await within(dialog).findAllByTestId('step-chip');
  return dialog;
}

const chip = (dialog: HTMLElement, code: string): HTMLElement =>
  within(dialog).getByRole('button', { name: new RegExp(`^Exclude ${code} `) });

describe('Register popup — opens from the project folder Edit, not from the Projects row', () => {
  it('the Projects row Edit edits the row in place: no popup, no GET of the popup', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProjectsPage />);
    await user.click(screen.getByRole('button', { name: 'Edit Cooler A' }));
    expect(screen.getByRole('button', { name: 'Done editing Cooler A' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Status of Cooler A' })).toBeInTheDocument();
  });

  it('shows identity AND register fields; the form no longer has its own hub / leader / start inputs', async () => {
    const user = userEvent.setup();
    const dialog = await openPopup(user);
    // Identity kept.
    expect(within(dialog).getByLabelText(/^Name/)).toHaveValue('Cooler A');
    expect(within(dialog).getByLabelText(/^External code/)).toBeInTheDocument();
    expect(within(dialog).getByRole('combobox', { name: /^Priority/ })).toBeInTheDocument();
    // Register fields.
    const section = within(dialog).getByTestId('register-popup-section');
    expect(within(section).getByLabelText('Status')).toHaveValue('In Development');
    expect(within(section).getByLabelText('Hub')).toHaveValue('hub-1');
    expect(await within(section).findByRole('option', { name: 'Maria Kosta' })).toBeInTheDocument();
    expect(within(section).getByLabelText('Leader')).toHaveValue('eng-1');
    expect(within(section).getByLabelText(/^Actual start/)).toHaveValue('2026-03-02');
    expect(within(section).getByLabelText(/^Actual end/)).toHaveValue('');
    expect(within(section).getByLabelText(/^Current step/)).toHaveValue('PDD-B');
    expect(within(section).getByRole('checkbox', { name: 'Needs lab testing' })).toBeChecked();
    // Green calculated (no figure) vs orange manual (typed figure).
    const design = within(section).getByLabelText(/^Design time/);
    expect(design).toHaveAttribute('data-source', 'calculated');
    expect(design).toHaveAttribute('placeholder', '10');
    const lab = within(section).getByLabelText(/^Lab time/);
    expect(lab).toHaveAttribute('data-source', 'manual');
    expect(lab).toHaveValue('4');
    expect(within(section).getByRole('button', { name: 'Reset Lab time to the calculated 6 wk' })).toBeInTheDocument();
    // The form's own copies are gone (one control per field).
    expect(within(dialog).getAllByRole('combobox', { name: /^Leader/ })).toHaveLength(1);
    expect(within(dialog).getAllByRole('combobox', { name: /^Hub/ })).toHaveLength(1);
    expect(within(dialog).queryByLabelText(/^Actual start week/)).not.toBeInTheDocument();
    expect(within(dialog).queryByRole('checkbox', { name: 'Certification testing required' })).not.toBeInTheDocument();
    expect(http.get).toHaveBeenCalledWith(`/projects/${P1}/register-steps`, expect.anything());
  });

  it('End wk (forecast) is read-only: the served week, no input', async () => {
    const user = userEvent.setup();
    const dialog = await openPopup(user);
    const end = within(dialog).getByTestId('popup-end-week');
    expect(end).toHaveTextContent('W44');
    expect(end).toHaveTextContent('read-only, set by the scheduler');
    expect(end.tagName).not.toBe('INPUT');
    expect(within(end).queryByRole('textbox')).not.toBeInTheDocument();
    expect(within(dialog).queryByLabelText(/^End wk/)).not.toBeInTheDocument();
  });
});

describe('Register popup — one Save', () => {
  it('register edits produce exactly ONE register-edits patch with only the changed keys, and no PATCH', async () => {
    const user = userEvent.setup();
    const dialog = await openPopup(user);
    const section = within(dialog).getByTestId('register-popup-section');
    await user.selectOptions(within(section).getByLabelText('Status'), 'On Hold');
    await within(section).findByRole('option', { name: 'Maria Kosta' });
    await user.selectOptions(within(section).getByLabelText('Leader'), 'eng-2');
    fireEvent.change(within(section).getByLabelText(/^Actual end/), { target: { value: '2026-04-06' } }); // W15
    await user.type(within(section).getByLabelText(/^Design time/), '7');
    await user.click(within(section).getByRole('button', { name: 'Reset Lab time to the calculated 6 wk' }));
    await user.selectOptions(within(section).getByLabelText('Hub'), 'hub-2');
    await user.click(chip(dialog, 'PDD-C'));
    await user.click(chip(dialog, 'PDD-E')); // served excluded → re-include
    await user.selectOptions(within(section).getByLabelText(/^Current step/), 'PDD-F');
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(batchCalls()).toHaveLength(1));
    expect(batchCalls()[0]![2]).toEqual({
      edits: [
        {
          project_id: P1,
          status: 'On Hold',
          hub_id: 'hub-2',
          leader_engineer_id: 'eng-2',
          actual_end_week: 15,
          design_effort_weeks: 7,
          lab_effort_weeks: null,
          current_step_code: 'PDD-F',
          step_exclusions: [
            { step_code: 'PDD-C', step_excluded: true },
            { step_code: 'PDD-E', step_excluded: false },
          ],
        },
      ],
    });
    // Nothing of the identity changed: no PATCH at all.
    expect(http.sendWithHeaders).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    // The host's "recalculating" panel reports the server's answer.
    expect(await screen.findByTestId('register-save-panel')).toHaveTextContent('Edits saved');
  });

  it('the panel lists the served step-duration changes (eff_changes) as served', async () => {
    const user = userEvent.setup();
    http.send.mockResolvedValue({
      ...NOT_NEEDED,
      recalc_status: 'deferred',
      eff_changes: [
        { project_id: P1, step_code: 'PDD-C', eff_before: 3, eff_after: 0, revived: false, skipped_now: true },
        { project_id: P1, step_code: 'PDD-H', eff_before: 0, eff_after: 1, revived: true, skipped_now: false },
      ],
    });
    const dialog = await openPopup(user);
    await user.click(chip(dialog, 'PDD-C'));
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    const list = await screen.findByTestId('register-save-eff-changes');
    expect(list).toHaveTextContent('PDD-C: 3 → 0 wk, skipped now');
    expect(list).toHaveTextContent('PDD-H: 0 → 1 wk, runs again');
  });

  it('identity + register: the PATCH carries only the changed identity field, the batch only the register field', async () => {
    const user = userEvent.setup();
    const dialog = await openPopup(user);
    await user.type(within(dialog).getByLabelText(/^External code/), 'RPD-9');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Needs lab testing' }));
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    await waitFor(() => expect(batchCalls()).toHaveLength(1));
    expect(http.sendWithHeaders).toHaveBeenCalledTimes(1);
    expect(http.sendWithHeaders.mock.calls[0]).toEqual(['PATCH', `/projects/${P1}`, { external_code: 'RPD-9' }]);
    expect(batchCalls()[0]![2]).toEqual({ edits: [{ project_id: P1, certification_testing_required: false }] });
  });

  it('Save with nothing changed sends nothing and closes', async () => {
    const user = userEvent.setup();
    const dialog = await openPopup(user);
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(http.send).not.toHaveBeenCalled();
    expect(http.sendWithHeaders).not.toHaveBeenCalled();
  });
});

describe('Register popup — step chips', () => {
  it('click and keyboard (Space / Enter) toggle exclusion; aria-pressed and the struck state follow', async () => {
    const user = userEvent.setup();
    const dialog = await openPopup(user);
    const c = chip(dialog, 'PDD-C');
    expect(c).toHaveAccessibleName('Exclude PDD-C Design review, design step');
    expect(c).toHaveAttribute('aria-pressed', 'false');
    expect(c).toHaveAttribute('data-kind', 'design');
    await user.click(c);
    expect(c).toHaveAttribute('aria-pressed', 'true');
    expect(c).toHaveAttribute('data-state', 'excluded');
    expect(c).toHaveAttribute('data-changed', 'true');
    expect(c).toHaveTextContent('off');

    c.focus();
    await user.keyboard(' ');
    expect(c).toHaveAttribute('aria-pressed', 'false');
    const f = chip(dialog, 'PDD-F');
    expect(f).toHaveAttribute('data-kind', 'lab');
    f.focus();
    await user.keyboard('{Enter}');
    expect(f).toHaveAttribute('aria-pressed', 'true');
  });

  it('N/A and Done chips are disabled; the current step is ringed', async () => {
    const user = userEvent.setup();
    const dialog = await openPopup(user);
    const na = chip(dialog, 'PDD-D');
    expect(na).toBeDisabled();
    expect(na).toHaveAccessibleName(/not applicable/);
    expect(na).toHaveAttribute('data-state', 'na');
    expect(na).toHaveTextContent('N/A');
    const done = chip(dialog, 'PDD-A');
    expect(done).toBeDisabled();
    expect(done).toHaveAccessibleName(/done$/);
    await user.click(done);
    expect(done).toHaveAttribute('aria-pressed', 'false');
    const current = chip(dialog, 'PDD-B');
    expect(current).toHaveAttribute('data-current', 'true');
    expect(current).toHaveAccessibleName(/current step/);
    expect(current).toHaveClass('ring-primary');
    // A served-excluded step can be re-included.
    expect(chip(dialog, 'PDD-E')).toBeEnabled();
    expect(chip(dialog, 'PDD-E')).toHaveAttribute('aria-pressed', 'true');
  });

  it('a step the split zeroed reads "0 wk (split)" and stays excludable; elapsed steps are neutral', async () => {
    const user = userEvent.setup();
    const dialog = await openPopup(user);
    const h = chip(dialog, 'PDD-H');
    expect(h).toBeEnabled();
    expect(h).toHaveTextContent('0 wk (split)');
    expect(h).toHaveAccessibleName(/0 weeks after the split/);
    const l = chip(dialog, 'PDD-L');
    expect(l).toHaveAttribute('data-kind', 'elapsed');
    expect(l).toHaveAccessibleName('Exclude PDD-L Supplier lead time, elapsed step');
  });

  it('a frozen project locks every chip, re-include included, and the current step', async () => {
    const user = userEvent.setup();
    http.get.mockImplementation((path: string) => {
      if (path === `/projects/${P1}`) return Promise.resolve({ ...PROJECT, frozen: true });
      if (path === `/projects/${P1}/register-steps`) {
        return Promise.resolve({ ...STEPS, steps: STEPS.steps.map((st) => ({ ...st, excludable: false })) });
      }
      if (path === '/engineers') return Promise.resolve(ENGINEERS);
      return Promise.reject(new ApiError(404, 'not found'));
    });
    const dialog = await openPopup(user);
    expect(chip(dialog, 'PDD-C')).toBeDisabled();
    expect(chip(dialog, 'PDD-E')).toBeDisabled();
    expect(chip(dialog, 'PDD-E')).toHaveAccessibleName(/project frozen/);
    expect(within(dialog).getByLabelText(/^Current step/)).toBeDisabled();
  });

  it('turning lab testing off locks the lab chips until saved', async () => {
    const user = userEvent.setup();
    const dialog = await openPopup(user);
    await user.click(chip(dialog, 'PDD-F'));
    expect(chip(dialog, 'PDD-F')).toHaveAttribute('aria-pressed', 'true');
    await user.click(within(dialog).getByRole('checkbox', { name: 'Needs lab testing' }));
    expect(chip(dialog, 'PDD-F')).toBeDisabled();
    // The staged lab exclusion was dropped with the flag change.
    expect(chip(dialog, 'PDD-F')).toHaveAttribute('aria-pressed', 'false');
  });
});

describe('Register popup — current step', () => {
  it('offers applicable, non-excluded steps; moving it shows "Earlier steps will be marked Done"', async () => {
    const user = userEvent.setup();
    const dialog = await openPopup(user);
    const select = within(dialog).getByLabelText(/^Current step/);
    const values = within(select).getAllByRole('option').map((o) => (o as HTMLOptionElement).value);
    // Skipped steps (N/A, excluded, split to 0) cannot be current (contract §3).
    expect(values).toEqual(['PDD-A', 'PDD-B', 'PDD-C', 'PDD-F', 'PDD-G', 'PDD-L']);
    expect(within(dialog).queryByTestId('current-step-note')).not.toBeInTheDocument();
    await user.selectOptions(select, 'PDD-C');
    expect(within(dialog).getByTestId('current-step-note')).toHaveTextContent('Earlier steps will be marked Done.');
    await user.selectOptions(select, 'PDD-A');
    expect(within(dialog).getByTestId('current-step-note')).toHaveTextContent(
      'Earlier steps will be marked Done; later steps go back to Not Started.',
    );
    await user.selectOptions(select, 'PDD-B');
    expect(within(dialog).queryByTestId('current-step-note')).not.toBeInTheDocument();
    // Excluding a step takes it out of the list.
    await user.click(chip(dialog, 'PDD-C'));
    expect(within(select).queryByRole('option', { name: /PDD-C/ })).not.toBeInTheDocument();
  });
});

describe('Register popup — server errors and guards', () => {
  it('a 422 shows each error inline on its field and the named chip; the edits are kept', async () => {
    const user = userEvent.setup();
    http.send.mockRejectedValue(
      new ApiError(
        422,
        'invalid',
        JSON.stringify({
          code: 'REGISTER_EDITS_INVALID',
          message: 'One or more rows are invalid.',
          errors: [
            { project_id: P1, code: 'STEP_DONE', message: 'PDD-C is Done' },
            { project_id: P1, code: 'ACTUAL_END_BEFORE_START', message: 'end before start' },
            { project_id: P1, code: 'EFFORT_NEEDS_A_STEP', message: 'Design time needs at least one design step.' },
          ],
        }),
        'REGISTER_EDITS_INVALID',
      ),
    );
    const dialog = await openPopup(user);
    await user.click(chip(dialog, 'PDD-C'));
    fireEvent.change(within(dialog).getByLabelText(/^Actual end/), { target: { value: '2026-02-02' } });
    await user.click(within(dialog).getByRole('button', { name: 'Save changes' }));

    expect(await within(dialog).findByTestId('steps-error')).toHaveTextContent('A Done step cannot be excluded.');
    expect(within(dialog).getByTestId('steps-error')).toHaveTextContent('Design time needs at least one design step.');
    // The error row names no step: the chip this Save changed is marked.
    expect(chip(dialog, 'PDD-C')).toHaveAttribute('aria-invalid', 'true');
    expect(chip(dialog, 'PDD-F')).not.toHaveAttribute('aria-invalid');
    expect(within(dialog).getByText('Actual end is before actual start.')).toBeInTheDocument();
    expect(within(dialog).getByLabelText(/^Actual end/)).toHaveAttribute('aria-invalid', 'true');
    expect(within(dialog).getByText(/Nothing was saved\. Fix the highlighted rows/)).toBeInTheDocument();
    // Still open, edits kept.
    expect(screen.getByRole('dialog', { name: 'Edit Cooler A' })).toBeInTheDocument();
    expect(chip(dialog, 'PDD-C')).toHaveAttribute('aria-pressed', 'true');
  });

  it('closing with an unsaved register edit asks first; Discard closes without saving', async () => {
    const user = userEvent.setup();
    const dialog = await openPopup(user);
    await user.click(chip(dialog, 'PDD-C'));
    await user.keyboard('{Escape}');
    const confirm = await screen.findByRole('alertdialog', { name: 'Discard unsaved changes?' });
    await user.click(within(confirm).getByRole('button', { name: 'Keep editing' }));
    expect(chip(dialog, 'PDD-C')).toHaveAttribute('aria-pressed', 'true');
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await user.click(await screen.findByRole('button', { name: 'Discard changes' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(http.send).not.toHaveBeenCalled();
  });

  it('has no serious axe violations', async () => {
    const user = userEvent.setup();
    const dialog = await openPopup(user);
    await user.click(chip(dialog, 'PDD-C'));
    expect(await seriousAxeViolations(dialog)).toEqual([]);
  });
});

describe('Register row edit — editable affordance', () => {
  it('editable column headers carry a pencil cue while a row is in edit; selects have a chevron', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ProjectsPage />);
    expect(screen.queryAllByTestId('editable-column-cue')).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: 'Edit Cooler A' }));
    // Hub, status, leader, actual start / end, design / lab time, current step, steps, priority.
    expect(screen.getAllByTestId('editable-column-cue')).toHaveLength(10);
    const status = screen.getByRole('combobox', { name: 'Status of Cooler A' });
    expect(status).toHaveClass('appearance-none');
    expect(status).toHaveClass('hover:border-primary/60');
  });
});

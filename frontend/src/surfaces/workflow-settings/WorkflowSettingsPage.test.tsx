import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import { ROLE_MATRIX } from '@/test/roles';
import { ApiError } from '@/lib/api/client';

import { settingsFixture } from './test-fixtures';

const hooks = {
  useWorkflowSettings: vi.fn(),
  saveSteps: vi.fn(),
  saveLeadTimes: vi.fn(),
  saveCalendar: vi.fn(),
  saveChamber: vi.fn(),
};
const mut = (fn: ReturnType<typeof vi.fn>) => ({ mutateAsync: fn, isPending: false });
vi.mock('./hooks/use-workflow-settings', () => ({
  useWorkflowSettings: () => hooks.useWorkflowSettings(),
  useSaveSteps: () => mut(hooks.saveSteps),
  useSaveLeadTimes: () => mut(hooks.saveLeadTimes),
  useSaveHubCalendar: () => mut(hooks.saveCalendar),
  useSaveChamber: () => mut(hooks.saveChamber),
}));

import WorkflowSettingsPage from './WorkflowSettingsPage';

function ready() {
  return { data: settingsFixture(), isPending: false, isError: false, error: null, refetch: vi.fn() };
}
const saved = (staleCount: number) => Promise.resolve({ settings: settingsFixture(), staleCount });

beforeEach(() => {
  vi.clearAllMocks();
  hooks.useWorkflowSettings.mockReturnValue(ready());
  for (const k of ['saveSteps', 'saveLeadTimes', 'saveCalendar', 'saveChamber'] as const) {
    hooks[k].mockImplementation(() => saved(236));
  }
});

describe('WorkflowSettingsPage — steps & precedence', () => {
  it('lists the 14 steps with kind badges (text, not colour alone) and the inline DAG', () => {
    renderWithProviders(<WorkflowSettingsPage />);
    expect(screen.getByTestId('step-row-PDD-C')).toHaveTextContent('Elapsed');
    expect(screen.getByTestId('step-row-PDD-F')).toHaveTextContent('Lab');
    expect(screen.getByTestId('step-row-PDD-A')).toHaveTextContent('Design');
    expect(screen.getByRole('img', { name: /strict sequence, 14 steps, nothing runs in parallel/ })).toBeInTheDocument();
  });

  it('letting TF-1 start after CAPEX (not Certification) shows "runs in parallel" and saves all 14 steps', async () => {
    const user = userEvent.setup();
    renderWithProviders(<WorkflowSettingsPage />);
    await user.click(screen.getByRole('button', { name: 'Can start after — TF-1' }));
    await user.click(await screen.findByRole('checkbox', { name: 'G Online CAPEX Approval' }));
    await user.click(screen.getByRole('checkbox', { name: 'H Certification Testing & Compliance' }));
    await user.keyboard('{Escape}');
    // J still depends on I only — so H must be a predecessor of J for H to finish before pre-production
    expect(screen.getByTestId('parallel-PDD-I')).toHaveTextContent('H');
    expect(screen.getByTestId('parallel-PDD-H')).toHaveTextContent('I');

    await user.click(screen.getByRole('button', { name: 'Save steps' }));
    expect(hooks.saveSteps).toHaveBeenCalledTimes(1);
    const { workflowId, body } = hooks.saveSteps.mock.calls[0]![0] as {
      workflowId: string;
      body: { steps: { step_id: string; predecessor_ids: string[] }[] };
    };
    expect(workflowId).toBe('PDD');
    expect(body.steps).toHaveLength(14);
    expect(body.steps.find((s) => s.step_id === 'PDD-I')?.predecessor_ids).toEqual(['PDD-G']);
    expect(await screen.findByTestId('stale-banner')).toHaveTextContent(
      'Workflow settings changed — 236 projects need a recalculation.',
    );
  });

  it('refuses to save an empty predecessor set and names the rule (client mirror of the server)', async () => {
    const user = userEvent.setup();
    renderWithProviders(<WorkflowSettingsPage />);
    await user.click(screen.getByRole('button', { name: 'Can start after — Pilot' }));
    await user.click(await screen.findByRole('checkbox', { name: 'K TF-2' }));
    await user.keyboard('{Escape}');
    expect(screen.getByRole('alert')).toHaveTextContent('EMPTY_PREDECESSORS');
    expect(screen.getByRole('button', { name: 'Save steps' })).toBeDisabled();
  });

  it('surfaces a server 422 code verbatim', async () => {
    const user = userEvent.setup();
    hooks.saveSteps.mockRejectedValue(new ApiError(422, 'bad', 'Cycle through PDD-C', 'CYCLE'));
    renderWithProviders(<WorkflowSettingsPage />);
    await user.click(screen.getByRole('button', { name: 'Can start after — TF-1' }));
    await user.click(await screen.findByRole('checkbox', { name: 'G Online CAPEX Approval' }));
    await user.keyboard('{Escape}');
    await user.click(screen.getByRole('button', { name: 'Save steps' }));
    expect(await screen.findByText(/^CYCLE: These predecessors form a cycle/)).toBeInTheDocument();
  });
});

describe('WorkflowSettingsPage — step-kind editor (Super Admin only)', () => {
  it('a kind change asks for confirmation explaining the load shift, then saves the new kind', async () => {
    const user = userEvent.setup();
    renderWithProviders(<WorkflowSettingsPage />);
    await user.click(screen.getByRole('combobox', { name: 'Kind — Pilot' }));
    await user.click(await screen.findByRole('option', { name: 'Design' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Change Pilot from Elapsed to Design?');
    expect(dialog).toHaveTextContent(/engineer load/);
    expect(dialog).toHaveTextContent(/Nothing moves until the schedule is recalculated/);
    await user.click(within(dialog).getByRole('button', { name: 'Change kind' }));
    await user.click(screen.getByRole('button', { name: 'Save steps' }));
    const { body } = hooks.saveSteps.mock.calls[0]![0] as { body: { steps: { step_id: string; kind: string }[] } };
    expect(body.steps.find((s) => s.step_id === 'PDD-L')?.kind).toBe('design');
  });

  it('cancelling the confirm dialog leaves the kind unchanged and nothing to save', async () => {
    const user = userEvent.setup();
    renderWithProviders(<WorkflowSettingsPage />);
    await user.click(screen.getByRole('combobox', { name: 'Kind — Pilot' }));
    await user.click(await screen.findByRole('option', { name: 'Lab' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('combobox', { name: 'Kind — Pilot' })).toHaveTextContent('Elapsed');
    expect(screen.getByRole('button', { name: 'Save steps' })).toBeDisabled();
  });

  it('a KIND_IN_USE refusal is explained in readable terms', async () => {
    const user = userEvent.setup();
    hooks.saveSteps.mockRejectedValue(new ApiError(422, 'bad', 'PDD-F is allowed on IN-CH-2', 'KIND_IN_USE'));
    renderWithProviders(<WorkflowSettingsPage />);
    await user.click(screen.getByRole('combobox', { name: 'Kind — Proof of Concept' }));
    await user.click(await screen.findByRole('option', { name: 'Design' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Change kind' }));
    await user.click(screen.getByRole('button', { name: 'Save steps' }));
    expect(await screen.findByText(/^KIND_IN_USE: This step is still listed as an allowed stage on a chamber/)).toBeInTheDocument();
  });

  it('an Admin sees kind badges, not kind selects', () => {
    renderWithProviders(<WorkflowSettingsPage />, { session: { roles: ['Admin'], permissions: ROLE_MATRIX.Admin } });
    expect(screen.queryByRole('combobox', { name: /^Kind — / })).not.toBeInTheDocument();
    expect(screen.getByTestId('step-row-PDD-L')).toHaveTextContent('Elapsed');
  });
});

describe('WorkflowSettingsPage — lead times, calendars, chambers', () => {
  it('lead-time grid: row sums and subtotals, 0 rendered as "—", edit updates the total and saves only the change', async () => {
    const user = userEvent.setup();
    renderWithProviders(<WorkflowSettingsPage />);
    await user.click(screen.getByRole('tab', { name: 'Lead times' }));
    const aPlus = screen.getByTestId('lead-row-A+');
    expect(within(aPlus).getByTestId('total')).toHaveTextContent('44');
    expect(within(aPlus).getByTestId('design')).toHaveTextContent('22');
    expect(within(aPlus).getByTestId('lab')).toHaveTextContent('12');
    expect(within(aPlus).getByTestId('elapsed')).toHaveTextContent('10');
    expect(within(screen.getByTestId('lead-row-B')).getByLabelText('PDD B PDD-A weeks')).toHaveAttribute('placeholder', '—');

    const cell = within(aPlus).getByLabelText('PDD A+ PDD-B weeks');
    await user.clear(cell);
    await user.type(cell, '6');
    expect(within(aPlus).getByTestId('total')).toHaveTextContent('42');
    await user.click(screen.getByRole('button', { name: 'Save 1 change' }));
    expect(hooks.saveLeadTimes).toHaveBeenCalledWith({
      lead_times: [{ workflow_id: 'PDD', category: 'A+', step_id: 'PDD-B', weeks: 6 }],
    });
  });

  it('hub calendar: saved figure from the server, live preview labelled "preview" while editing', async () => {
    const user = userEvent.setup();
    renderWithProviders(<WorkflowSettingsPage />);
    await user.click(screen.getByRole('tab', { name: 'Hub calendars' }));
    const card = screen.getByTestId('calendar-R&D-Greece');
    expect(within(card).getByTestId('saved-working-weeks')).toHaveTextContent('44.6');
    const annual = within(card).getByLabelText('Annual leave (days)');
    await user.clear(annual);
    await user.type(annual, '20');
    expect(within(card).getByTestId('preview-working-weeks')).toHaveTextContent('45.6');
    expect(within(card).getByTestId('preview-working-weeks')).toHaveTextContent('preview');
    await user.click(within(card).getByRole('button', { name: 'Save' }));
    expect(hooks.saveCalendar).toHaveBeenCalledWith({
      hubId: 'hub-gr',
      body: {
        weekdays_per_week: 5,
        national_holiday_days: 12,
        medical_leave_days: 0,
        casual_leave_days: 0,
        annual_leave_days: 20,
      },
    });
  });

  it('chambers: derived working/efficient weeks from the server, preview on edit, partial PUT', async () => {
    const user = userEvent.setup();
    renderWithProviders(<WorkflowSettingsPage />);
    await user.click(screen.getByRole('tab', { name: 'Chambers' }));
    const row = screen.getByTestId('chamber-IN-CH-2');
    expect(row).toHaveTextContent('35.4');
    expect(row).toHaveTextContent('84.96');
    const breakdown = within(row).getByLabelText('IN-CH-2 Breakdown (wk)');
    await user.clear(breakdown);
    await user.type(breakdown, '5');
    expect(within(row).getByTestId('preview-working')).toHaveTextContent('41.4 preview');
    await user.click(within(row).getByRole('button', { name: 'Save IN-CH-2' }));
    expect(hooks.saveChamber).toHaveBeenCalledWith({ chamberId: 'ch-2', body: { breakdown_weeks: 5 } });
  });
});

describe('WorkflowSettingsPage — RBAC (Admin reads, Super Admin writes)', () => {
  it('Admin sees everything read-only: no editors, no save buttons, a read-only notice', async () => {
    const user = userEvent.setup();
    renderWithProviders(<WorkflowSettingsPage />, { session: { roles: ['Admin'], permissions: ROLE_MATRIX.Admin } });
    expect(screen.getByTestId('read-only-notice')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save steps' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Can start after/ })).not.toBeInTheDocument();
    expect(screen.getByTestId('preds-PDD-B')).toHaveTextContent('A');
    await user.click(screen.getByRole('tab', { name: 'Lead times' }));
    expect(screen.queryByLabelText('PDD A+ PDD-B weeks')).not.toBeInTheDocument();
    expect(within(screen.getByTestId('lead-row-A+')).getByTestId('total')).toHaveTextContent('44');
  });

  it('degrades to an access notice on a 403', () => {
    hooks.useWorkflowSettings.mockReturnValue({ data: undefined, isPending: false, isError: true, error: new ApiError(403, 'no'), refetch: vi.fn() });
    renderWithProviders(<WorkflowSettingsPage />);
    expect(screen.getByText('Your role does not have access to Workflow Settings')).toBeInTheDocument();
  });
});

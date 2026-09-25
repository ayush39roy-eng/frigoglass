import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import { ApiError } from '@/lib/api/client';
import { useScenarioStore } from '@/stores/scenario';

const applyScenarioHook = { mutateAsync: vi.fn(), isPending: false };
vi.mock('../hooks/use-matrix', () => ({
  useApplyScenario: () => applyScenarioHook,
}));

import { ScenarioModeToggle, ScenarioPendingPanel } from './scenario-panel';
import type { PriorityScoreUpdateRequest } from '../api/types';

function scores(overrides: Partial<PriorityScoreUpdateRequest> = {}): PriorityScoreUpdateRequest {
  return {
    strategic_project: 3, new_customer: 3, new_options: 3, regulatory_compliance: 3,
    quality_improvements: 3, rm_savings: 3, total_rm_savings: 3, gross_margins: 3,
    profitability: 3, annual_volume: 3, three_year_volume: 3, new_models: 3,
    capex_investment: 3, hard_gates: [],
    ...overrides,
  };
}

function stageOne(overrides: Partial<{ projectId: string; projectName: string; hub: string }> = {}) {
  useScenarioStore.getState().stageEdit({
    projectId: overrides.projectId ?? 'p1',
    projectName: overrides.projectName ?? 'Cooler A',
    hub: overrides.hub ?? 'R&D-Greece',
    liveValues: scores({ strategic_project: 3, hard_gates: ['Active safety non-compliance'] }),
    liveHasScore: true,
    next: scores({ strategic_project: 5, hard_gates: [] }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  applyScenarioHook.mutateAsync = vi.fn().mockResolvedValue({});
  applyScenarioHook.isPending = false;
  useScenarioStore.setState({ active: true, notes: '', pending: {}, past: [], future: [] });
});

afterEach(() => {
  useScenarioStore.setState({ active: false, notes: '', pending: {}, past: [], future: [] });
});

describe('ScenarioModeToggle', () => {
  it('is unchecked by default and toggles the store', async () => {
    useScenarioStore.setState({ active: false });
    const user = userEvent.setup();
    renderWithProviders(<ScenarioModeToggle />);
    const checkbox = screen.getByRole('checkbox', { name: 'Scenario mode' });
    expect(checkbox).not.toBeChecked();
    await user.click(checkbox);
    expect(useScenarioStore.getState().active).toBe(true);
  });

  it('shows a staged count badge only once there is a genuine staged change', async () => {
    useScenarioStore.setState({ active: true });
    renderWithProviders(<ScenarioModeToggle />);
    expect(screen.queryByTestId('scenario-staged-count')).not.toBeInTheDocument();
    stageOne();
    await waitFor(() =>
      expect(screen.getByTestId('scenario-staged-count')).toHaveTextContent('1 staged'),
    );
  });

  it('respects disabled', () => {
    renderWithProviders(<ScenarioModeToggle disabled />);
    expect(screen.getByRole('checkbox', { name: 'Scenario mode' })).toBeDisabled();
  });
});

describe('ScenarioPendingPanel', () => {
  it('renders nothing when scenario mode is inactive', () => {
    useScenarioStore.setState({ active: false });
    const { container } = renderWithProviders(<ScenarioPendingPanel />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the empty state with no staged edits', () => {
    renderWithProviders(<ScenarioPendingPanel />);
    expect(screen.getByTestId('scenario-empty')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Apply/ })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Discard' })).toBeDisabled();
  });

  it('lists a staged edit with its dimension + hard-gate diff, and a working Remove button', async () => {
    const user = userEvent.setup();
    stageOne();
    renderWithProviders(<ScenarioPendingPanel />);

    const item = screen.getByTestId('scenario-pending-item');
    expect(item.textContent).toContain('Cooler A');
    expect(item.textContent).toContain('R&D-Greece');
    expect(item.textContent).toContain('Strategic Project: 3 → 5');
    expect(item.textContent).toContain('Hard gates');
    expect(item.textContent).toContain('Active safety non-compliance');

    await user.click(within(item).getByRole('button', { name: 'Remove staged change for Cooler A' }));
    expect(screen.queryByTestId('scenario-pending-item')).not.toBeInTheDocument();
    expect(useScenarioStore.getState().pending).toEqual({});
  });

  it('labels a no-op staged edit "No change" and excludes it from the Apply count', () => {
    useScenarioStore.getState().stageEdit({
      projectId: 'p1', projectName: 'Cooler A', hub: 'R&D-Greece',
      liveValues: scores(), liveHasScore: true, next: scores(),
    });
    renderWithProviders(<ScenarioPendingPanel />);
    expect(screen.getByText('No change')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Apply/ })).toBeDisabled();
  });

  it('marks a previously-unscored project as "New score"', () => {
    useScenarioStore.getState().stageEdit({
      projectId: 'p1', projectName: 'Cooler A', hub: 'R&D-Greece',
      liveValues: scores(), liveHasScore: false, next: scores(),
    });
    renderWithProviders(<ScenarioPendingPanel />);
    expect(screen.getByText('New score')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Apply/ })).toBeEnabled();
  });

  it('Undo/Redo are disabled with no history and enabled once history exists', async () => {
    const user = userEvent.setup();
    renderWithProviders(<ScenarioPendingPanel />);
    expect(screen.getByRole('button', { name: 'Undo' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Redo' })).toBeDisabled();

    // Zustand's subscription re-renders the already-mounted panel reactively —
    // no need to remount.
    stageOne();
    await waitFor(() => expect(screen.getByRole('button', { name: 'Undo' })).toBeEnabled());

    await user.click(screen.getByRole('button', { name: 'Undo' }));
    expect(useScenarioStore.getState().pending).toEqual({});
  });

  it('Discard clears staged edits and notes without calling Apply', async () => {
    const user = userEvent.setup();
    stageOne();
    useScenarioStore.getState().setNotes('scratch');
    renderWithProviders(<ScenarioPendingPanel />);

    await user.click(screen.getByRole('button', { name: 'Discard' }));
    expect(useScenarioStore.getState().pending).toEqual({});
    expect(useScenarioStore.getState().notes).toBe('');
    expect(applyScenarioHook.mutateAsync).not.toHaveBeenCalled();
  });

  it('Apply sends the computed diff (with trimmed notes) and resets the store on success', async () => {
    const user = userEvent.setup();
    stageOne();
    useScenarioStore.getState().setNotes('  Q3 replan  ');
    renderWithProviders(<ScenarioPendingPanel />);

    await user.click(screen.getByRole('button', { name: /Apply/ }));

    await waitFor(() => expect(applyScenarioHook.mutateAsync).toHaveBeenCalledTimes(1));
    const [body] = applyScenarioHook.mutateAsync.mock.calls[0] as [
      { notes: string | null; priority_scores: Record<string, unknown>[] },
    ];
    expect(body.notes).toBe('Q3 replan');
    expect(body.priority_scores).toEqual([{ project_id: 'p1', ...scores({ strategic_project: 5, hard_gates: [] }) }]);

    await waitFor(() => expect(useScenarioStore.getState().pending).toEqual({}));
    expect(useScenarioStore.getState().notes).toBe('');
  });

  it('sends notes:null when the notes field is blank', async () => {
    const user = userEvent.setup();
    stageOne();
    renderWithProviders(<ScenarioPendingPanel />);
    await user.click(screen.getByRole('button', { name: /Apply/ }));
    await waitFor(() => expect(applyScenarioHook.mutateAsync).toHaveBeenCalledTimes(1));
    const [body] = applyScenarioHook.mutateAsync.mock.calls[0] as [{ notes: string | null }];
    expect(body.notes).toBeNull();
  });

  it('shows a forbidden error and keeps the scenario staged when Apply 403s', async () => {
    const user = userEvent.setup();
    applyScenarioHook.mutateAsync = vi.fn().mockRejectedValue(new ApiError(403, 'forbidden'));
    stageOne();
    renderWithProviders(<ScenarioPendingPanel />);

    await user.click(screen.getByRole('button', { name: /Apply/ }));

    expect(await screen.findByText('Your role cannot apply scenario changes.')).toBeInTheDocument();
    expect(useScenarioStore.getState().pending).not.toEqual({});
  });

  it('writeForbidden disables Apply and shows a read-only notice, but still lists staged edits', () => {
    stageOne();
    renderWithProviders(<ScenarioPendingPanel writeForbidden />);
    expect(screen.getByText(/read-only access to the Prioritization Matrix/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Apply/ })).toBeDisabled();
    expect(screen.getByTestId('scenario-pending-item')).toBeInTheDocument();
  });
});

describe('diff rendering edge cases (via ScenarioPendingPanel)', () => {
  it('renders multiple changed dimensions as separate lines', () => {
    useScenarioStore.getState().stageEdit({
      projectId: 'p1', projectName: 'Cooler A', hub: 'R&D-Greece',
      liveValues: scores(), liveHasScore: true,
      next: scores({ strategic_project: 5, new_customer: 1 }),
    });
    renderWithProviders(<ScenarioPendingPanel />);
    const item = screen.getByTestId('scenario-pending-item');
    expect(item.textContent).toContain('Strategic Project: 3 → 5');
    expect(item.textContent).toContain('New Customer: 3 → 1');
    expect(item.textContent).toContain('2 fields changed');
  });

  it('does not render a hard-gates diff line when the gate set is unchanged', () => {
    useScenarioStore.getState().stageEdit({
      projectId: 'p1', projectName: 'Cooler A', hub: 'R&D-Greece',
      liveValues: scores({ hard_gates: ['Active safety non-compliance'] }), liveHasScore: true,
      next: scores({ strategic_project: 5, hard_gates: ['Active safety non-compliance'] }),
    });
    renderWithProviders(<ScenarioPendingPanel />);
    const item = screen.getByTestId('scenario-pending-item');
    expect(item.textContent).not.toContain('Hard gates');
  });
});

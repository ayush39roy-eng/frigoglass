import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ApiError } from '@/lib/api/client';
import { renderWithProviders } from '@/test/render';
import { seriousAxeViolations } from '@/test/axe';

import type { ChamberRead } from '../../api/types';
import { askFixture, estimateFixture, INDIA_SCOPE, simulateFixture, solveFixture } from '../test-fixtures';
import { useWhatIfScenario } from '../scenario-store';

const api = {
  postEstimate: vi.fn(),
  postSimulate: vi.fn(),
  postSolve: vi.fn(),
  postAsk: vi.fn(),
};
vi.mock('../../api/whatif-api', () => ({
  postEstimate: async (b: unknown) => api.postEstimate(b) as unknown,
  postSimulate: async (b: unknown) => api.postSimulate(b) as unknown,
  postSolve: async (b: unknown) => api.postSolve(b) as unknown,
  postAsk: async (b: unknown) => api.postAsk(b) as unknown,
}));

import { WhatIfPlanner } from './whatif-planner';

const CHAMBERS = [
  { id: 'ch-1', code: 'IN-1', lab_region: 'India' },
  { id: 'ch-2', code: 'RO-1', lab_region: 'Romania' },
] as unknown as ChamberRead[];

function group(name: RegExp | string) {
  return screen.getByRole('group', { name });
}

async function addProject(user: ReturnType<typeof userEvent.setup>, count = '5') {
  await user.click(screen.getByRole('button', { name: 'Add project line' }));
  const g = group(/Added projects, line 1/);
  const countInput = within(g).getByLabelText('Count');
  await user.clear(countInput);
  await user.type(countInput, count);
  return g;
}

describe('WhatIfPlanner', () => {
  beforeEach(() => {
    Object.values(api).forEach((f) => f.mockReset());
    useWhatIfScenario.getState().reset();
  });

  it('starts empty: results show empty states and the run buttons explain why they are off', () => {
    renderWithProviders(<WhatIfPlanner chambers={CHAMBERS} />);
    expect(screen.getByText('No estimate yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Estimate' })).toBeDisabled();
    expect(screen.getByTestId('whatif-run-hint')).toHaveTextContent('Add at least one change');
  });

  it('builds a scenario, posts the exact strict body to estimate, and shows the served figures', async () => {
    const user = userEvent.setup();
    api.postEstimate.mockResolvedValue(estimateFixture());
    renderWithProviders(<WhatIfPlanner chambers={CHAMBERS} />);
    const g = await addProject(user, '10');
    await user.selectOptions(within(g).getByLabelText('Hub'), 'PD-India');
    await user.selectOptions(within(g).getByLabelText('Category'), 'A');
    await user.click(screen.getByRole('radio', { name: 'Remaining weeks' }));

    await user.click(screen.getByRole('button', { name: 'Estimate' }));
    expect(await screen.findByTestId('whatif-estimate')).toBeInTheDocument();
    expect(api.postEstimate).toHaveBeenCalledTimes(1);
    expect(api.postEstimate.mock.calls[0]?.[0]).toEqual({
      scenario: {
        add_projects: [
          {
            hub: 'PD-India',
            category: 'A',
            count: 10,
            project_type: null,
            status: 'In Queue',
            priority: null,
            score: null,
            workflow_id: null,
            certification_testing_required: true,
          },
        ],
        add_engineers: [],
        remove_engineer_counts: [],
        add_chambers: [],
        chamber_downtime: [],
      },
      basis: 'remaining',
      designer_fte: 1,
    });
    expect(screen.getByTestId('est-designers')).toHaveTextContent('3 more');
  });

  it('shows inline validation, blocks the run, and re-enables it once fixed', async () => {
    const user = userEvent.setup();
    renderWithProviders(<WhatIfPlanner chambers={CHAMBERS} />);
    const g = await addProject(user, '0');
    expect(within(g).getByRole('alert')).toHaveTextContent('Must be at least 1');
    expect(screen.getByRole('button', { name: 'Simulate' })).toBeDisabled();
    expect(screen.getByTestId('whatif-run-hint')).toHaveTextContent('Fix the highlighted fields');
    const count = within(g).getByLabelText('Count');
    await user.clear(count);
    await user.type(count, '201');
    expect(within(g).getByRole('alert')).toHaveTextContent('Must be at most 200');
    await user.clear(count);
    await user.type(count, '3');
    expect(within(g).queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Simulate' })).toBeEnabled();
  });

  it('shows a live running total with the remaining allowance, and an inline message over the cap before submit', async () => {
    const user = userEvent.setup();
    renderWithProviders(<WhatIfPlanner chambers={CHAMBERS} />);
    await addProject(user, '150');
    expect(screen.getByTestId('whatif-cap-projects')).toHaveTextContent('Total 150 of 200 projects added (50 left).');
    expect(screen.getByTestId('whatif-cap-chambers')).toHaveTextContent('Total 0 of 20 chambers added (20 left).');
    await user.click(screen.getByRole('button', { name: 'Add project line' }));
    const g2 = group(/Added projects, line 2/);
    await user.clear(within(g2).getByLabelText('Count'));
    await user.type(within(g2).getByLabelText('Count'), '60');
    expect(screen.getByTestId('whatif-cap-projects')).toHaveTextContent('Total 210 of 200 projects added: over the limit.');
    expect(screen.getByText(/At most 200 projects added in one scenario \(you have 210\)/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Simulate' })).toBeDisabled();
    await user.clear(within(g2).getByLabelText('Count'));
    await user.type(within(g2).getByLabelText('Count'), '50');
    expect(screen.getByRole('button', { name: 'Simulate' })).toBeEnabled();
  });

  it('disables every Run button while a request is pending', async () => {
    const user = userEvent.setup();
    let resolve: (v: unknown) => void = () => undefined;
    api.postSimulate.mockImplementation(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    renderWithProviders(<WhatIfPlanner chambers={CHAMBERS} />);
    await addProject(user);
    await user.click(screen.getByRole('button', { name: 'Simulate' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Estimate' })).toBeDisabled());
    expect(screen.getByRole('button', { name: 'Simulate' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Find fewest additions' })).toBeDisabled();
    resolve(simulateFixture());
    await screen.findByTestId('whatif-simulate');
    expect(screen.getByRole('button', { name: 'Estimate' })).toBeEnabled();
  });

  it.each([
    ['Estimate', 'postEstimate'],
    ['Simulate', 'postSimulate'],
    ['Find fewest additions', 'postSolve'],
  ] as const)('%s: the in-flight 429 shows a short retry countdown and a disabled retry', async (button, fn) => {
    const user = userEvent.setup();
    api[fn].mockImplementation(() => {
      throw new ApiError(
        429,
        'x',
        'A what-if calculation of yours is still running. Please wait for it to finish before starting another.',
        undefined,
        2,
      );
    });
    renderWithProviders(<WhatIfPlanner chambers={CHAMBERS} />);
    await addProject(user);
    await user.click(screen.getByRole('button', { name: button }));
    const notice = await screen.findByTestId('whatif-error');
    expect(notice).toHaveAttribute('data-error-kind', 'rate_limited');
    expect(notice).toHaveTextContent('still running');
    expect(screen.getByTestId('whatif-countdown')).toHaveTextContent('2 s');
    expect(within(notice).getByRole('button', { name: 'Try again' })).toBeDisabled();
  });

  it('maps a 422 total-over-cap to a readable message', async () => {
    const user = userEvent.setup();
    api.postEstimate.mockImplementation(() => {
      throw new ApiError(
        422,
        'x',
        JSON.stringify([{ loc: ['body', 'scenario'], type: 'scenario_limit', msg: 'at most 50 designers can be added in one scenario (got 51)' }]),
        'INVALID_SCENARIO',
      );
    });
    renderWithProviders(<WhatIfPlanner chambers={CHAMBERS} />);
    await addProject(user);
    await user.click(screen.getByRole('button', { name: 'Estimate' }));
    const notice = await screen.findByTestId('whatif-error');
    expect(notice).toHaveTextContent('at most 50 designers can be added in one scenario (got 51).');
    expect(notice).not.toHaveTextContent('loc');
  });

  it('offers only the categories of the chosen hub workflow', async () => {
    const user = userEvent.setup();
    renderWithProviders(<WhatIfPlanner chambers={CHAMBERS} />);
    const g = await addProject(user);
    await user.selectOptions(within(g).getByLabelText('Hub'), 'OEM-HCK');
    const options = within(within(g).getByLabelText('Category')).getAllByRole('option').map((o) => o.textContent);
    expect(options).toEqual(['A-OEM', 'B-OEM', 'C-OEM']);
  });

  it('builds designer, chamber and downtime lines (with the chamber picker from the scoped list)', async () => {
    const user = userEvent.setup();
    api.postSimulate.mockResolvedValue(simulateFixture());
    renderWithProviders(<WhatIfPlanner chambers={CHAMBERS} />);
    await user.click(screen.getByRole('button', { name: 'Add designer line' }));
    await user.click(screen.getByRole('button', { name: 'Add removal line' }));
    await user.click(screen.getByRole('button', { name: 'Add chamber line' }));
    await user.click(screen.getByRole('button', { name: 'Add downtime line' }));
    const dt = group(/Chamber downtime, line 1/);
    expect(within(dt).getByRole('option', { name: 'RO-1 (Romania)' })).toBeInTheDocument();
    await user.selectOptions(within(dt).getByLabelText('Chamber'), 'ch-2');
    await user.type(within(dt).getByLabelText('Breakdown weeks'), '6');
    await user.click(screen.getByRole('button', { name: 'Simulate' }));
    await screen.findByTestId('whatif-simulate');
    const body = api.postSimulate.mock.calls[0]?.[0] as { scenario: Record<string, unknown[]> };
    expect(body.scenario.add_engineers).toEqual([{ hub: 'PD-India', fte: 1, count: 1, allowed_categories: null }]);
    expect(body.scenario.remove_engineer_counts).toEqual([{ hub: 'PD-India', count: 1 }]);
    expect(body.scenario.chamber_downtime).toEqual([
      { chamber_id: 'ch-2', maintenance_weeks: null, breakdown_weeks: 6, calibration_weeks: null },
    ]);
  });

  it('clear scenario empties every list and the basis', async () => {
    const user = userEvent.setup();
    renderWithProviders(<WhatIfPlanner chambers={CHAMBERS} />);
    await addProject(user);
    await user.click(screen.getByRole('radio', { name: 'Remaining weeks' }));
    await user.click(screen.getByRole('button', { name: /Clear scenario/ }));
    expect(screen.queryByRole('group', { name: /Added projects/ })).not.toBeInTheDocument();
    expect(useWhatIfScenario.getState().basis).toBe('year');
  });

  it('marks a result stale when the scenario changes after it was calculated', async () => {
    const user = userEvent.setup();
    api.postSimulate.mockResolvedValue(simulateFixture());
    renderWithProviders(<WhatIfPlanner chambers={CHAMBERS} />);
    const g = await addProject(user, '2');
    await user.click(screen.getByRole('button', { name: 'Simulate' }));
    await screen.findByTestId('whatif-simulate');
    expect(screen.queryByTestId('whatif-stale')).not.toBeInTheDocument();
    await user.type(within(g).getByLabelText('Count'), '0');
    expect(await screen.findByTestId('whatif-stale')).toHaveTextContent('has changed since this result');
  });

  it('shows the fewest-additions result with its unattainable list and honest flags', async () => {
    const user = userEvent.setup();
    api.postSolve.mockResolvedValue(
      solveFixture({
        met: false,
        met_attainable: true,
        capped: true,
        exact: false,
        runs_used: 60,
        unattainable_project_ids: ['x'],
        unattainable_projects: [{ project_id: 'x', name: 'What-if project 1', hub: 'PD-India', category: 'A', unconstrained_end_week: 61 }],
      }),
    );
    renderWithProviders(<WhatIfPlanner chambers={CHAMBERS} />);
    await addProject(user);
    await user.selectOptions(screen.getByLabelText(/Goal for/), 'no_existing_slips');
    await user.click(screen.getByRole('button', { name: 'Find fewest additions' }));
    expect(await screen.findByTestId('solve-unattainable')).toBeInTheDocument();
    expect(screen.getByTestId('solve-capped')).toHaveTextContent('stopped at its run limit');
    expect((api.postSolve.mock.calls[0]?.[0] as { target: string }).target).toBe('no_existing_slips');
  });

  it('renders a Hub Planner scoped response as served and states its scope', async () => {
    const user = userEvent.setup();
    api.postSimulate.mockResolvedValue(simulateFixture({ scope: INDIA_SCOPE }));
    renderWithProviders(<WhatIfPlanner chambers={CHAMBERS} />);
    await addProject(user);
    await user.click(screen.getByRole('button', { name: 'Simulate' }));
    expect(await screen.findByTestId('whatif-scope')).toHaveTextContent('Showing your hubs only (PD-India)');
  });

  it('403 SCENARIO_OUT_OF_SCOPE tells the user to change the line and offers no retry', async () => {
    const user = userEvent.setup();
    api.postEstimate.mockImplementation(() => {
      throw new ApiError(403, 'x', 'out of scope', 'SCENARIO_OUT_OF_SCOPE');
    });
    renderWithProviders(<WhatIfPlanner chambers={CHAMBERS} />);
    await addProject(user);
    await user.click(screen.getByRole('button', { name: 'Estimate' }));
    const err = await screen.findByTestId('whatif-error');
    expect(err).toHaveAttribute('data-error-kind', 'out_of_scope');
    expect(within(err).queryByRole('button')).not.toBeInTheDocument();
  });

  it('422 INVALID_SCENARIO shows the server reason; 503 timeout offers a retry that re-runs', async () => {
    const user = userEvent.setup();
    api.postEstimate
      .mockImplementationOnce(() => {
        throw new ApiError(422, 'x', 'unknown chamber id', 'INVALID_SCENARIO');
      })
      .mockImplementationOnce(() => {
        throw new ApiError(503, 'x', 'too slow', 'WHATIF_TIMEOUT');
      })
      .mockResolvedValue(estimateFixture());
    renderWithProviders(<WhatIfPlanner chambers={CHAMBERS} />);
    await addProject(user);
    await user.click(screen.getByRole('button', { name: 'Estimate' }));
    expect(await screen.findByTestId('whatif-error')).toHaveTextContent('unknown chamber id');
    await user.click(screen.getByRole('button', { name: 'Estimate' }));
    const timeout = await screen.findByText('This took too long; try a smaller scenario.');
    expect(timeout).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByTestId('whatif-estimate')).toBeInTheDocument();
  });

  it('edit-in-builder round trip: the chat scenario fills the form and re-runs as the same request', async () => {
    const user = userEvent.setup();
    api.postAsk.mockResolvedValue(askFixture());
    api.postSimulate.mockResolvedValue(simulateFixture());
    renderWithProviders(<WhatIfPlanner chambers={CHAMBERS} />);
    await user.type(screen.getByLabelText('Your question'), 'add 5 PDD/A in India');
    await user.click(screen.getByRole('button', { name: 'Ask' }));
    await user.click(await screen.findByRole('button', { name: 'Edit in builder' }));

    expect(screen.getByTestId('whatif-loaded-notice')).toBeInTheDocument();
    const g = group(/Added projects, line 1/);
    expect(within(g).getByLabelText('Hub')).toHaveValue('PD-India');
    expect(within(g).getByLabelText('Category')).toHaveValue('A');
    expect(within(g).getByLabelText('Count')).toHaveValue('5');

    await user.clear(within(g).getByLabelText('Count'));
    await user.type(within(g).getByLabelText('Count'), '6');
    await user.click(screen.getByRole('button', { name: 'Simulate' }));
    await waitFor(() => expect(api.postSimulate).toHaveBeenCalled());
    const sent = api.postSimulate.mock.calls[0]?.[0] as { scenario: { add_projects: { count: number; workflow_id: string }[] } };
    expect(sent.scenario.add_projects[0]).toMatchObject({ hub: 'PD-India', category: 'A', count: 6, workflow_id: 'PDD' });
  });

  it('chat 503 leaves the forms working', async () => {
    const user = userEvent.setup();
    api.postAsk.mockImplementation(() => {
      throw new ApiError(503, 'x');
    });
    api.postEstimate.mockResolvedValue(estimateFixture());
    renderWithProviders(<WhatIfPlanner chambers={CHAMBERS} />);
    await user.type(screen.getByLabelText('Your question'), 'hello');
    await user.click(screen.getByRole('button', { name: 'Ask' }));
    expect(await screen.findByTestId('chat-unavailable')).toHaveTextContent('Chat is not configured; use the forms.');
    await addProject(user);
    await user.click(screen.getByRole('button', { name: 'Estimate' }));
    expect(await screen.findByTestId('whatif-estimate')).toBeInTheDocument();
  });

  it('has no serious or critical axe violations with a scenario, a result and a chat answer on screen', async () => {
    const user = userEvent.setup();
    api.postEstimate.mockResolvedValue(estimateFixture());
    api.postAsk.mockResolvedValue(askFixture());
    const { container } = renderWithProviders(<WhatIfPlanner chambers={CHAMBERS} />);
    await user.click(screen.getByRole('button', { name: 'Add project line' }));
    await user.click(screen.getByRole('button', { name: 'Add chamber line' }));
    await user.click(screen.getByRole('button', { name: 'Add downtime line' }));
    const dt = group(/Chamber downtime, line 1/);
    await user.selectOptions(within(dt).getByLabelText('Chamber'), 'ch-1');
    await user.type(within(dt).getByLabelText('Maintenance weeks'), '3');
    await user.click(screen.getByRole('button', { name: 'Estimate' }));
    await screen.findByTestId('whatif-estimate');
    await user.type(screen.getByLabelText('Your question'), 'q');
    await user.click(screen.getByRole('button', { name: 'Ask' }));
    await screen.findByTestId('chat-answer');
    expect(await seriousAxeViolations(container)).toEqual([]);
  });
});

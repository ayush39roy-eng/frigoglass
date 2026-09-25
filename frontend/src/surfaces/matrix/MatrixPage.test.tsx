import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import { ApiError } from '@/lib/api/client';
import { useScenarioStore } from '@/stores/scenario';
import type { PriorityMatrixRow, PriorityPortfolioSummary } from './api/types';

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 44,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ key: index, index, start: index * 44, size: 44 })),
    measureElement: () => undefined,
  }),
}));
vi.mock('./components/band-distribution-chart', () => ({
  BandDistributionChart: () => <div data-testid="band-chart" />,
}));

const hooks = {
  usePriorityMatrix: vi.fn(),
  usePrioritySummary: vi.fn(),
  useCurrencyRates: vi.fn(),
  useUpdatePriorityScore: vi.fn(),
  useApplyScenario: vi.fn(),
  // Versions & History (P5-T03) — VersionHistoryDialog (mounted by MatrixPage)
  // pulls these from the same hooks module.
  useScenarioVersions: vi.fn(),
  useScenarioVersionDetail: vi.fn(),
};
vi.mock('./hooks/use-matrix', () => ({
  usePriorityMatrix: (args: unknown) => hooks.usePriorityMatrix(args),
  usePrioritySummary: () => hooks.usePrioritySummary(),
  useCurrencyRates: () => hooks.useCurrencyRates(),
  useUpdatePriorityScore: () => hooks.useUpdatePriorityScore(),
  useApplyScenario: () => hooks.useApplyScenario(),
  useScenarioVersions: (args: unknown) => hooks.useScenarioVersions(args),
  useScenarioVersionDetail: (version: number | null) => hooks.useScenarioVersionDetail(version),
}));
vi.mock('@/lib/api/reference', () => ({ useHubs: () => ({ data: [] }) }));

import MatrixPage from './MatrixPage';

const pending = { data: undefined, isPending: true, isError: false, error: null, refetch: vi.fn() };
function ready<T>(data: T) {
  return { data, isPending: false, isError: false, error: null, refetch: vi.fn() };
}
function failed(error: Error) {
  return { data: undefined, isPending: false, isError: true, error, refetch: vi.fn() };
}

const summary: PriorityPortfolioSummary = {
  total_projects: 10,
  scored_projects: 7,
  unscored_projects: 3,
  hard_gate_forced_count: 2,
  suggested_band_counts: { P1: 3, P2: 2, P3: 1, P4: 1 },
  set_priority_counts: { P1: 4, P2: 3 },
};

const scoredRow: PriorityMatrixRow = {
  project_id: 'p1', project_name: 'Cooler A', hub: 'R&D-Greece', category: 'A+', type: 'NM',
  set_priority: 'P2', has_score: true,
  strategic_project: 5, new_customer: 4, new_options: 3, regulatory_compliance: 2,
  quality_improvements: 3, rm_savings: 4, total_rm_savings: 3, gross_margins: 3,
  profitability: 4, annual_volume: 3, three_year_volume: 3, new_models: 2, capex_investment: 4,
  hard_gates: [], weighted_score: 980, normalized_pct: 70, suggested_band: 'P1',
  is_new_model: true, is_rm_saving_project: true,
  currency: 'EUR', capex_keur: 120, rm_savings_keur: 40, tcogs_eur: 5000,
  selling_price_eur: 8000, gross_margin_pct: 37.5,
};

beforeEach(() => {
  vi.clearAllMocks();
  useScenarioStore.setState({ active: false, notes: '', pending: {}, past: [], future: [] });
  hooks.useCurrencyRates.mockReturnValue(ready([
    { id: 'r2', currency_code: 'USD', rate_to_eur: 1.08, updated_by_user_id: null, updated_at: '2026-01-01T00:00:00Z' },
  ]));
  hooks.useUpdatePriorityScore.mockReturnValue({ mutateAsync: vi.fn().mockResolvedValue({}) });
  hooks.useApplyScenario.mockReturnValue({ mutateAsync: vi.fn().mockResolvedValue({}), isPending: false });
  hooks.useScenarioVersions.mockReturnValue({ data: undefined, isPending: true, isError: false, error: null, refetch: vi.fn() });
  hooks.useScenarioVersionDetail.mockReturnValue({ data: undefined, isPending: true, isError: false, error: null, refetch: vi.fn() });
});

describe('MatrixPage', () => {
  it('always renders the heading and the currency toggle', () => {
    hooks.usePriorityMatrix.mockReturnValue(pending);
    hooks.usePrioritySummary.mockReturnValue(pending);
    renderWithProviders(<MatrixPage />);
    expect(screen.getByRole('heading', { name: 'Prioritization Matrix' })).toBeInTheDocument();
    expect(screen.getByText('Display currency')).toBeInTheDocument();
  });

  it('changing the currency toggle re-requests the matrix with the new currency param (no client math)', async () => {
    const user = userEvent.setup();
    hooks.usePriorityMatrix.mockReturnValue(ready([scoredRow]));
    hooks.usePrioritySummary.mockReturnValue(ready(summary));
    renderWithProviders(<MatrixPage />);

    expect(hooks.usePriorityMatrix).toHaveBeenLastCalledWith(expect.objectContaining({ currency: 'EUR' }));
    await user.click(screen.getByRole('radio', { name: 'USD' }));
    expect(hooks.usePriorityMatrix).toHaveBeenLastCalledWith(expect.objectContaining({ currency: 'USD' }));
    // financial value is still the row's raw number — the page never converts
    expect(screen.getByText('120')).toBeInTheDocument();
  });

  it('shows the hard-gate forced-to-P1 count from the summary', () => {
    hooks.usePriorityMatrix.mockReturnValue(ready([scoredRow]));
    hooks.usePrioritySummary.mockReturnValue(ready(summary));
    renderWithProviders(<MatrixPage />);
    expect(screen.getByText('Hard-gate forced to P1')).toBeInTheDocument();
  });

  it('degrades to an access notice on a 403 (Engineer / Auditor)', () => {
    const forbidden = failed(new ApiError(403, 'forbidden'));
    hooks.usePriorityMatrix.mockReturnValue(forbidden);
    hooks.usePrioritySummary.mockReturnValue(forbidden);
    renderWithProviders(<MatrixPage />);
    expect(screen.getByText(/does not have access to the Prioritization Matrix/i)).toBeInTheDocument();
    expect(screen.queryByText('Display currency')).not.toBeInTheDocument();
  });

  it('shows the empty state when no projects are in scope', () => {
    hooks.usePriorityMatrix.mockReturnValue(ready([]));
    hooks.usePrioritySummary.mockReturnValue(ready({ ...summary, total_projects: 0, scored_projects: 0, unscored_projects: 0 }));
    renderWithProviders(<MatrixPage />);
    expect(screen.getByText('No projects in scope')).toBeInTheDocument();
  });

  it('hides edit affordances and shows a read-only notice after a 403 on save', async () => {
    const user = userEvent.setup();
    const mutateAsync = vi.fn().mockRejectedValue(new ApiError(403, 'forbidden'));
    hooks.useUpdatePriorityScore.mockReturnValue({ mutateAsync });
    hooks.usePriorityMatrix.mockReturnValue(ready([scoredRow]));
    hooks.usePrioritySummary.mockReturnValue(ready(summary));
    renderWithProviders(<MatrixPage />);

    await user.click(screen.getByRole('button', { name: 'Edit prioritization score for Cooler A' }));
    await user.click(screen.getByRole('button', { name: 'Save score' }));

    expect(await screen.findByText(/read-only access to the Prioritization Matrix/i)).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Edit prioritization score for Cooler A' }),
    ).not.toBeInTheDocument();
  });

  describe('scenario mode (P5-T01)', () => {
    it('is off by default — no pending panel, edits still write immediately', () => {
      hooks.usePriorityMatrix.mockReturnValue(ready([scoredRow]));
      hooks.usePrioritySummary.mockReturnValue(ready(summary));
      renderWithProviders(<MatrixPage />);
      expect(screen.queryByTestId('scenario-panel')).not.toBeInTheDocument();
    });

    it('enabling scenario mode stages an edit locally instead of PUTting it, and shows it in the pending panel', async () => {
      const user = userEvent.setup();
      const mutateAsync = vi.fn().mockResolvedValue({});
      hooks.useUpdatePriorityScore.mockReturnValue({ mutateAsync });
      hooks.usePriorityMatrix.mockReturnValue(ready([scoredRow]));
      hooks.usePrioritySummary.mockReturnValue(ready(summary));
      renderWithProviders(<MatrixPage />);

      await user.click(screen.getByRole('checkbox', { name: 'Scenario mode' }));
      expect(screen.getByTestId('scenario-panel')).toBeInTheDocument();
      expect(screen.getByTestId('scenario-empty')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Edit prioritization score for Cooler A' }));
      const strategic = screen.getByLabelText('Strategic Project');
      await user.clear(strategic);
      await user.type(strategic, '1');
      await user.click(screen.getByRole('button', { name: 'Stage change' }));

      // Nothing was sent to the server — this is the key scenario-mode assertion.
      expect(mutateAsync).not.toHaveBeenCalled();
      expect(screen.queryByTestId('scenario-empty')).not.toBeInTheDocument();
      const item = screen.getByTestId('scenario-pending-item');
      expect(item.textContent).toContain('Cooler A');
      expect(item.textContent).toContain('Strategic Project: 5 → 1');
    });

    it('undo removes the most recently staged edit; redo re-applies it', async () => {
      const user = userEvent.setup();
      hooks.usePriorityMatrix.mockReturnValue(ready([scoredRow]));
      hooks.usePrioritySummary.mockReturnValue(ready(summary));
      renderWithProviders(<MatrixPage />);

      await user.click(screen.getByRole('checkbox', { name: 'Scenario mode' }));
      await user.click(screen.getByRole('button', { name: 'Edit prioritization score for Cooler A' }));
      const strategic = screen.getByLabelText('Strategic Project');
      await user.clear(strategic);
      await user.type(strategic, '1');
      await user.click(screen.getByRole('button', { name: 'Stage change' }));
      expect(screen.getByTestId('scenario-pending-item')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Undo' }));
      expect(screen.getByTestId('scenario-empty')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Redo' }));
      expect(screen.getByTestId('scenario-pending-item')).toBeInTheDocument();
    });

    it('Discard clears every staged edit without sending anything', async () => {
      const user = userEvent.setup();
      const applyMutateAsync = vi.fn().mockResolvedValue({});
      hooks.useApplyScenario.mockReturnValue({ mutateAsync: applyMutateAsync, isPending: false });
      hooks.usePriorityMatrix.mockReturnValue(ready([scoredRow]));
      hooks.usePrioritySummary.mockReturnValue(ready(summary));
      renderWithProviders(<MatrixPage />);

      await user.click(screen.getByRole('checkbox', { name: 'Scenario mode' }));
      await user.click(screen.getByRole('button', { name: 'Edit prioritization score for Cooler A' }));
      const strategic = screen.getByLabelText('Strategic Project');
      await user.clear(strategic);
      await user.type(strategic, '1');
      await user.click(screen.getByRole('button', { name: 'Stage change' }));

      await user.click(screen.getByRole('button', { name: 'Discard' }));
      expect(screen.getByTestId('scenario-empty')).toBeInTheDocument();
      expect(applyMutateAsync).not.toHaveBeenCalled();
    });

    it('Apply POSTs only the genuinely-changed dimensions for the staged project, then clears the panel', async () => {
      const user = userEvent.setup();
      const applyMutateAsync = vi.fn().mockResolvedValue({
        run: { id: 'r1', version: 5, applied_by_user_id: 'u1', notes: null, entity_types_touched: ['PRIORITY_SCORE'], change_count: 1, created_at: '2026-09-01T00:00:00Z' },
        updated_priority_scores: ['s1'],
        suggested_bands: { p1: 'P1' },
      });
      hooks.useApplyScenario.mockReturnValue({ mutateAsync: applyMutateAsync, isPending: false });
      hooks.usePriorityMatrix.mockReturnValue(ready([scoredRow]));
      hooks.usePrioritySummary.mockReturnValue(ready(summary));
      renderWithProviders(<MatrixPage />);

      await user.click(screen.getByRole('checkbox', { name: 'Scenario mode' }));
      await user.click(screen.getByRole('button', { name: 'Edit prioritization score for Cooler A' }));
      const strategic = screen.getByLabelText('Strategic Project');
      await user.clear(strategic);
      await user.type(strategic, '1');
      await user.click(screen.getByRole('button', { name: 'Stage change' }));

      await user.click(screen.getByRole('button', { name: /Apply/ }));

      expect(applyMutateAsync).toHaveBeenCalledTimes(1);
      const [body] = applyMutateAsync.mock.calls[0] as [{ priority_scores: Record<string, unknown>[] }];
      expect(body.priority_scores).toHaveLength(1);
      expect(body.priority_scores[0]).toMatchObject({ project_id: 'p1', strategic_project: 1 });

      await screen.findByTestId('scenario-empty');
    });
  });

  describe('Versions & History (P5-T03)', () => {
    it('renders a "Version history" trigger that opens the browse dialog', async () => {
      const user = userEvent.setup();
      hooks.usePriorityMatrix.mockReturnValue(ready([scoredRow]));
      hooks.usePrioritySummary.mockReturnValue(ready(summary));
      hooks.useScenarioVersions.mockReturnValue({
        data: [
          {
            id: 'r1', version: 3, applied_by_user_id: 'u1', notes: null,
            entity_types_touched: ['priority_score'], change_count: 1, created_at: '2026-08-01T00:00:00Z',
          },
        ],
        isPending: false, isError: false, error: null, refetch: vi.fn(),
      });
      renderWithProviders(<MatrixPage />);

      await user.click(screen.getByRole('button', { name: 'Version history' }));
      expect(screen.getByText('Scenario version history')).toBeInTheDocument();
      expect(screen.getByTestId('version-history-row')).toBeInTheDocument();
    });

    it('resolves a changed project in the diff view using the grid rows already on the page', async () => {
      const user = userEvent.setup();
      hooks.usePriorityMatrix.mockReturnValue(ready([scoredRow]));
      hooks.usePrioritySummary.mockReturnValue(ready(summary));
      hooks.useScenarioVersions.mockReturnValue({
        data: [
          {
            id: 'r1', version: 3, applied_by_user_id: 'u1', notes: null,
            entity_types_touched: ['priority_score'], change_count: 1, created_at: '2026-08-01T00:00:00Z',
          },
        ],
        isPending: false, isError: false, error: null, refetch: vi.fn(),
      });
      hooks.useScenarioVersionDetail.mockReturnValue({
        data: {
          id: 'r1', version: 3, applied_by_user_id: 'u1', notes: null,
          entity_types_touched: ['priority_score'], change_count: 1, created_at: '2026-08-01T00:00:00Z',
          changes: [
            {
              id: 'c1', entity_type: 'priority_score', entity_id: 's1',
              project_id: 'p1', hub_id: 'h1',
              before_state: { strategic_project: 3 },
              after_state: { strategic_project: 4 },
            },
          ],
        },
        isPending: false, isError: false, error: null, refetch: vi.fn(),
      });
      renderWithProviders(<MatrixPage />);

      await user.click(screen.getByRole('button', { name: 'Version history' }));
      await user.click(screen.getByRole('button', { name: 'View diff' }));

      // "Cooler A" comes from the already-loaded Matrix grid row (scoredRow),
      // not an independent fetch — the version detail endpoint itself never
      // returns a project name.
      const change = screen.getByTestId('version-detail-change');
      expect(within(change).getByText('Cooler A')).toBeInTheDocument();
    });
  });
});

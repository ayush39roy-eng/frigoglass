import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import { permissionsFrom } from '@/test/session';
import { ApiError } from '@/lib/api/client';
import { useScenarioStore } from '@/stores/scenario';
import { useHubFilterStore } from '@/stores/hub-filter';
import type {
  CurrencyOption,
  PriorityCompareProject,
  PriorityDistribution,
  PriorityMatrixRow,
  PriorityPortfolioSummary,
} from './api/types';
import { useCompareSelection } from './lib/compare-selection';

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
  useUpdateCurrencyRate: vi.fn(),
  useScoringDimensions: vi.fn<() => { data: unknown }>(() => ({ data: undefined })),
  useMatrixCurrencies: vi.fn(),
  usePriorityDistribution: vi.fn(),
  usePriorityCompare: vi.fn(),
  usePriorityEditRows: vi.fn<(ids: string[], enabled: boolean) => unknown[]>(() => []),
  usePriorityCapacityFill: vi.fn<(hubId: string | null, region: string | null) => unknown>(() => ({ data: undefined, isPending: true, isError: false })),
};
vi.mock('./hooks/use-matrix', () => ({
  usePriorityMatrix: (args: unknown) => hooks.usePriorityMatrix(args),
  usePrioritySummary: (...a: unknown[]) => hooks.usePrioritySummary(...a),
  useCurrencyRates: () => hooks.useCurrencyRates(),
  useUpdatePriorityScore: () => hooks.useUpdatePriorityScore(),
  useApplyScenario: () => hooks.useApplyScenario(),
  useScenarioVersions: (args: unknown) => hooks.useScenarioVersions(args),
  useScenarioVersionDetail: (version: number | null) => hooks.useScenarioVersionDetail(version),
  useUpdateCurrencyRate: () => hooks.useUpdateCurrencyRate(),
  useScoringDimensions: () => hooks.useScoringDimensions(),
  useMatrixCurrencies: () => hooks.useMatrixCurrencies(),
  usePriorityDistribution: (args: unknown) => hooks.usePriorityDistribution(args),
  usePriorityCompare: (ids: string[], enabled: boolean) => hooks.usePriorityCompare(ids, enabled),
  usePriorityEditRows: (ids: string[], enabled: boolean) => hooks.usePriorityEditRows(ids, enabled),
  usePriorityCapacityFill: (hubId: string | null, region: string | null) => hooks.usePriorityCapacityFill(hubId, region),
}));
vi.mock('@/lib/api/reference', () => ({ useHubs: () => ({ data: [] }) }));

import MatrixPage from './MatrixPage';
import { P13_MATRIX_ROW_DEFAULTS, P25_FILL_DEFAULTS } from './test-fixtures';

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
  score_band_counts: { P1: 3, P2: 2, P3: 1, P4: 1 },
  capacity_fill_count: 0,
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
  ...P13_MATRIX_ROW_DEFAULTS,
};

const currencies: CurrencyOption[] = [
  { currency_code: 'EUR', name: 'Euro', rate_to_eur: 1, configured: true },
  { currency_code: 'USD', name: 'US dollar', rate_to_eur: 1.08, configured: true },
  { currency_code: 'INR', name: 'Indian rupee', rate_to_eur: 97, configured: true },
  { currency_code: 'EGP', name: 'Egyptian pound', rate_to_eur: 52.3, configured: true },
  { currency_code: 'ZAR', name: 'South African rand', rate_to_eur: null, configured: false },
  { currency_code: 'IDR', name: 'Indonesian rupiah', rate_to_eur: null, configured: false },
];

const distribution: PriorityDistribution = {
  total_projects: 10,
  scored_projects: 7,
  band_distribution: [
    { band: 'P1', count: 3, share_pct: 30 },
    { band: 'P2', count: 2, share_pct: 20 },
    { band: 'P3', count: 1, share_pct: 10 },
    { band: 'P4', count: 1, share_pct: 10 },
    { band: 'Q', count: 0, share_pct: 0 },
    { band: 'Unscored', count: 3, share_pct: 30 },
  ],
  score_histogram: Array.from({ length: 10 }, (_, i) => ({
    bucket_from: i * 10,
    bucket_to: i * 10 + 10,
    count: i === 7 ? 3 : i === 5 ? 2 : 0,
  })),
  capacity_fill_count: 0,
};

/** Selector for the "USD · US dollar" style option names. */
const usd = { name: 'USD · US dollar' };

beforeEach(() => {
  vi.clearAllMocks();
  useScenarioStore.setState({ active: false, notes: '', pending: {}, past: [], future: [] });
  useCompareSelection.setState({ items: [], capHit: false });
  hooks.useMatrixCurrencies.mockReturnValue(ready(currencies));
  hooks.usePriorityMatrix.mockReset();
  hooks.usePriorityDistribution.mockReturnValue(ready(distribution));
  hooks.usePriorityCompare.mockReturnValue(pending);
  hooks.useUpdatePriorityScore.mockReturnValue({ mutateAsync: vi.fn().mockResolvedValue({}) });
  hooks.useApplyScenario.mockReturnValue({ mutateAsync: vi.fn().mockResolvedValue({}), isPending: false });
  hooks.useScenarioVersions.mockReturnValue({ data: undefined, isPending: true, isError: false, error: null, refetch: vi.fn() });
  hooks.useScenarioVersionDetail.mockReturnValue({ data: undefined, isPending: true, isError: false, error: null, refetch: vi.fn() });
  hooks.useUpdateCurrencyRate.mockReturnValue({ mutateAsync: vi.fn().mockResolvedValue({}), isPending: false });
  hooks.useScoringDimensions.mockReturnValue({ data: undefined });
});

describe('MatrixPage', () => {
  it('P12 (ADR 0020): grid and summary follow the global hub filter; no page-local Hub select', () => {
    useHubFilterStore.setState({ hubId: 'hub-romania' });
    hooks.usePriorityMatrix.mockReturnValue(pending);
    hooks.usePrioritySummary.mockReturnValue(pending);
    try {
      renderWithProviders(<MatrixPage />);
      expect(hooks.usePriorityMatrix).toHaveBeenLastCalledWith(expect.objectContaining({ hubId: 'hub-romania' }));
      expect(hooks.usePrioritySummary).toHaveBeenLastCalledWith('hub-romania', null);
      expect(screen.queryByRole('combobox', { name: 'Hub' })).not.toBeInTheDocument();
      expect(screen.getByTestId('hub-filter-chip')).toBeInTheDocument();
    } finally {
      useHubFilterStore.setState({ hubId: null, region: null });
    }
  });

  it('always renders the heading and the currency toggle', () => {
    hooks.usePriorityMatrix.mockReturnValue(pending);
    hooks.usePrioritySummary.mockReturnValue(pending);
    renderWithProviders(<MatrixPage />);
    expect(screen.getByRole('heading', { name: 'Prioritization Matrix' })).toBeInTheDocument();
    expect(screen.getByText('Display currency')).toBeInTheDocument();
  });

  it('P16: shows the served total line and omits it when the table is not served', () => {
    hooks.usePriorityMatrix.mockReturnValue(ready([scoredRow]));
    hooks.usePrioritySummary.mockReturnValue(ready(summary));
    renderWithProviders(<MatrixPage />);
    expect(screen.queryByTestId('scoring-total-line')).not.toBeInTheDocument();
  });

  it('P16: renders Total: 100 (scaled from <served total_weight>)', () => {
    hooks.useScoringDimensions.mockReturnValue({ data: { total_weight: 295, dimensions: [] } });
    hooks.usePriorityMatrix.mockReturnValue(ready([scoredRow]));
    hooks.usePrioritySummary.mockReturnValue(ready(summary));
    renderWithProviders(<MatrixPage />);
    expect(screen.getByTestId('scoring-total-line')).toHaveTextContent('Total: 100 (scaled from 295)');
  });

  it('changing the currency toggle re-requests the matrix with the new currency param (no client math)', async () => {
    const user = userEvent.setup();
    hooks.usePriorityMatrix.mockReturnValue(ready([scoredRow]));
    hooks.usePrioritySummary.mockReturnValue(ready(summary));
    renderWithProviders(<MatrixPage />);

    expect(hooks.usePriorityMatrix).toHaveBeenLastCalledWith(expect.objectContaining({ currency: 'EUR' }));
    await user.click(screen.getByRole('radio', usd));
    expect(hooks.usePriorityMatrix).toHaveBeenLastCalledWith(expect.objectContaining({ currency: 'USD' }));
    expect(screen.getByTestId('currency-rate-caption')).toHaveTextContent('1 EUR = 1.08 USD');
  });

  describe('P21 currencies', () => {
    it('offers EUR, USD, INR, EGP, ZAR and IDR labelled "code · name"', () => {
      hooks.usePriorityMatrix.mockReturnValue(ready([scoredRow]));
      hooks.usePrioritySummary.mockReturnValue(ready(summary));
      renderWithProviders(<MatrixPage />);
      const group = screen.getByRole('radiogroup', { name: 'Display currency' });
      expect(within(group).getAllByRole('radio').map((r) => r.getAttribute('aria-label'))).toEqual([
        'EUR · Euro',
        'USD · US dollar',
        'INR · Indian rupee',
        'EGP · Egyptian pound',
        'ZAR · South African rand',
        'IDR · Indonesian rupiah',
      ]);
      expect(within(group).getByText('EGP · Egyptian pound')).toBeInTheDocument();
    });

    it('a currency with configured=false is disabled, explains why, and is never requested', async () => {
      const user = userEvent.setup();
      hooks.usePriorityMatrix.mockReturnValue(ready([scoredRow]));
      hooks.usePrioritySummary.mockReturnValue(ready(summary));
      renderWithProviders(<MatrixPage />);
      const zar = screen.getByRole('radio', { name: 'ZAR · South African rand' });
      expect(zar).toHaveAttribute('aria-disabled', 'true');
      expect(zar).toHaveAccessibleDescription('Rate not set — an Admin can set it');
      expect(screen.getByRole('radio', { name: 'EGP · Egyptian pound' })).not.toHaveAttribute('aria-disabled');
      await user.hover(zar);
      expect(await screen.findByRole('tooltip')).toHaveTextContent('Rate not set — an Admin can set it');
      await user.click(zar);
      expect(hooks.usePriorityMatrix).not.toHaveBeenCalledWith(expect.objectContaining({ currency: 'ZAR' }));
      await user.click(screen.getByRole('radio', { name: 'EGP · Egyptian pound' }));
      expect(hooks.usePriorityMatrix).toHaveBeenLastCalledWith(expect.objectContaining({ currency: 'EGP' }));
    });

    it('a 422 CURRENCY_NOT_CONFIGURED falls back to EUR and says why', async () => {
      const user = userEvent.setup();
      hooks.usePriorityMatrix.mockImplementation((p: { currency: string }) =>
        p.currency === 'EGP'
          ? failed(new ApiError(422, 'x', 'No exchange rate is configured for EGP.', 'CURRENCY_NOT_CONFIGURED'))
          : ready([scoredRow]),
      );
      hooks.usePrioritySummary.mockReturnValue(ready(summary));
      renderWithProviders(<MatrixPage />);
      await user.click(screen.getByRole('radio', { name: 'EGP · Egyptian pound' }));
      expect(await screen.findByTestId('currency-not-configured')).toHaveTextContent(
        'No exchange rate is configured for EGP, so figures are shown in EUR.',
      );
      expect(hooks.usePriorityMatrix).toHaveBeenLastCalledWith(expect.objectContaining({ currency: 'EUR' }));
    });
  });

  describe('P21 sticky View panel', () => {
    it('turns compact when stuck: smaller padding, shadow, filters behind "Filters (n)"', async () => {
      const user = userEvent.setup();
      hooks.usePriorityMatrix.mockReturnValue(ready([scoredRow]));
      hooks.usePrioritySummary.mockReturnValue(ready(summary));
      renderWithProviders(<MatrixPage />);
      const panel = screen.getByTestId('matrix-view-panel');
      expect(panel).toHaveAttribute('data-stuck', 'false');
      expect(panel.className).toContain('sticky');
      expect(screen.getByRole('radiogroup', { name: 'Cat' })).toBeInTheDocument();

      await user.click(within(screen.getByRole('radiogroup', { name: 'Cat' })).getByRole('radio', { name: 'B' }));

      const sentinel = screen.getByTestId('matrix-view-sentinel');
      vi.spyOn(sentinel, 'getBoundingClientRect').mockReturnValue({ top: -40 } as DOMRect);
      fireEvent.scroll(window);
      await waitFor(() => expect(panel).toHaveAttribute('data-stuck', 'true'));
      expect(panel.className).toContain('shadow-pop');
      expect(panel.className).toContain('py-2');
      expect(screen.queryByRole('radiogroup', { name: 'Cat' })).not.toBeInTheDocument();

      const toggle = screen.getByRole('button', { name: /Filters \(1\)/ });
      expect(toggle).toHaveAttribute('aria-expanded', 'false');
      await user.click(toggle);
      expect(toggle).toHaveAttribute('aria-expanded', 'true');
      expect(screen.getByRole('radiogroup', { name: 'Cat' })).toBeInTheDocument();

      vi.spyOn(sentinel, 'getBoundingClientRect').mockReturnValue({ top: 20 } as DOMRect);
      fireEvent.scroll(window);
      await waitFor(() => expect(panel).toHaveAttribute('data-stuck', 'false'));
    });

    it('the grid scrolls inside its own labelled, focusable region', () => {
      hooks.usePriorityMatrix.mockReturnValue(ready([scoredRow]));
      hooks.usePrioritySummary.mockReturnValue(ready(summary));
      renderWithProviders(<MatrixPage />);
      const region = screen.getByRole('region', { name: /Scoring grid table/ });
      expect(region).toHaveAttribute('tabindex', '0');
      expect(within(region).getByRole('table', { name: 'Prioritization scoring grid' })).toBeInTheDocument();
    });
  });

  describe('P21 chart row', () => {
    it('renders the served band distribution (counts and shares) and the score histogram', () => {
      hooks.usePriorityMatrix.mockReturnValue(ready([scoredRow]));
      hooks.usePrioritySummary.mockReturnValue(ready(summary));
      renderWithProviders(<MatrixPage />);
      expect(hooks.usePriorityDistribution).toHaveBeenLastCalledWith(
        expect.objectContaining({ category: undefined, hubId: undefined }),
      );
      const dist = screen.getByTestId('band-distribution');
      expect(within(dist).getByTestId('band-legend-P1')).toHaveTextContent('P13(30%)');
      expect(within(dist).getByTestId('band-legend-Unscored')).toHaveTextContent('Unscored3(30%)');
      // Q is a committed priority, never a score band: muted and not a filter button.
      expect(within(dist).getByTestId('band-legend-Q').tagName).toBe('SPAN');
      const hist = screen.getByTestId('score-histogram');
      const table = within(hist).getByRole('table');
      expect(within(table).getByRole('row', { name: '70–80 3' })).toBeInTheDocument();
      expect(within(table).getAllByRole('row')).toHaveLength(11);
    });

    it('the distribution follows the server filters', async () => {
      const user = userEvent.setup();
      hooks.usePriorityMatrix.mockReturnValue(ready([scoredRow]));
      hooks.usePrioritySummary.mockReturnValue(ready(summary));
      renderWithProviders(<MatrixPage />);
      await user.click(within(screen.getByRole('radiogroup', { name: 'Status' })).getByRole('radio', { name: 'In Queue' }));
      expect(hooks.usePriorityDistribution).toHaveBeenLastCalledWith(expect.objectContaining({ status: 'In Queue' }));
    });

    it('clicking a band narrows the table to the rows whose served band matches', async () => {
      const user = userEvent.setup();
      const p3Row: PriorityMatrixRow = { ...scoredRow, project_id: 'p9', project_name: 'Cooler P3', suggested_band: 'P3', rank: 2 };
      hooks.usePriorityMatrix.mockReturnValue(ready([scoredRow, p3Row]));
      hooks.usePrioritySummary.mockReturnValue(ready(summary));
      renderWithProviders(<MatrixPage />);
      const p3 = screen.getByTestId('band-legend-P3');
      await user.click(p3);
      expect(p3).toHaveAttribute('aria-pressed', 'true');
      expect(screen.getByTestId('matrix-row-count')).toHaveTextContent('1 of 2 projects shown');
      expect(screen.getByRole('link', { name: 'Cooler P3' })).toBeInTheDocument();
      expect(screen.queryByRole('link', { name: 'Cooler A' })).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Clear band filter (P3)' }));
      expect(screen.getByTestId('matrix-row-count')).toHaveTextContent('2 projects');
    });
  });

  describe('P21 compare', () => {
    const rows: PriorityMatrixRow[] = Array.from({ length: 6 }, (_, i) => ({
      ...scoredRow,
      project_id: `c${String(i)}`,
      project_name: `Cooler ${String(i)}`,
      rank: i + 1,
    }));
    const dims = (strat: number) => [
      { key: 'strategic_project' as const, label: 'Strategic Project', pillar: 'Strategic Alignment', score: strat, weight: 25, points: strat * 5, max_points: 25 },
      { key: 'capex_investment' as const, label: 'CAPEX Investment (inverted)', pillar: 'Investment & Feasibility', score: 2, weight: 15, points: 6, max_points: 15 },
    ];
    const compared: PriorityCompareProject[] = [
      {
        project_id: 'c0', project_name: 'Cooler 0', hub: 'R&D-Greece', set_priority: 'P2', has_score: true,
        weighted_score: 268, normalized_pct: 91, suggested_band: 'P1', dimension_scores: dims(5), ...P25_FILL_DEFAULTS,
      },
      {
        project_id: 'c1', project_name: 'Cooler 1', hub: 'PD-India', set_priority: null, has_score: true,
        weighted_score: 130, normalized_pct: 44, suggested_band: 'P3', dimension_scores: dims(0), ...P25_FILL_DEFAULTS,
      },
      {
        project_id: 'c2', project_name: 'Cooler 2', hub: 'PD-India', set_priority: null, has_score: false,
        weighted_score: null, normalized_pct: null, suggested_band: null,
        dimension_scores: dims(0).map((d) => ({ ...d, score: null, points: null })), ...P25_FILL_DEFAULTS,
      },
    ];

    it('caps the selection at 5 with a message, keeps it across filters, and Clear empties it', async () => {
      const user = userEvent.setup();
      hooks.usePriorityMatrix.mockReturnValue(ready(rows));
      hooks.usePrioritySummary.mockReturnValue(ready(summary));
      renderWithProviders(<MatrixPage />);
      expect(screen.queryByTestId('compare-bar')).not.toBeInTheDocument();

      await user.click(screen.getByRole('checkbox', { name: 'Select Cooler 0 to compare' }));
      expect(screen.getByTestId('compare-message')).toHaveTextContent('Select at least 2 projects to compare');
      expect(screen.getByRole('button', { name: 'Compare (1)' })).toBeDisabled();

      for (const i of [1, 2, 3, 4]) {
        await user.click(screen.getByRole('checkbox', { name: `Select Cooler ${String(i)} to compare` }));
      }
      expect(screen.getByRole('button', { name: 'Compare (5)' })).toBeEnabled();
      await user.click(screen.getByRole('checkbox', { name: 'Select Cooler 5 to compare' }));
      expect(screen.getByRole('checkbox', { name: 'Select Cooler 5 to compare' })).not.toBeChecked();
      expect(screen.getByTestId('compare-message')).toHaveTextContent('Up to 5 projects can be compared');

      // A filter change keeps the selection.
      await user.click(within(screen.getByRole('radiogroup', { name: 'Cat' })).getByRole('radio', { name: 'B' }));
      expect(screen.getByRole('button', { name: 'Compare (5)' })).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Clear' }));
      expect(screen.queryByTestId('compare-bar')).not.toBeInTheDocument();
    });

    it('opens the dialog: calls GET /priorities/compare for the selection, shows radar legend and the dimension table', async () => {
      const user = userEvent.setup();
      hooks.usePriorityMatrix.mockReturnValue(ready(rows));
      hooks.usePrioritySummary.mockReturnValue(ready(summary));
      hooks.usePriorityCompare.mockReturnValue(ready({ projects: compared }));
      // Read-only (Executive Viewer style): static values; P21-T04 editing is in compare-dialog.test.tsx.
      renderWithProviders(<MatrixPage />, { session: { roles: ['Executive Viewer'], permissions: permissionsFrom({ matrix: 'r' }) } });

      await user.click(screen.getByRole('checkbox', { name: 'Select Cooler 0 to compare' }));
      await user.click(screen.getByRole('checkbox', { name: 'Select Cooler 1 to compare' }));
      await user.click(screen.getByRole('checkbox', { name: 'Select Cooler 2 to compare' }));
      await user.click(screen.getByRole('button', { name: 'Compare (3)' }));

      expect(hooks.usePriorityCompare).toHaveBeenLastCalledWith(['c0', 'c1', 'c2'], true);
      const dialog = screen.getByRole('dialog', { name: 'Compare projects (3)' });
      const legend = within(dialog).getByRole('list', { name: /Legend/ });
      const legendButtons = within(legend).getAllByRole('button');
      expect(legendButtons).toHaveLength(3);
      await user.click(legendButtons[1] as HTMLElement);
      expect(legendButtons[1]).toHaveAttribute('aria-pressed', 'false');

      const table = within(dialog).getByTestId('compare-table');
      expect(within(table).getByRole('columnheader', { name: 'Strategic Alignment' })).toBeInTheDocument();
      const strat = within(table).getAllByTestId('compare-row')[0] as HTMLElement;
      expect(strat).toHaveTextContent('Strategic Project');
      const cells = within(strat).getAllByRole('cell');
      expect(cells[0]).toHaveTextContent('525/25 pts');
      expect(cells[0]).toHaveAttribute('data-highest', 'true');
      expect(cells[1]).toHaveTextContent('00/25 pts');
      expect(cells[1]).not.toHaveAttribute('data-highest');
      const total = within(table).getByTestId('compare-total-row');
      expect(total).toHaveTextContent('91/100');
      expect(total).toHaveTextContent('44/100');
      expect(within(total).getAllByRole('cell')[2]).toHaveTextContent('Not scored');
    });

    it('maps a 422 COMPARE_PROJECT_UNAVAILABLE to a readable message', async () => {
      const user = userEvent.setup();
      hooks.usePriorityMatrix.mockReturnValue(ready(rows));
      hooks.usePrioritySummary.mockReturnValue(ready(summary));
      hooks.usePriorityCompare.mockReturnValue(
        failed(new ApiError(422, 'x', 'unavailable', 'COMPARE_PROJECT_UNAVAILABLE')),
      );
      renderWithProviders(<MatrixPage />);
      await user.click(screen.getByRole('checkbox', { name: 'Select Cooler 0 to compare' }));
      await user.click(screen.getByRole('checkbox', { name: 'Select Cooler 1 to compare' }));
      await user.click(screen.getByRole('button', { name: 'Compare (2)' }));
      expect(screen.getByRole('alert')).toHaveTextContent('One of the selected projects is no longer available to you');
    });
  });

  it('P25: the "Capacity fill" chip narrows the served rows to those the server promoted', async () => {
    const user = userEvent.setup();
    hooks.usePriorityMatrix.mockReturnValue(
      ready([
        { ...scoredRow, project_id: 'f1', project_name: 'Filled Cooler', rank: 1, suggested_band: 'P1', score_band: 'P2', capacity_fill: true, capacity_fill_reason: 'P1 (capacity fill): hub P1 design load 9.00 of 10.00 weeks with this project' },
        { ...scoredRow, project_id: 'n1', project_name: 'Plain Cooler', rank: 2 },
      ]),
    );
    hooks.usePrioritySummary.mockReturnValue(ready(summary));
    renderWithProviders(<MatrixPage />);
    const chip = screen.getByRole('button', { name: 'Capacity fill' });
    expect(chip).toHaveAttribute('aria-pressed', 'false');
    await user.click(chip);
    expect(chip).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('matrix-row-count')).toHaveTextContent('1 of 2 projects shown');
    expect(screen.getByText('Filled Cooler')).toBeInTheDocument();
    expect(screen.queryByText('Plain Cooler')).not.toBeInTheDocument();
    expect(screen.getByTestId('band-chip-capacity-fill')).toHaveTextContent('P1 · capacity fill');
    await user.click(chip);
    expect(screen.getByTestId('matrix-row-count')).toHaveTextContent('2 projects');
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

  describe('P13-T14 toolbar (API_CONTRACT_P13 §7)', () => {
    const rowB: PriorityMatrixRow = {
      ...scoredRow,
      project_id: 'p2',
      project_name: 'Cooler B',
      hub: 'PD-India',
      status: 'In Queue',
      leader_engineer_id: 'eng-2',
      rank: 2,
    };
    const rowA: PriorityMatrixRow = { ...scoredRow, leader_name: 'Rishi', leader_engineer_id: 'eng-1', rank: 1 };
    const rowC: PriorityMatrixRow = { ...scoredRow, project_id: 'p3', project_name: 'Cooler C', rank: null, has_score: false };

    beforeEach(() => {
      hooks.usePriorityMatrix.mockReturnValue(ready([rowA, rowB, rowC]));
      hooks.usePrioritySummary.mockReturnValue(ready(summary));
    });

    it('renders the served Rank, Leader (unavailable / none) and Status columns', async () => {
      const user = userEvent.setup();
      renderWithProviders(<MatrixPage />);
      await user.click(screen.getByRole('button', { name: 'Detailed view' }));
      for (const name of ['Rank', 'Leader', 'Status']) {
        expect(screen.getByRole('columnheader', { name })).toBeInTheDocument();
      }
      const rows = screen.getAllByRole('row').filter((r) => within(r).queryByRole('link') !== null);
      expect(rows[0]).toHaveTextContent('1');
      expect(within(rows[0]).getByText('Rishi')).toBeInTheDocument();
      expect(within(rows[1]).getByText('Name unavailable')).toBeInTheDocument();
      expect(within(rows[1]).getByText('In Queue')).toBeInTheDocument();
      expect(within(rows[2]).getByTitle('No leader assigned')).toBeInTheDocument();
      expect(within(rows[2]).getByTitle('Not scored — no rank')).toBeInTheDocument();
    });

    it('sends the Cat / Type / Status chips and the debounced Project search to the server', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime.bind(vi) });
        renderWithProviders(<MatrixPage />);
        await user.click(within(screen.getByRole('radiogroup', { name: 'Cat' })).getByRole('radio', { name: 'B' }));
        await user.click(within(screen.getByRole('radiogroup', { name: 'Type' })).getByRole('radio', { name: 'CO' }));
        await user.click(within(screen.getByRole('radiogroup', { name: 'Status' })).getByRole('radio', { name: 'In Queue' }));
        await user.type(screen.getByRole('searchbox', { name: 'Filter by project name or code' }), 'evap');
        await act(async () => {
          await vi.advanceTimersByTimeAsync(400);
        });
        expect(hooks.usePriorityMatrix).toHaveBeenLastCalledWith(
          expect.objectContaining({ category: 'B', type: 'CO', status: 'In Queue', q: 'evap' }),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it('the Hub and Leader column inputs narrow the served rows in view only', async () => {
      const user = userEvent.setup();
      renderWithProviders(<MatrixPage />);
      await user.click(screen.getByRole('button', { name: 'Detailed view' }));
      const calls = hooks.usePriorityMatrix.mock.calls.length;
      await user.type(screen.getByRole('searchbox', { name: 'Filter by leader' }), 'unavailable');
      expect(screen.getByTestId('matrix-row-count')).toHaveTextContent('1 of 3 projects shown');
      expect(screen.getByText('Cooler B')).toBeInTheDocument();
      expect(screen.queryByText('Cooler C')).not.toBeInTheDocument();
      // No new server params from a view filter.
      expect(hooks.usePriorityMatrix.mock.calls.slice(calls).every(([p]) => (p as { q?: string }).q === undefined)).toBe(true);
    });

    it('the 13 dimension columns are always shown; Detailed view adds Leader and points; Reset view restores the default', async () => {
      const user = userEvent.setup();
      renderWithProviders(<MatrixPage />);
      expect(screen.getAllByRole('button', { name: /^Strategic Project: 1 =/ }).length).toBeGreaterThan(0);
      expect(screen.queryByRole('columnheader', { name: 'Leader' })).not.toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Detailed view' }));
      expect(screen.getByRole('columnheader', { name: 'Leader' })).toBeInTheDocument();
      await user.click(within(screen.getByRole('radiogroup', { name: 'Type' })).getByRole('radio', { name: 'CO' }));
      await user.click(screen.getByRole('radio', usd));

      await user.click(screen.getByRole('button', { name: 'Reset view' }));
      expect(screen.queryByRole('columnheader', { name: 'Leader' })).not.toBeInTheDocument();
      expect(hooks.usePriorityMatrix).toHaveBeenLastCalledWith(
        expect.objectContaining({ currency: 'EUR', type: undefined, category: undefined, status: undefined }),
      );
      expect(screen.getByRole('button', { name: 'Reset view' })).toBeDisabled();
    });

    it('Admin edits the FX rate through PUT /currency-rates (via the mutation), never in the browser', async () => {
      const mutateAsync = vi.fn().mockResolvedValue({});
      hooks.useUpdateCurrencyRate.mockReturnValue({ mutateAsync, isPending: false });
      const user = userEvent.setup();
      renderWithProviders(<MatrixPage />);
      expect(screen.queryByTestId('fx-rate-editor')).not.toBeInTheDocument(); // EUR: nothing to edit
      await user.click(screen.getByRole('radio', usd));
      const input = screen.getByRole('spinbutton', { name: 'Exchange rate (Admin)' });
      expect(input).toHaveValue(1.08);
      await user.clear(input);
      await user.type(input, '1.1');
      await user.click(screen.getByRole('button', { name: 'Save rate' }));
      expect(mutateAsync).toHaveBeenCalledWith({ code: 'USD', rateToEur: 1.1 });
      expect(await screen.findByText('Rate saved — figures re-read from the server.')).toBeInTheDocument();
    });

    it('a non-Admin role never sees the FX editor', async () => {
      const user = userEvent.setup();
      renderWithProviders(<MatrixPage />, { session: { roles: ['Portfolio Manager'] } });
      await user.click(screen.getByRole('radio', usd));
      expect(screen.queryByTestId('fx-rate-editor')).not.toBeInTheDocument();
      expect(screen.getByTestId('currency-rate-caption')).toHaveTextContent('1 EUR = 1.08 USD');
    });
  });
});

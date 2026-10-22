import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { screen, waitFor, within } from '@testing-library/react';
import { render } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return { ...actual, apiGet: vi.fn(), apiSend: vi.fn() };
});
// jsdom has no layout, so recharts would draw nothing: expose the radar's data instead.
vi.mock('recharts', () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  RadarChart: ({ data, children }: { data: unknown; children: React.ReactNode }) => (
    <div data-testid="radar-chart" data-radar={JSON.stringify(data)}>
      {children}
    </div>
  ),
  Radar: ({ dataKey }: { dataKey: string }) => <span data-testid="radar-series" data-key={dataKey} />,
  PolarGrid: () => null,
  PolarAngleAxis: () => null,
  PolarRadiusAxis: () => null,
  Tooltip: () => null,
}));

import { ApiError, apiGet, apiSend } from '@/lib/api/client';
import { useScenarioStore } from '@/stores/scenario';
import { TooltipProvider } from '@/components/ui/tooltip';
import { seedSession } from '@/test/session';
import { seriousAxeViolations } from '@/test/axe';
import type { HardGateReason, HubName, ProjectPriority } from '@/types/enums';

import type { PriorityCompareProject, PriorityMatrixRow, PriorityScoreUpdateRequest } from '../api/types';
import { useCompareSelection } from '../lib/compare-selection';
import { INITIAL_TEST_DIMENSIONS, P13_MATRIX_ROW_DEFAULTS } from '../test-fixtures';
import { CompareDialog, type CompareDialogProps } from './compare-dialog';

const mockGet = vi.mocked(apiGet);
const mockSend = vi.mocked(apiSend);
const TOTAL = 295;
const GATE: HardGateReason = 'Regulatory deadline within 6 months';

/** The test plays the server: it holds the stored scores and computes the served figures. */
type Scores = Record<string, number | null>;
const server: Record<string, { name: string; hub: HubName; scores: Scores | null; gates: HardGateReason[]; fill?: string }> = {};

function band(pct: number): ProjectPriority {
  return pct >= 70 ? 'P1' : pct >= 55 ? 'P2' : pct >= 40 ? 'P3' : 'P4';
}
function served(id: string) {
  const s = server[id];
  if (!s) throw new Error(id);
  // P26: a missing score counts 0 and is listed; no score at all = unscored.
  const dims = INITIAL_TEST_DIMENSIONS.map((d) => {
    const score = s.scores?.[d.key] ?? null;
    return {
      key: d.key, label: d.label, pillar: d.pillar, weight: d.weight, max_points: d.weight,
      score, points: score === null ? null : (score / 5) * d.weight,
    };
  });
  const scored = dims.some((d) => d.score !== null);
  const raw = scored ? dims.reduce((a, d) => a + (d.points ?? 0), 0) : null;
  const pct = raw === null ? null : Math.round((raw / TOTAL) * 100);
  const missing = scored ? dims.filter((d) => d.score === null).map((d) => d.key) : [];
  return { dims, raw, pct, band: pct === null ? null : band(pct), scored, missing };
}
function compareItem(id: string): PriorityCompareProject {
  const s = server[id]!;
  const v = served(id);
  return {
    project_id: id, project_name: s.name, hub: s.hub, set_priority: null, has_score: v.scored,
    weighted_score: v.raw, normalized_pct: v.pct, suggested_band: s.fill ? 'P1' : v.band, dimension_scores: v.dims,
    score_band: v.band, capacity_fill: s.fill !== undefined, capacity_fill_reason: s.fill ?? null,
    missing_dimension_keys: v.missing, rubric_version: 1,
  };
}
function matrixRow(id: string): PriorityMatrixRow {
  const s = server[id]!;
  const v = served(id);
  return {
    ...P13_MATRIX_ROW_DEFAULTS,
    missing_dimension_keys: v.missing,
    project_id: id, project_name: s.name, hub: s.hub, category: 'A', type: 'NM', set_priority: null,
    has_score: v.scored, hard_gates: s.gates, weighted_score: v.raw, normalized_pct: v.pct,
    suggested_band: v.band, score_band: v.band, capacity_fill: false, capacity_fill_reason: null,
    dimension_scores: v.dims, is_new_model: false, is_rm_saving_project: false, is_vip: false,
    currency: 'EUR', capex_keur: null, rm_savings_keur: null, tcogs_eur: null, selling_price_eur: null,
    gross_margin_pct: null,
  };
}
const all = (n: number) => Object.fromEntries(INITIAL_TEST_DIMENSIONS.map((d) => [d.key, n])) as Scores;

let client: QueryClient;
function renderDialog(props: Partial<CompareDialogProps> = {}, session: Parameters<typeof seedSession>[0] = {}) {
  seedSession(session);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const onOpenChange = vi.fn();
  const onForbidden = vi.fn();
  const utils = render(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <CompareDialog open onOpenChange={onOpenChange} onForbidden={onForbidden} {...props} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
  return { ...utils, onOpenChange, onForbidden };
}

const compareCalls = () => mockGet.mock.calls.filter((c) => String(c[0]).startsWith('/priorities/compare')).length;
const radarFor = (id: string) =>
  (JSON.parse(screen.getByTestId('radar-chart').getAttribute('data-radar') ?? '[]') as Record<string, unknown>[]).map(
    (d) => d[id],
  );
const select = (name: string) => screen.getByRole('combobox', { name }) as HTMLSelectElement;
const actionsOf = (id: string) => screen.getByTestId(`compare-actions-${id}`);
const totalRow = () => screen.getByTestId('compare-total-row');
const totalCell = (i: number) => within(totalRow()).getAllByRole('cell')[i] as HTMLElement;

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(server)) delete server[k];
  server.a = { name: 'Alpha', hub: 'R&D-Greece', scores: all(3), gates: [GATE] };
  server.b = { name: 'Beta', hub: 'PD-India', scores: all(2), gates: [] };
  useCompareSelection.setState({
    items: [
      { id: 'a', name: 'Alpha', hub: 'R&D-Greece' },
      { id: 'b', name: 'Beta', hub: 'PD-India' },
    ],
    capHit: false,
  });
  useScenarioStore.setState({ active: false, notes: '', pending: {}, past: [], future: [] });
  mockGet.mockImplementation((path: string) => {
    if (path.startsWith('/priorities/compare')) {
      const ids = new URLSearchParams(path.split('?')[1]).getAll('project_id');
      return Promise.resolve({ projects: ids.map(compareItem) });
    }
    const m = /^\/priorities\/([a-z]+)$/.exec(path);
    if (m?.[1] && server[m[1]]) return Promise.resolve(matrixRow(m[1]));
    return Promise.reject(new ApiError(404, 'not found'));
  });
  mockSend.mockImplementation((_method: string, path: string, body?: unknown) => {
    const id = path.split('/').pop() ?? '';
    // P26: only the sent keys change; null clears.
    const b = body as PriorityScoreUpdateRequest;
    const s = server[id]!;
    s.scores = { ...(s.scores ?? {}), ...b.scores };
    s.gates = b.hard_gates;
    const v = served(id);
    return Promise.resolve({
      id: 'score-' + id, project_id: id, hard_gates: b.hard_gates, weighted_score: v.raw, normalized_pct: v.pct,
      suggested_band: v.band, dimension_scores: v.dims, missing_dimension_keys: v.missing, rubric_version: 1,
    });
  });
});

describe('Compare dialog score editing (P21-T04)', () => {
  it('read-only users see static values and no row reads', async () => {
    renderDialog({ canEdit: false });
    await screen.findByTestId('compare-table');
    expect(screen.queryAllByRole('combobox')).toHaveLength(0);
    expect(screen.queryByTestId('compare-actions-row')).not.toBeInTheDocument();
    expect(mockGet.mock.calls.some((c) => c[0] === '/priorities/a')).toBe(false);
    expect(totalCell(0)).toHaveTextContent('60/100');
  });

  it('editors get a labelled 0–5 menu per cell; an edit marks the cell dirty and shows a labelled preview', async () => {
    const user = userEvent.setup();
    renderDialog({ canEdit: true });
    const strat = await screen.findByRole('combobox', { name: 'Strategic Project score for Alpha' });
    expect(within(strat).getAllByRole('option').map((o) => o.textContent)).toEqual(['– Not scored', '0', '1', '2', '3', '4', '5']);
    expect(screen.getAllByRole('combobox')).toHaveLength(26);
    expect(within(actionsOf('a')).getByRole('button', { name: 'Save changes (0) for Alpha' })).toHaveAttribute('aria-disabled', 'true');

    await user.selectOptions(strat, '5');
    const cell = strat.closest('td') as HTMLElement;
    expect(cell).toHaveAttribute('data-dirty', 'true');
    expect(cell).toHaveTextContent('edited');
    expect(cell).toHaveTextContent('25/25 pts');
    // Served 60/100 stays; the provisional figure is labelled "preview" (177 + 10 = 187 / 295 → 63).
    expect(within(totalCell(0)).getByTestId('compare-served-score')).toHaveTextContent('60/100');
    expect(within(totalCell(0)).getByTestId('compare-preview-score')).toHaveTextContent('preview63/100');
    expect(within(totalCell(1)).queryByTestId('compare-preview-score')).not.toBeInTheDocument();
    // Radar and highest marks stay on served values until saved.
    expect(radarFor('a')[0]).toBe(3);
    await waitFor(() =>
      expect(within(actionsOf('a')).getByRole('button', { name: 'Save changes (1) for Alpha' })).toHaveAttribute('aria-disabled', 'false'),
    );
    // Setting it back to the served value clears the edit.
    await user.selectOptions(strat, '3');
    expect(cell).not.toHaveAttribute('data-dirty');
  });

  it('Save sends the edit dialog body to PUT /priorities/{id} and the refetch updates radar, score and band', async () => {
    const user = userEvent.setup();
    renderDialog({ canEdit: true });
    const invalidate = vi.spyOn(client, 'invalidateQueries');
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Strategic Project score for Alpha' }), '5');
    await user.selectOptions(select('New Customer score for Alpha'), '5');
    await user.selectOptions(select('Regulatory Compliance score for Alpha'), '5');
    const saveBtn = within(actionsOf('a')).getByRole('button', { name: 'Save changes (3) for Alpha' });
    await waitFor(() => expect(saveBtn).toHaveAttribute('aria-disabled', 'false'));
    const before = compareCalls();
    saveBtn.focus();
    await user.click(saveBtn);

    expect(mockSend).toHaveBeenCalledTimes(1);
    // P26: only the edited dimensions are sent, with the project's hard gates.
    expect(mockSend).toHaveBeenCalledWith('PUT', '/priorities/a', {
      scores: { strategic_project: 5, new_customer: 5, regulatory_compliance: 5 },
      hard_gates: [GATE],
    });
    // 177 + 30 = 207 / 295 → 70 → P1, read back from the server.
    await waitFor(() => expect(within(totalCell(0)).getByTestId('compare-served-score')).toHaveTextContent('70/100'));
    expect(totalCell(0)).toHaveTextContent('P1');
    expect(within(totalCell(0)).queryByTestId('compare-preview-score')).not.toBeInTheDocument();
    expect(compareCalls()).toBeGreaterThan(before);
    expect(radarFor('a').slice(0, 2)).toEqual([5, 5]);
    expect(select('Strategic Project score for Alpha').closest('td')).toHaveAttribute('data-highest', 'true');
    expect(select('Strategic Project score for Alpha').closest('td')).not.toHaveAttribute('data-dirty');
    expect(within(actionsOf('a')).getByTestId('compare-save-status')).toHaveTextContent("Saved. The server's score is 70/100, band P1.");
    // The existing mutation re-reads the grid, the distribution and the rows (`priority-matrix` prefix).
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['priority-matrix'] });
    // Focus is not lost on refetch.
    expect(document.activeElement).toBe(within(actionsOf('a')).getByRole('button', { name: 'Save changes (0) for Alpha' }));
  });

  it('allows score 0 and sends it', async () => {
    const user = userEvent.setup();
    renderDialog({ canEdit: true });
    const strat = await screen.findByRole('combobox', { name: 'Strategic Project score for Alpha' });
    await user.selectOptions(strat, '0');
    expect(strat.closest('td')).toHaveTextContent('0/25 pts');
    const saveBtn = within(actionsOf('a')).getByRole('button', { name: 'Save changes (1) for Alpha' });
    await waitFor(() => expect(saveBtn).toHaveAttribute('aria-disabled', 'false'));
    await user.click(saveBtn);
    expect(mockSend).toHaveBeenCalledWith('PUT', '/priorities/a', { scores: { strategic_project: 0 }, hard_gates: [GATE] });
    // 177 − 15 = 162 / 295 → 55.
    await waitFor(() => expect(within(totalCell(0)).getByTestId('compare-served-score')).toHaveTextContent('55/100'));
  });

  it('Discard reverts that project only', async () => {
    const user = userEvent.setup();
    renderDialog({ canEdit: true });
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Strategic Project score for Alpha' }), '5');
    await user.selectOptions(select('Strategic Project score for Beta'), '4');
    await user.click(within(actionsOf('a')).getByRole('button', { name: 'Discard changes for Alpha' }));
    expect(select('Strategic Project score for Alpha').value).toBe('3');
    expect(select('Strategic Project score for Alpha').closest('td')).not.toHaveAttribute('data-dirty');
    expect(select('Strategic Project score for Beta').value).toBe('4');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('closing with unsaved edits asks: keep editing keeps them, discard closes', async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog({ canEdit: true });
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Strategic Project score for Alpha' }), '5');
    await user.keyboard('{Escape}');
    const guard = screen.getByRole('alertdialog', { name: 'Discard unsaved score changes?' });
    await user.click(within(guard).getByRole('button', { name: 'Keep editing' }));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(select('Strategic Project score for Alpha').value).toBe('5');

    await user.click(screen.getByRole('button', { name: 'Close' }));
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Discard changes' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('closes without asking when nothing is edited', async () => {
    const user = userEvent.setup();
    const { onOpenChange } = renderDialog({ canEdit: true });
    await screen.findByRole('combobox', { name: 'Strategic Project score for Alpha' });
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('Scenario mode stages the edit like the edit dialog, sends nothing, and shows the Scenario badge', async () => {
    const user = userEvent.setup();
    useScenarioStore.setState({ active: true });
    renderDialog({ canEdit: true, scenarioActive: true });
    expect(screen.getByTestId('compare-scenario-badge')).toHaveTextContent('Scenario');
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Strategic Project score for Alpha' }), '5');
    const stage = within(actionsOf('a')).getByRole('button', { name: 'Stage changes (1) for Alpha' });
    await waitFor(() => expect(stage).toHaveAttribute('aria-disabled', 'false'));
    await user.click(stage);

    expect(mockSend).not.toHaveBeenCalled();
    const edit = useScenarioStore.getState().pending.a;
    expect(edit?.baseline).toEqual({ scores: all(3), hard_gates: [GATE] });
    expect(edit?.hasScore).toBe(true);
    expect(edit?.next).toEqual({ scores: { ...all(3), strategic_project: 5 }, hard_gates: [GATE] });
    // The cell now starts from the staged value; served figures unchanged, preview labelled for the scenario.
    expect(select('Strategic Project score for Alpha').value).toBe('5');
    expect(select('Strategic Project score for Alpha').closest('td')).not.toHaveAttribute('data-dirty');
    expect(screen.getByText('Staged in scenario')).toBeInTheDocument();
    expect(within(totalCell(0)).getByTestId('compare-served-score')).toHaveTextContent('60/100');
    expect(within(totalCell(0)).getByTestId('compare-preview-score')).toHaveTextContent('scenario preview63/100');
    expect(within(actionsOf('a')).getByTestId('compare-save-status')).toHaveTextContent('Staged in the scenario');
  });

  it('a 422 shows inline for that project and keeps the edits', async () => {
    const user = userEvent.setup();
    mockSend.mockRejectedValueOnce(new ApiError(422, 'invalid', 'strategic_project must be at most 5'));
    renderDialog({ canEdit: true });
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Strategic Project score for Alpha' }), '5');
    const saveBtn = within(actionsOf('a')).getByRole('button', { name: 'Save changes (1) for Alpha' });
    await waitFor(() => expect(saveBtn).toHaveAttribute('aria-disabled', 'false'));
    await user.click(saveBtn);
    expect(await within(actionsOf('a')).findByRole('alert')).toHaveTextContent('The server rejected these scores: strategic_project must be at most 5');
    expect(within(actionsOf('b')).queryByRole('alert')).not.toBeInTheDocument();
    expect(select('Strategic Project score for Alpha').value).toBe('5');
    expect(select('Strategic Project score for Alpha').closest('td')).toHaveAttribute('data-dirty', 'true');
  });

  it('a 403 shows inline, keeps the edits read-only, and downgrades the page on close', async () => {
    const user = userEvent.setup();
    mockSend.mockRejectedValueOnce(new ApiError(403, 'forbidden'));
    const { onForbidden, onOpenChange } = renderDialog({ canEdit: true });
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Strategic Project score for Alpha' }), '5');
    const saveBtn = within(actionsOf('a')).getByRole('button', { name: 'Save changes (1) for Alpha' });
    await waitFor(() => expect(saveBtn).toHaveAttribute('aria-disabled', 'false'));
    await user.click(saveBtn);
    expect(await within(actionsOf('a')).findByRole('alert')).toHaveTextContent('Your role cannot edit prioritization scores');
    expect(select('Strategic Project score for Alpha').value).toBe('5');
    expect(select('Strategic Project score for Alpha')).toBeDisabled();
    expect(within(actionsOf('a')).getByRole('button', { name: 'Save changes (1) for Alpha' })).toHaveAttribute('aria-disabled', 'true');
    expect(onForbidden).not.toHaveBeenCalled();
    await user.keyboard('{Escape}');
    await user.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: 'Discard changes' }));
    expect(onForbidden).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('P26: an unscored project can be scored partly — only that dimension is sent, the rest count 0 (incomplete)', async () => {
    const user = userEvent.setup();
    server.b!.scores = null;
    renderDialog({ canEdit: true });
    const strat = (await screen.findByRole('combobox', { name: 'Strategic Project score for Beta' })) as HTMLSelectElement;
    expect(strat.value).toBe('');
    await user.selectOptions(strat, '4');
    // Preview: 20 / 295 → 7 (every other dimension counts 0).
    expect(within(totalCell(1)).getByTestId('compare-preview-score')).toHaveTextContent('preview7/100');
    const saveBtn = within(actionsOf('b')).getByRole('button', { name: 'Save changes (1) for Beta' });
    await waitFor(() => expect(saveBtn).toHaveAttribute('aria-disabled', 'false'));
    await user.click(saveBtn);
    expect(mockSend).toHaveBeenCalledWith('PUT', '/priorities/b', { scores: { strategic_project: 4 }, hard_gates: [] });
    await waitFor(() => expect(within(totalCell(1)).getByTestId('compare-served-score')).toHaveTextContent('7/100'));
    // The served score is incomplete: 12 dimensions are still unscored.
    expect(within(totalCell(1)).getByTestId('incomplete-marker')).toHaveAccessibleName(/^Incomplete: 12 dimensions not scored/);
  });

  it('P26: "– Not scored" clears a score by sending null', async () => {
    const user = userEvent.setup();
    renderDialog({ canEdit: true });
    await user.selectOptions(await screen.findByRole('combobox', { name: 'CAPEX Investment (inverted) score for Alpha' }), '');
    const saveBtn = within(actionsOf('a')).getByRole('button', { name: 'Save changes (1) for Alpha' });
    await waitFor(() => expect(saveBtn).toHaveAttribute('aria-disabled', 'false'));
    await user.click(saveBtn);
    expect(mockSend).toHaveBeenCalledWith('PUT', '/priorities/a', { scores: { capex_investment: null }, hard_gates: [GATE] });
    await waitFor(() =>
      expect(within(totalCell(0)).getByTestId('incomplete-marker')).toHaveAccessibleName(
        'Incomplete: 1 dimension not scored (CAPEX Investment (inverted)); each counts 0 points',
      ),
    );
  });

  it('P25: shows the served promoted band with the capacity-fill chip and the score band', async () => {
    server.a!.fill = 'P1 (capacity fill): hub P1 design load 9.00 of 10.00 weeks with this project';
    renderDialog({ canEdit: false });
    await screen.findByTestId('compare-table');
    const chip = within(totalCell(0)).getByTestId('band-chip-capacity-fill');
    expect(chip).toHaveTextContent('P1 · capacity fill');
    expect(chip).toHaveTextContent('score band P2');
    expect(within(totalCell(1)).queryByTestId('band-chip-capacity-fill')).not.toBeInTheDocument();
  });

  it('has no serious or critical axe violations while editing', async () => {
    const user = userEvent.setup();
    renderDialog({ canEdit: true });
    await user.selectOptions(await screen.findByRole('combobox', { name: 'Strategic Project score for Alpha' }), '5');
    expect(await seriousAxeViolations(screen.getByRole('dialog'))).toEqual([]);
  });
});

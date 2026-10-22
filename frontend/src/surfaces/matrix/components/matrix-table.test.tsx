import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 44,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ key: index, index, start: index * 44, size: 44 })),
    measureElement: () => undefined,
  }),
}));

import { renderWithProviders } from '@/test/render';

import type { PriorityMatrixRow } from '../api/types';
import { MatrixTable } from './matrix-table';
import { FOURTEEN_TEST_DIMENSIONS, P13_MATRIX_ROW_DEFAULTS, testDimensionScores, testDimensionTable } from '../test-fixtures';
import { ScoringModelProvider } from '../scoring-model';

const SCORES = {
  strategic_project: 5, new_customer: 4, new_options: 3, regulatory_compliance: 2,
  quality_improvements: 3, rm_savings: 4, total_rm_savings: 3, gross_margins: 3,
  profitability: 4, annual_volume: 3, three_year_volume: 3, new_models: 2, capex_investment: 4,
};

function row(overrides: Partial<PriorityMatrixRow> = {}): PriorityMatrixRow {
  return {
    project_id: 'p1',
    project_name: 'Cooler A',
    hub: 'R&D-Greece',
    category: 'A+',
    type: 'NM',
    set_priority: 'P2',
    has_score: true,
    hard_gates: [],
    weighted_score: 980,
    normalized_pct: 70,
    suggested_band: 'P1',
    is_new_model: true,
    is_rm_saving_project: true,
    currency: 'USD',
    capex_keur: 129.6,
    rm_savings_keur: 43.2,
    tcogs_eur: 5400,
    selling_price_eur: 8640,
    gross_margin_pct: 37.5,
    ...P13_MATRIX_ROW_DEFAULTS,
    dimension_scores: testDimensionScores(SCORES),
    ...overrides,
  };
}

describe('MatrixTable', () => {
  it('P21: no financial columns; the 13 rubric columns under pillar bands and a final Score /100', () => {
    renderWithProviders(<MatrixTable rows={[row()]} canEdit={false} onEdit={vi.fn()} />);
    for (const gone of [/^CAPEX \(k/, /^RM sav\. \(k/, /^TCOGS/, /^Selling price/, /^Gross margin %/]) {
      expect(screen.queryByRole("columnheader", { name: gone }), String(gone)).not.toBeInTheDocument();
    }
    expect(screen.queryByText('129.6')).not.toBeInTheDocument();
    // 13 rubric cells for the row, one per served dimension.
    expect(screen.getAllByTestId(/^dim-(?!head)/)).toHaveLength(13);
    for (const pillar of [
      'Strategic Alignment',
      'Regulatory & Quality',
      'Financial Return',
      'Market & Volume',
      'Investment & Feasibility',
    ]) {
      expect(screen.getByRole('columnheader', { name: pillar })).toBeInTheDocument();
    }
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent);
    expect(headers.at(-1)).toBe('Score /100');
    expect(screen.getByTestId('score-out-of-100')).toHaveTextContent('70/100');
  });

  it('P21: a dimension cell shows the served score 0–5 and its served points to screen readers and on hover', () => {
    renderWithProviders(
      <MatrixTable
        rows={[
          row({
            dimension_scores: [
              { key: 'strategic_project', label: 'Strategic Project', pillar: 'Strategic Alignment', score: 0, weight: 25, points: 0, max_points: 25 },
              { key: 'new_customer', label: 'New Customer', pillar: 'Strategic Alignment', score: 4, weight: 25, points: 20, max_points: 25 },
            ],
          }),
        ]}
        canEdit={false}
        onEdit={vi.fn()}
      />,
    );
    const strat = screen.getByTestId('dim-strategic_project');
    expect(strat).toHaveAttribute('title', 'Strategic Project: 0 of 5, 0/25 pts');
    expect(screen.getByTestId('dim-new_customer')).toHaveTextContent('New Customer: 4 of 5, 20/25 pts');
  });

  it('P27: a tagged dimension\'s chip carries the "from registration" mark and words; others do not', () => {
    renderWithProviders(
      <MatrixTable
        rows={[row({ scoring_tags: ['new_options'], tag_dimension_keys: ['new_options', 'inactive_dimension'] })]}
        canEdit
        onEdit={vi.fn()}
      />,
    );
    const tagged = screen.getByTestId('dim-new_options');
    expect(tagged).toHaveAttribute('title', expect.stringContaining('(from registration; still editable)'));
    expect(tagged).toHaveTextContent('New Options: 3 of 5');
    expect(tagged).toHaveTextContent('from registration');
    expect(screen.getAllByTestId('from-registration-mark')).toHaveLength(1);
    expect(within(tagged).getByTestId('score-chip')).toHaveAttribute('data-from-registration', 'true');
    expect(screen.getByTestId('dim-new_customer')).not.toHaveTextContent('from registration');
    // Still edited through the ordinary score dialog.
    expect(screen.getByRole('button', { name: 'Edit prioritization score for Cooler A' })).toBeEnabled();
  });

  it('P21: Compare checkboxes are keyboard-reachable and call the toggle', async () => {
    const onToggle = vi.fn();
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    renderWithProviders(
      <MatrixTable rows={[row()]} canEdit={false} onEdit={vi.fn()} selectedIds={new Set()} onToggleSelect={onToggle} />,
    );
    const box = screen.getByRole('checkbox', { name: 'Select Cooler A to compare' });
    box.focus();
    await user.keyboard(' ');
    expect(onToggle).toHaveBeenCalledWith(expect.objectContaining({ project_id: 'p1' }));
  });

  it('P21-T03: each pillar is one box — start/end markers, 2px pillar lines, 3px block lines, alternating tint', () => {
    const { container } = renderWithProviders(
      <MatrixTable rows={[row()]} canEdit={false} onEdit={vi.fn()} selectedIds={new Set()} onToggleSelect={vi.fn()} />,
    );
    const bodyRow = container.querySelector('.mg-row');
    expect(bodyRow).not.toBeNull();
    const starts = [...(bodyRow as Element).querySelectorAll('[data-pillar-start]')].map((c) =>
      c.getAttribute('data-pillar-start'),
    );
    // P26: pillars in order of first appearance in the served display order
    // (ROI, position 9, opens Investment & Feasibility before Market & Volume).
    expect(starts).toEqual([
      'pillar-Strategic Alignment',
      'pillar-Regulatory & Quality',
      'pillar-Financial Return',
      'pillar-Investment & Feasibility',
      'pillar-Market & Volume',
    ]);
    expect((bodyRow as Element).querySelectorAll('[data-pillar-end]')).toHaveLength(5);
    // First pillar follows the info block (block line); later pillars get a pillar line.
    const startCells = [...(bodyRow as Element).querySelectorAll('[data-pillar-start]')];
    expect(startCells.map((c) => c.getAttribute('data-line'))).toEqual(['block', 'pillar', 'pillar', 'pillar', 'pillar']);
    // Every second pillar is tinted, header band included.
    expect(startCells.map((c) => c.getAttribute('data-tint'))).toEqual([null, 'true', null, 'true', null]);
    const band = screen.getByRole('columnheader', { name: 'Regulatory & Quality' });
    expect(band).toHaveAttribute('data-pillar-start', 'pillar-Regulatory & Quality');
    expect(band).toHaveAttribute('data-pillar-end', 'pillar-Regulatory & Quality');
    expect(band).toHaveAttribute('data-tint', 'true');
    // Inside a pillar, cells get the lighter inner line.
    const inner = (bodyRow as Element).querySelectorAll('[data-box-kind="pillar"][data-line="inner"]');
    expect(inner).toHaveLength(13 - 5);
    // Identity → info and scores → Score /100 are block separators.
    const lines = [...(bodyRow as Element).querySelectorAll('[role="cell"]')].map((c) => [
      c.getAttribute('data-box-kind'),
      c.getAttribute('data-line'),
    ]);
    expect(lines.filter(([, l]) => l === 'block').map(([k]) => k)).toEqual(['info', 'pillar', 'score']);
    // The last frozen column (Hub) carries the frozen-edge shadow hook.
    expect((bodyRow as Element).querySelectorAll('.mg-frozen-edge')).toHaveLength(1);
    expect((bodyRow as Element).querySelectorAll('.mg-cell-sticky')).toHaveLength(3);
  });

  it('P21-T03: a score chip shows the served number with an intensity that follows it (0 muted, 5 strongest)', () => {
    const dims = [
      ['strategic_project', 0],
      ['new_customer', 1],
      ['new_options', 2],
      ['regulatory_compliance', 3],
      ['quality_improvements', 4],
      ['rm_savings', 5],
    ] as const;
    renderWithProviders(
      <MatrixTable
        rows={[
          row({
            dimension_scores: dims.map(([key, score]) => ({
              key,
              label: key,
              pillar: 'Strategic Alignment',
              score,
              weight: 25,
              points: score * 5,
              max_points: 25,
            })),
          }),
        ]}
        canEdit={false}
        onEdit={vi.fn()}
      />,
    );
    for (const [key, score] of dims) {
      const chip = screen.getByTestId(`dim-${key}`).querySelector('[data-testid="score-chip"]');
      expect(chip, key).toHaveTextContent(String(score));
      expect(chip, key).toHaveAttribute('data-intensity', String(score));
      expect(chip, key).toHaveClass('mg-chip');
    }
    // The number and the screen-reader summary (served label) stay; colour is never alone.
    expect(screen.getByTestId('dim-strategic_project')).toHaveTextContent('strategic_project: 0 of 5, 0/25 pts');
  });

  it('P21-T03: rows are zebra-striped and a checked row is marked selected across the frozen block', () => {
    const { container } = renderWithProviders(
      <MatrixTable
        rows={[row(), row({ project_id: 'p2', project_name: 'Cooler B', normalized_pct: 60 })]}
        canEdit={false}
        onEdit={vi.fn()}
        selectedIds={new Set(['p2'])}
        onToggleSelect={vi.fn()}
      />,
    );
    const rows = [...container.querySelectorAll('.mg-row')];
    expect(rows.map((r) => r.getAttribute('data-zebra'))).toEqual(['even', 'odd']);
    const selected = rows.find((r) => r.getAttribute('data-selected') === 'true');
    expect(selected).toBeDefined();
    expect(selected).toHaveTextContent('Cooler B');
    expect(rows.filter((r) => r.getAttribute('data-selected') === 'true')).toHaveLength(1);
    expect(screen.getByRole('checkbox', { name: 'Select Cooler B to compare' })).toBeChecked();
  });

  it('shows no edit affordance for a read-only role (canEdit=false)', () => {
    renderWithProviders(
      <MatrixTable rows={[row()]} canEdit={false} onEdit={vi.fn()} />,
    );
    expect(screen.queryByRole('button', { name: /Edit prioritization score/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Edit' })).not.toBeInTheDocument();
  });

  it('exposes a per-row edit button when canEdit=true', async () => {
    const onEdit = vi.fn();
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    renderWithProviders(
      <MatrixTable rows={[row()]} canEdit onEdit={onEdit} />,
    );
    await user.click(screen.getByRole('button', { name: 'Edit prioritization score for Cooler A' }));
    expect(onEdit).toHaveBeenCalledWith(expect.objectContaining({ project_id: 'p1' }));
  });

  it('renders an unscored row without inventing a score', () => {
    renderWithProviders(
      <MatrixTable
        rows={[
          row({
            project_id: 'p2',
            project_name: 'Cooler B',
            has_score: false,
            dimension_scores: testDimensionScores({}),
            normalized_pct: null,
            weighted_score: null,
            suggested_band: null,
            hard_gates: [],
          }),
        ]}
       
        canEdit={false}
        onEdit={vi.fn()}
      />,
    );
    expect(screen.getByText('Cooler B')).toBeInTheDocument();
    expect(screen.getByTestId('score-cell-unscored')).toBeInTheDocument();
    // An unscored project shows plain dashes, not "incomplete" chips.
    expect(screen.queryAllByTestId('score-chip-empty')).toHaveLength(0);
    expect(screen.queryByTestId('incomplete-marker')).not.toBeInTheDocument();
  });

  it('P26: columns follow the served table — 14 dimensions with a new pillar, in display order', () => {
    const scores = { ...SCORES, sustainability_esg: 4 };
    const { container } = renderWithProviders(
      <ScoringModelProvider table={testDimensionTable(FOURTEEN_TEST_DIMENSIONS, 2)}>
        <MatrixTable
          rows={[row({ dimension_scores: testDimensionScores(scores, FOURTEEN_TEST_DIMENSIONS), rubric_version: 2 })]}
          canEdit={false}
          onEdit={vi.fn()}
        />
      </ScoringModelProvider>,
    );
    expect(screen.getAllByTestId(/^dim-(?!head)/)).toHaveLength(14);
    expect(screen.getByRole('columnheader', { name: 'Sustainability' })).toBeInTheDocument();
    const bodyRow = container.querySelector('.mg-row') as Element;
    const starts = [...bodyRow.querySelectorAll('[data-pillar-start]')].map((c) => c.getAttribute('data-pillar-start'));
    expect(starts).toHaveLength(6);
    expect(starts.at(-1)).toBe('pillar-Sustainability');
    // The new pillar alternates the tint like any other (6th pillar → tinted).
    const startCells = [...bodyRow.querySelectorAll('[data-pillar-start]')];
    expect(startCells.map((c) => c.getAttribute('data-tint'))).toEqual([null, 'true', null, 'true', null, 'true']);
    expect(bodyRow.querySelectorAll('[data-box-kind="pillar"][data-line="inner"]')).toHaveLength(14 - 6);
    // The new dimension's header is its served label; its weight comes from the served table.
    expect(screen.getByRole('button', { name: /^Sustainability & ESG \(Sustainability, weight 30 \(9\.2 of 100\)\)$/ })).toBeInTheDocument();
    expect(screen.getByTestId('dim-sustainability_esg')).toHaveTextContent('Sustainability & ESG: 4 of 5, 24/30 pts');
    // Column order: dimension columns appear in display order inside each pillar.
    const headKeys = [...container.querySelectorAll('[data-testid^="dim-head-"]')].map((h) => h.getAttribute('data-testid'));
    expect(headKeys.slice(0, 3)).toEqual(['dim-head-strategic_project', 'dim-head-new_customer', 'dim-head-new_options']);
    expect(headKeys.at(-1)).toBe('dim-head-sustainability_esg');
  });

  it('P26: an incomplete score shows empty "–" chips and a marker listing the unscored dimensions', async () => {
    const { default: userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    const scores = { ...SCORES, sustainability_esg: null, capex_investment: null };
    renderWithProviders(
      <ScoringModelProvider table={testDimensionTable(FOURTEEN_TEST_DIMENSIONS, 2)}>
        <MatrixTable
          rows={[
            row({
              dimension_scores: testDimensionScores(scores, FOURTEEN_TEST_DIMENSIONS),
              missing_dimension_keys: ['capex_investment', 'sustainability_esg'],
            }),
          ]}
          canEdit={false}
          onEdit={vi.fn()}
        />
      </ScoringModelProvider>,
    );
    const empties = screen.getAllByTestId('score-chip-empty');
    expect(empties).toHaveLength(2);
    expect(empties[0]).toHaveTextContent('–');
    expect(screen.getByTestId('dim-sustainability_esg')).toHaveTextContent('Sustainability & ESG: not scored (0 points; incomplete)');
    const marker = screen.getByTestId('incomplete-marker');
    expect(marker).toHaveAccessibleName(
      'Incomplete: 2 dimensions not scored (CAPEX Investment (inverted), Sustainability & ESG); each counts 0 points',
    );
    expect(screen.getByRole('button', { name: 'Score 70/100, band P1, incomplete' })).toBeInTheDocument();
    await user.hover(marker);
    const tip = await screen.findByRole('tooltip');
    expect(tip).toHaveTextContent('CAPEX Investment (inverted)');
    expect(tip).toHaveTextContent('Sustainability & ESG');
  });

  it('P9: links each project to its workspace and exposes the scoring anchors on the dimension headers', () => {
    renderWithProviders(<MatrixTable rows={[row()]} canEdit={false} onEdit={vi.fn()} />);
    expect(screen.getByRole('link', { name: 'Cooler A' })).toHaveAttribute('href', '/projects/p1');
    expect(
      screen.getByRole('button', {
        name: 'CAPEX Investment (inverted): 1 = > €500K, 5 = < €10K (Investment & Feasibility, weight 15)',
      }),
    ).toBeInTheDocument();
  }, 20_000); // synchronous, but the first full-table render is slow when CPU is saturated (QA-P15-3)

  it('P16: shows served points/weight in the dimension cells in Detailed view (no client maths)', () => {
    renderWithProviders(
      <MatrixTable
        rows={[row({ dimension_points: { gross_margins: { points: 15, scaled_points: 5.08 } } })]}
        canEdit={false}
        onEdit={vi.fn()}
        detailed
      />,
    );
    const gp = screen.getByTitle('Gross Profitability: 3 of 5, 15/25 pts (5.08 of 100)');
    expect(gp).toHaveTextContent('15/25 pts');
  });

  it('sorts projects in order of the score: rank 1 first, descending score, unscored at bottom', () => {
    const rowHigh = row({
      project_id: 'p-high',
      project_name: 'Project Alpha',
      weighted_score: 950,
      rank: 2,
      has_score: true,
    });
    const rowTop = row({
      project_id: 'p-top',
      project_name: 'Project Zebra',
      weighted_score: 1100,
      rank: 1,
      has_score: true,
    });
    const rowLow = row({
      project_id: 'p-low',
      project_name: 'Project Beta',
      weighted_score: 400,
      rank: 3,
      has_score: true,
    });
    const rowUnscored = row({
      project_id: 'p-none',
      project_name: 'Project Gamma',
      weighted_score: null,
      rank: null,
      has_score: false,
    });

    // Pass in arbitrary/shuffled order: low, unscored, high, top
    renderWithProviders(
      <MatrixTable
        rows={[rowLow, rowUnscored, rowHigh, rowTop]}
       
        canEdit={false}
        onEdit={vi.fn()}
      />,
    );

    const projectLinks = screen.getAllByRole('link', { name: /Project / });
    expect(projectLinks.map((l) => l.textContent)).toEqual([
      'Project Zebra', // Rank 1, score 1100
      'Project Alpha', // Rank 2, score 950
      'Project Beta',  // Rank 3, score 400
      'Project Gamma', // Unscored (rank null)
    ]);
  });
});

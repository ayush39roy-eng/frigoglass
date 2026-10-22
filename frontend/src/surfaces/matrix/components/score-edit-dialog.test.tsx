import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';

import { seriousAxeViolations } from '@/test/axe';

import type { PriorityMatrixRow } from '../api/types';
import { ScoreEditDialog } from './score-edit-dialog';
import { FOURTEEN_TEST_DIMENSIONS, P13_MATRIX_ROW_DEFAULTS, testDimensionScores, uniformScores } from '../test-fixtures';

function row(overrides: Partial<PriorityMatrixRow> = {}): PriorityMatrixRow {
  return {
    project_id: 'p1',
    project_name: 'Cooler A',
    hub: 'R&D-Greece',
    category: 'A+',
    type: 'NM',
    set_priority: null,
    has_score: false,
    hard_gates: [],
    weighted_score: null,
    normalized_pct: null,
    suggested_band: null,
    is_new_model: true,
    is_rm_saving_project: false,
    currency: 'EUR',
    capex_keur: null,
    rm_savings_keur: null,
    tcogs_eur: null,
    selling_price_eur: null,
    gross_margin_pct: null,
    ...P13_MATRIX_ROW_DEFAULTS,
    dimension_scores: testDimensionScores({}),
    ...overrides,
  };
}

describe('ScoreEditDialog', () => {
  it('P26: one 0–5 menu per served active dimension, grouped by pillar (14 dimensions, a new pillar)', async () => {
    const scores = { ...uniformScores(3, FOURTEEN_TEST_DIMENSIONS), sustainability_esg: null };
    const { container } = renderWithProviders(
      <ScoreEditDialog
        row={row({
          has_score: true,
          dimension_scores: testDimensionScores(scores, FOURTEEN_TEST_DIMENSIONS),
          missing_dimension_keys: ['sustainability_esg'],
        })}
        open
        onOpenChange={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    expect(screen.getAllByTestId('score-edit-select')).toHaveLength(14);
    expect(screen.getAllByTestId('score-edit-pillar').map((f) => f.querySelector('legend')?.textContent)).toEqual([
      'Strategic Alignment',
      'Regulatory & Quality',
      'Financial Return',
      'Investment & Feasibility',
      'Market & Volume',
      'Sustainability',
    ]);
    const esg = screen.getByLabelText('Sustainability & ESG') as HTMLSelectElement;
    expect(esg.value).toBe('');
    expect(within(esg).getAllByRole('option').map((o) => o.textContent)).toEqual(['– Not scored', '0', '1', '2', '3', '4', '5']);
    expect(screen.getByRole('dialog')).toHaveTextContent('Cooler A — 14 dimensions, each 0–5');
    expect(screen.getByTestId('score-edit-incomplete')).toHaveTextContent('1 of 14 not scored');
    expect(await seriousAxeViolations(container)).toEqual([]);
  });

  it('P26: sends only the dimensions changed in the dialog (scores map) + the chosen hard gates', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onOpenChange = vi.fn();
    renderWithProviders(
      <ScoreEditDialog
        row={row({ has_score: true, dimension_scores: testDimensionScores(uniformScores(3)) })}
        open
        onOpenChange={onOpenChange}
        onSubmit={onSubmit}
      />,
    );

    await user.selectOptions(screen.getByLabelText('Strategic Project'), '5');
    await user.selectOptions(screen.getByLabelText('New Customer'), '0');
    await user.selectOptions(screen.getByLabelText('CAPEX Investment (inverted)'), '');
    const gates = screen.getByRole('group', { name: /Hard gates/ });
    await user.click(within(gates).getByLabelText('Active safety non-compliance'));
    await user.click(screen.getByRole('button', { name: 'Save score' }));

    expect(onSubmit).toHaveBeenCalledTimes(1);
    const [projectId, body] = onSubmit.mock.calls[0] as [string, Record<string, unknown>];
    expect(projectId).toBe('p1');
    expect(body).toEqual({
      scores: { strategic_project: 5, new_customer: 0, capex_investment: null },
      hard_gates: ['Active safety non-compliance'],
    });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('P26: an unscored project starts empty (no invented 3s); scoring one dimension sends just that one', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderWithProviders(<ScoreEditDialog row={row()} open onOpenChange={vi.fn()} onSubmit={onSubmit} />);
    expect((screen.getByLabelText('Strategic Project') as HTMLSelectElement).value).toBe('');
    await user.selectOptions(screen.getByLabelText('Strategic Project'), '4');
    await user.click(screen.getByRole('button', { name: 'Save score' }));
    expect(onSubmit.mock.calls[0]?.[1]).toEqual({ scores: { strategic_project: 4 }, hard_gates: [] });
  });

  it('P27: dimensions in tag_dimension_keys carry a "from registration" hint and stay editable; an inactive key is ignored', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const { container } = renderWithProviders(
      <ScoreEditDialog
        row={row({
          has_score: true,
          dimension_scores: testDimensionScores({ ...uniformScores(3), new_options: 5, new_models: 5 }),
          scoring_tags: ['new_options', 'new_models', 'improvement'],
          // An inactive dimension's key may be listed while absent from dimension_scores: ignored.
          tag_dimension_keys: ['new_options', 'new_models', 'not_served_dimension'],
        })}
        open
        onOpenChange={vi.fn()}
        onSubmit={onSubmit}
      />,
    );
    const hints = screen.getAllByTestId('from-registration-hint');
    expect(hints).toHaveLength(2);
    expect(hints.map((h) => h.getAttribute('aria-label'))).toEqual([
      expect.stringMatching(/^New Options: from registration/),
      expect.stringMatching(/^New Models: from registration/),
    ]);
    const options = screen.getByLabelText('New Options') as HTMLSelectElement;
    expect(options).toBeEnabled();
    expect(options.value).toBe('5');
    await user.selectOptions(options, '2');
    await user.click(screen.getByRole('button', { name: 'Save score' }));
    expect(onSubmit.mock.calls[0]?.[1]).toEqual({ scores: { new_options: 2 }, hard_gates: [] });
    expect(await seriousAxeViolations(container)).toEqual([]);
  });

  it('closes without a request when nothing changed', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    const onOpenChange = vi.fn();
    renderWithProviders(<ScoreEditDialog row={row()} open onOpenChange={onOpenChange} onSubmit={onSubmit} />);
    await user.click(screen.getByRole('button', { name: 'Save score' }));
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('P21: shows the 0–5 help text; a 422 UNKNOWN_DIMENSION_KEY explains the rubric changed', async () => {
    const user = userEvent.setup();
    const { ApiError } = await import('@/lib/api/client');
    const onSubmit = vi.fn().mockRejectedValue(new ApiError(422, 'x', 'Not an active scoring dimension: strategic_project.', 'UNKNOWN_DIMENSION_KEY'));
    renderWithProviders(<ScoreEditDialog row={row()} open onOpenChange={vi.fn()} onSubmit={onSubmit} />);
    expect(screen.getByTestId('score-range-help')).toHaveTextContent(
      '0 gives no points; 1 gives 1/5 of the weight; 5 the full weight',
    );
    await user.selectOptions(screen.getByLabelText('Strategic Project'), '0');
    await user.click(screen.getByRole('button', { name: 'Save score' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('The scoring rubric changed while you were editing');
  });

  it('P21: shows the served financial figures read-only (converted server-side, never in the grid)', () => {
    renderWithProviders(
      <ScoreEditDialog
        row={row({ currency: 'USD', capex_keur: 129.6, tcogs_eur: 5400, gross_margin_pct: 37.5 })}
        open
        onOpenChange={vi.fn()}
        onSubmit={vi.fn()}
      />,
    );
    const fin = screen.getByTestId('score-edit-financials');
    expect(fin).toHaveTextContent('CAPEX (k USD)');
    expect(fin).toHaveTextContent('129.6');
    expect(fin).toHaveTextContent('5,400');
    expect(fin).toHaveTextContent('37.5%');
  });
});

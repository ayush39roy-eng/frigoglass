/** P25-T04: the Workspace score section shows the served suggested band with the same chip as the
 *  Matrix ("P1 · capacity fill" + score band), and the served reason. */
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';

vi.mock('@/lib/api/client', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/client')>('@/lib/api/client');
  return { ...actual, apiGet: vi.fn(() => Promise.reject(new Error('no network in this test'))), apiSend: vi.fn() };
});

import { renderWithProviders } from '@/test/render';
import { seriousAxeViolations } from '@/test/axe';

import type { WorkspacePriorityScore } from '../api/types';
import { FOURTEEN_TEST_DIMENSIONS, testDimensionScores, uniformScores } from '@/surfaces/matrix/test-fixtures';
import { apiSend } from '@/lib/api/client';
import { ScoringSection } from './scoring-section';

const REASON = 'P1 (capacity fill): hub P1 design load 9.00 of 10.00 weeks with this project';

function score(overrides: Partial<WorkspacePriorityScore> = {}): WorkspacePriorityScore {
  return {
    dimension_scores: testDimensionScores(uniformScores(3)), missing_dimension_keys: [], rubric_version: 1, hard_gates: [],
    weighted_score: 177, normalized_pct: 60, suggested_band: 'P2', score_band: 'P2',
    capacity_fill: false, capacity_fill_reason: null,
    ...overrides,
  };
}

describe('Workspace scoring section — P25 capacity fill', () => {
  it('a promoted project shows "P1 · capacity fill", its score band and the served reason', async () => {
    const user = userEvent.setup();
    const { container } = renderWithProviders(
      <ScoringSection projectId="p1" canWrite={false} score={score({ suggested_band: 'P1', capacity_fill: true, capacity_fill_reason: REASON })} />,
    );
    const band = screen.getByTestId('score-suggested-band');
    expect(within(band).getByTestId('band-chip-capacity-fill')).toHaveTextContent('P1 · capacity fill');
    expect(within(band).getByTestId('band-chip-score-band')).toHaveTextContent('score band P2');
    expect(screen.getByTestId('score-fill-reason')).toHaveTextContent(REASON);
    await user.hover(within(band).getByRole('button', { name: 'Suggested band P1 by capacity fill, score band P2' }));
    expect(await screen.findByRole('tooltip')).toHaveTextContent(REASON);
    expect(await seriousAxeViolations(container)).toEqual([]);
  });

  it('a project with no fill shows its plain band and no reason line', () => {
    renderWithProviders(<ScoringSection projectId="p1" canWrite={false} score={score()} />);
    const band = screen.getByTestId('score-suggested-band');
    expect(within(band).queryByTestId('band-chip-capacity-fill')).not.toBeInTheDocument();
    expect(within(band).getByTitle(/Priority band P2/)).toBeInTheDocument();
    expect(screen.queryByTestId('score-fill-reason')).not.toBeInTheDocument();
  });

  it('a candidate that was not promoted shows its served reason', () => {
    const stopped = 'Not promoted: hub P1 design load would be 11.00 of 10.00 weeks';
    renderWithProviders(<ScoringSection projectId="p1" canWrite={false} score={score({ capacity_fill_reason: stopped })} />);
    expect(screen.getByTestId('score-fill-reason')).toHaveTextContent(stopped);
    expect(screen.queryByTestId('band-chip-capacity-fill')).not.toBeInTheDocument();
  });

  it('P26: rows are the served dimensions (14, a new pillar); a missing one reads "–" and the section is marked incomplete', () => {
    const scores = { ...uniformScores(3, FOURTEEN_TEST_DIMENSIONS), sustainability_esg: null };
    renderWithProviders(
      <ScoringSection
        projectId="p1"
        canWrite={false}
        score={score({
          dimension_scores: testDimensionScores(scores, FOURTEEN_TEST_DIMENSIONS),
          missing_dimension_keys: ['sustainability_esg'],
        })}
      />,
    );
    const table = screen.getByRole('table', { name: 'Scoring dimensions' });
    expect(within(table).getAllByRole('row')).toHaveLength(15); // header + 14
    const esg = within(table).getByRole('rowheader', { name: 'Sustainability & ESG' }).closest('tr') as HTMLElement;
    expect(esg).toHaveTextContent('Not scored');
    expect(esg).toHaveTextContent('—'); // no deck anchor for an added dimension
    expect(screen.getByTestId('score-incomplete')).toHaveTextContent('1 of 14 dimensions not scored');
  });

  it('P26: a save sends only the changed dimensions as a scores map (null clears)', async () => {
    const user = userEvent.setup();
    const send = vi.mocked(apiSend).mockResolvedValue({});
    renderWithProviders(<ScoringSection projectId="p1" canWrite score={score()} />);
    await user.click(screen.getByRole('button', { name: 'Edit scores' }));
    await user.selectOptions(screen.getByLabelText('Strategic Project'), '5');
    await user.selectOptions(screen.getByLabelText('New Options'), '');
    await user.click(screen.getByRole('button', { name: 'Save scores' }));
    expect(send).toHaveBeenCalledWith('PUT', '/priorities/p1', {
      scores: { strategic_project: 5, new_options: null },
      hard_gates: [],
    });
  });

  it('P27: tagged dimensions show "from registration" and stay editable', async () => {
    const user = userEvent.setup();
    const send = vi.mocked(apiSend).mockResolvedValue({});
    const { container } = renderWithProviders(
      <ScoringSection
        projectId="p1"
        canWrite
        score={score({ dimension_scores: testDimensionScores({ ...uniformScores(3), new_customer: 5 }) })}
        tagDimensionKeys={['new_customer']}
      />,
    );
    const table = screen.getByRole('table', { name: 'Scoring dimensions' });
    const tagged = within(table).getByRole('rowheader', { name: /New Customer/ });
    expect(within(tagged).getByTestId('from-registration-hint')).toHaveTextContent('from registration');
    expect(within(table).getAllByTestId('from-registration-hint')).toHaveLength(1);
    expect(await seriousAxeViolations(container)).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Edit scores' }));
    await user.selectOptions(screen.getByLabelText('New Customer'), '1');
    await user.click(screen.getByRole('button', { name: 'Save scores' }));
    expect(send).toHaveBeenCalledWith('PUT', '/priorities/p1', { scores: { new_customer: 1 }, hard_gates: [] });
  });
});

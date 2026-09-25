import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';

import { ApplyLogicCard } from './apply-logic-panel';

const RESULT = {
  schedule_run: {
    id: 'r1',
    version: 3,
    solver_type: 'greedy' as const,
    status: 'completed' as const,
    is_active: true,
    horizon_weeks: 78,
    current_week: 31,
    trigger_reason: 'manual_recalc',
    created_at: '2026-01-01T00:00:00Z',
  },
  project_count: 46,
  left_out_count: 8,
  within_year_count: 9,
  spillover_count: 10,
};

describe('ApplyLogicCard', () => {
  it('requires confirmation before calling onApply', async () => {
    const user = userEvent.setup();
    const onApply = vi.fn().mockResolvedValue(undefined);
    renderWithProviders(
      <ApplyLogicCard
        canEdit
        provenance={null}
        onApply={onApply}
        isApplying={false}
        lastResult={null}
        errorMessage={null}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Apply Logic' }));
    expect(onApply).not.toHaveBeenCalled();
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Apply Logic' }));
    expect(onApply).toHaveBeenCalledTimes(1);
  });

  it('shows the active schedule provenance when available', () => {
    renderWithProviders(
      <ApplyLogicCard
        canEdit
        provenance={{ version: 3, solverType: 'greedy' }}
        onApply={() => Promise.resolve()}
        isApplying={false}
        lastResult={null}
        errorMessage={null}
      />,
    );
    expect(screen.getByText(/version 3 \(greedy\)/)).toBeInTheDocument();
  });

  it('renders the last recalc result verbatim, never recomputed', () => {
    renderWithProviders(
      <ApplyLogicCard
        canEdit
        provenance={null}
        onApply={() => Promise.resolve()}
        isApplying={false}
        lastResult={RESULT}
        errorMessage={null}
      />,
    );
    expect(screen.getByText('46')).toBeInTheDocument();
    expect(screen.getByText('9')).toBeInTheDocument();
    expect(screen.getByText('10')).toBeInTheDocument();
    expect(screen.getByText('8')).toBeInTheDocument();
  });

  it('hides the Apply Logic action for a read-only role', () => {
    renderWithProviders(
      <ApplyLogicCard
        canEdit={false}
        provenance={null}
        onApply={() => Promise.resolve()}
        isApplying={false}
        lastResult={null}
        errorMessage={null}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Apply Logic' })).not.toBeInTheDocument();
  });

  it('surfaces an error message', () => {
    renderWithProviders(
      <ApplyLogicCard
        canEdit
        provenance={null}
        onApply={() => Promise.resolve()}
        isApplying={false}
        lastResult={null}
        errorMessage="Your role cannot apply the scheduling logic. This action is limited to Admins."
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('limited to Admins');
  });
});

import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 44,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ key: index, index, start: index * 44, size: 44 })),
    measureElement: () => undefined,
    measure: () => undefined,
  }),
}));
vi.mock('./hard-gate-panel', () => ({ HardGatePanel: () => <div data-testid="hard-gate-panel" /> }));

import { ProjectList, type ProjectRow } from './project-list';

const baseRow: ProjectRow = {
  id: 'p1',
  name: 'Cooler A',
  external_code: null,
  hub_id: 'hub-1',
  leader_engineer_id: null,
  category: 'A+',
  type: 'NM',
  priority: 'P1',
  status: 'In Queue',
  frozen: false,
  actual_start_week: 12,
  delay_weeks: 0,
  reg_year: 2026,
  carry_over: false,
  comments: null,
  customer_name: null,
  tcogs_eur: null,
  selling_price_eur: null,
  gross_margin_pct: null,
  capex_keur: null,
  rm_savings_keur: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  hubName: 'R&D-Greece',
  leaderName: null,
};

describe('ProjectList', () => {
  it('renders every row field verbatim (no derived values)', () => {
    renderWithProviders(
      <ProjectList
        rows={[baseRow]}
        expandedId={null}
        onToggleExpand={vi.fn()}
        onEdit={vi.fn()}
        onSubmit={vi.fn()}
        canEdit
      />,
    );
    expect(screen.getByText('Cooler A')).toBeInTheDocument();
    expect(screen.getByText('R&D-Greece')).toBeInTheDocument();
    expect(screen.getByText('A+')).toBeInTheDocument();
    expect(screen.getByText('In Queue')).toBeInTheDocument();
  });

  it('hides the edit affordance when canEdit is false', () => {
    renderWithProviders(
      <ProjectList
        rows={[baseRow]}
        expandedId={null}
        onToggleExpand={vi.fn()}
        onEdit={vi.fn()}
        onSubmit={vi.fn()}
        canEdit={false}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Edit Cooler A' })).not.toBeInTheDocument();
  });

  it('clicking edit calls onEdit with the row', async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    renderWithProviders(
      <ProjectList
        rows={[baseRow]}
        expandedId={null}
        onToggleExpand={vi.fn()}
        onEdit={onEdit}
        onSubmit={vi.fn()}
        canEdit
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Edit Cooler A' }));
    expect(onEdit).toHaveBeenCalledWith(baseRow);
  });

  it('expanding a Draft row shows the hard-gate panel; a non-Draft row does not', () => {
    const draftRow: ProjectRow = { ...baseRow, id: 'p2', status: 'Draft' };
    renderWithProviders(
      <ProjectList
        rows={[draftRow]}
        expandedId="p2"
        onToggleExpand={vi.fn()}
        onEdit={vi.fn()}
        onSubmit={vi.fn()}
        canEdit
      />,
    );
    expect(screen.getByTestId('hard-gate-panel')).toBeInTheDocument();
  });

  it('a non-Draft expanded row does not show the hard-gate panel', () => {
    renderWithProviders(
      <ProjectList
        rows={[baseRow]}
        expandedId="p1"
        onToggleExpand={vi.fn()}
        onEdit={vi.fn()}
        onSubmit={vi.fn()}
        canEdit
      />,
    );
    expect(screen.queryByTestId('hard-gate-panel')).not.toBeInTheDocument();
  });
});

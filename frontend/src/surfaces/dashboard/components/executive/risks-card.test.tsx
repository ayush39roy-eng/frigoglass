import { describe, expect, it } from 'vitest';
import { screen, within } from '@testing-library/react';

import { renderWithProviders } from '@/test/render';

import type { RiskRow } from '../../lib/executive';
import { RisksCard } from './risks-card';

function risk(i: number, reason: RiskRow['reason'] = 'blocked'): RiskRow {
  return { projectId: `p-${String(i)}`, name: `Project ${String(i)}`, hub: 'PD-India', reason };
}

describe('RisksCard (P28, ADR 0039 §3 + owner round 3)', () => {
  it('rows show ONLY name + hub, grouped under tiny reason headings in order', () => {
    renderWithProviders(
      <RisksCard
        risks={[risk(1, 'blocked'), risk(2, 'overdue'), risk(3, 'vip_not_in_year')]}
      />,
    );
    const rows = screen.getAllByTestId('exec-risk-row');
    expect(rows).toHaveLength(3);
    // Group order: blocked, then overdue, then VIP — one heading per
    // non-empty group carries the reason (no per-row chip any more).
    expect(screen.getByTestId('exec-risk-group-blocked')).toHaveTextContent('On hold');
    expect(screen.getByTestId('exec-risk-group-overdue')).toHaveTextContent('Overdue check-in');
    expect(screen.getByTestId('exec-risk-group-vip_not_in_year')).toHaveTextContent('VIP not in year');
    expect(rows[0]).toHaveAttribute('data-reason', 'blocked');
    expect(rows[1]).toHaveAttribute('data-reason', 'overdue');
    expect(rows[2]).toHaveAttribute('data-reason', 'vip_not_in_year');
    // Same link target as the register rows; name + hub only, full name (no
    // truncate class — long names wrap).
    const link = within(rows[0]!).getByRole('link', { name: 'Project 1' });
    expect(link).toHaveAttribute('href', '/projects/p-1');
    expect(link.className).not.toContain('truncate');
    expect(within(rows[0]!).getByText('PD-India')).toBeInTheDocument();
    expect(within(rows[0]!).queryByText('Blocked')).not.toBeInTheDocument();
    expect(screen.queryByTestId('exec-risks-more')).not.toBeInTheDocument();
  });

  it('renders a heading only for non-empty groups', () => {
    renderWithProviders(<RisksCard risks={[risk(1, 'overdue')]} />);
    expect(screen.queryByTestId('exec-risk-group-blocked')).not.toBeInTheDocument();
    expect(screen.getByTestId('exec-risk-group-overdue')).toBeInTheDocument();
    expect(screen.queryByTestId('exec-risk-group-vip_not_in_year')).not.toBeInTheDocument();
  });

  it('caps the list at 8 with a "+N more" link to the project register', () => {
    renderWithProviders(<RisksCard risks={Array.from({ length: 11 }, (_, i) => risk(i))} />);
    expect(screen.getAllByTestId('exec-risk-row')).toHaveLength(8);
    const more = screen.getByTestId('exec-risks-more');
    expect(more).toHaveTextContent('+3 more');
    expect(more).toHaveAttribute('href', '/projects');
  });

  it('shows a one-line empty state when nothing is flagged', () => {
    renderWithProviders(<RisksCard risks={[]} />);
    expect(screen.getByTestId('exec-risks-empty')).toHaveTextContent(
      'No blocked, overdue or at-risk VIP projects in view.',
    );
  });
});

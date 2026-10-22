import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';

import { renderWithProviders } from '@/test/render';
import { seriousAxeViolations } from '@/test/axe';

import { workspaceFixture } from '../test-fixtures';
import { WorkspaceHeader } from './workspace-header';

/** P29-T03 (ADR 0042 §7, API_CONTRACT_P29 §6): the provisional-leader badge
 *  in the Workspace header, from the served `leader_is_provisional`; and the
 *  P29-T04 RC label. */
const recalc = { state: { kind: 'idle' } as never, start: vi.fn(), busy: false };

function withProject(over: Partial<ReturnType<typeof workspaceFixture>['project']>) {
  const base = workspaceFixture();
  return { ...base, project: { ...base.project, leader_engineer_name: 'Dimopoulou', ...over } };
}

describe('WorkspaceHeader — provisional leader (P29)', () => {
  it('shows "Provisional" next to a provisional leader', async () => {
    const { container } = renderWithProviders(
      <WorkspaceHeader data={withProject({ leader_is_provisional: true })} canRecalculate={false} recalc={recalc} />,
    );
    const leader = screen.getByTestId('header-leader');
    expect(leader).toHaveTextContent('Leader: Dimopoulou');
    expect(within(leader).getByTestId('provisional-leader')).toHaveTextContent('Provisional');
    expect(within(leader).getByText(/assigned by the data load, not by a person/)).toBeInTheDocument();
    expect(await seriousAxeViolations(container)).toEqual([]);
  });

  it('no badge when a person chose the leader', () => {
    renderWithProviders(<WorkspaceHeader data={withProject({ leader_is_provisional: false })} canRecalculate={false} recalc={recalc} />);
    expect(screen.queryByTestId('provisional-leader')).toBeNull();
  });

  it('labels type RC "Regulatory / Business Compliance"', () => {
    renderWithProviders(<WorkspaceHeader data={withProject({ type: 'RC' })} canRecalculate={false} recalc={recalc} />);
    expect(screen.getByText('Regulatory / Business Compliance')).toBeInTheDocument();
  });
});

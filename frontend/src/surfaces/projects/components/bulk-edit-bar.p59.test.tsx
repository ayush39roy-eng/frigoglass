import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';

import type { ProjectFilterRow } from '@/surfaces/dashboard/api/types';

import { buildRegisterEditsBody, setDraftBulk, type RegisterRow } from '../lib/register-edit';
import { BulkEditBar } from './bulk-edit-bar';

function row(id: string, status: ProjectFilterRow['status'], applicable = true): RegisterRow {
  return {
    project_id: id,
    status,
    priority: 'P3',
    priority_applicable: applicable,
    category: 'A',
    type: 'NM',
    leader_engineer_id: null,
    actual_start_week: null,
    actual_end_week: null,
    design_effort_weeks: null,
    lab_effort_weeks: null,
    current_step_code: 'PDD-A',
  } as unknown as RegisterRow;
}

describe('P59 bulk edit: priority, current step, category, type', () => {
  it('stages priority on the ticked rows (Commercialized / Cancelled skipped) and the Save body carries it', () => {
    const rows = [row('p1', 'In Development'), row('p2', 'In Queue'), row('p3', 'Commercialized', false)];
    let drafts = setDraftBulk({}, rows, { priority: 'P1' });
    drafts = setDraftBulk(drafts, rows.slice(0, 1), { current_step_code: 'PDD-B', category: 'B', project_type: 'CO' });
    expect(buildRegisterEditsBody(drafts, rows)).toEqual({
      edits: [
        { project_id: 'p1', priority: 'P1', current_step_code: 'PDD-B', category: 'B', project_type: 'CO' },
        { project_id: 'p2', priority: 'P1' },
      ],
    });
  });

  it('the bar applies the picked priority and says how many rows were skipped', async () => {
    const onApply = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <BulkEditBar
        selectedCount={5}
        draftCount={0}
        notApplicableCount={2}
        leaderOptions={[]}
        leaderNote={null}
        workflowOptions={null}
        workflowNote="Pick projects of one workflow to set the current step or category."
        onApply={onApply}
        onClearSelection={vi.fn()}
      />,
    );
    await user.selectOptions(screen.getByTestId('bulk-priority'), 'P2');
    await user.click(screen.getByTestId('bulk-priority-apply'));
    expect(onApply).toHaveBeenCalledWith({ priority: 'P2' });
    expect(screen.getByTestId('bulk-notice')).toHaveTextContent(
      '2 Commercialized/Cancelled rows skipped — priority not applicable',
    );
    expect(screen.getByTestId('bulk-step')).toBeDisabled();
    expect(screen.getByTestId('bulk-workflow-note')).toHaveTextContent('Pick projects of one workflow');
  });
});

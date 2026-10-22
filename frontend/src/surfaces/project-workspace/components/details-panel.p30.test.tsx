import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';

import { renderWithProviders } from '@/test/render';
import { seriousAxeViolations } from '@/test/axe';

vi.mock('@/lib/api/reference', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/reference')>('@/lib/api/reference');
  return { ...actual, useHubs: () => ({ data: [] }) };
});

import { stage, workspaceFixture } from '../test-fixtures';
import { DetailsPanel } from './details-panel';
import { StageRow } from './stage-row';

/**
 * P30-T03 (ADR 0041, API_CONTRACT_P30 §2): the Workspace Details read view
 * shows the client's effort figures and the display-only workbook figures,
 * served verbatim and compact.
 */
function data(over: Partial<ReturnType<typeof workspaceFixture>['project']> = {}) {
  const base = workspaceFixture();
  return { ...base, project: { ...base.project, ...over } };
}

describe('Workspace Details — P30 client figures', () => {
  it('shows the effort figures, or "Lead-time table" when there is none', () => {
    const { unmount } = renderWithProviders(
      <DetailsPanel data={data({ design_effort_weeks: 4, lab_effort_weeks: 10.5 })} canEditDetails={false} canEditScores={false} financialsVisible={false} />,
    );
    const details = screen.getByTestId('details-read');
    expect(within(details).getByText('Design effort (client)').nextElementSibling).toHaveTextContent('4 wk');
    expect(within(details).getByText('Lab effort (client)').nextElementSibling).toHaveTextContent('10.5 wk');
    expect(within(details).queryByText('Estimated design weeks')).toBeNull();
    unmount();
    renderWithProviders(<DetailsPanel data={data()} canEditDetails={false} canEditScores={false} financialsVisible={false} />);
    expect(screen.getByText('Design effort (client)').nextElementSibling).toHaveTextContent('Lead-time table');
  });

  it('lists the display-only workbook figures under "From the client workbook"', async () => {
    const { container } = renderWithProviders(
      <DetailsPanel
        data={data({ safety_lab_weeks: 3.5, actual_design_weeks: 18.25, actual_testing_weeks: null, safety_certification_required: true, capacity_flag: false })}
        canEditDetails={false}
        canEditScores={false}
        financialsVisible={false}
      />,
    );
    const charter = screen.getByTestId('details-charter');
    const value = (label: string) => within(charter).getByText(label).nextElementSibling;
    expect(value('Safety lab weeks')).toHaveTextContent('3.5 wk');
    expect(value('Actual design weeks')).toHaveTextContent('18.25 wk');
    expect(value('Actual testing weeks')).toHaveTextContent('—');
    expect(value('Safety cert. required')).toHaveTextContent('Yes');
    expect(value('Capacity flag')).toHaveTextContent('No');
    expect(await seriousAxeViolations(container)).toEqual([]);
  });
});

describe('Workspace stage row — P30 effort-skipped stage', () => {
  it('names the effort split as the reason a stage is skipped', () => {
    renderWithProviders(
      <ul>
        <StageRow stage={stage(3, { skipped: true, effort_weeks: 0, lead_time_weeks: 1 })} canWrite={false} onSave={vi.fn()} />
      </ul>,
    );
    expect(screen.getByTestId('stage-skipped-PDD-D')).toHaveAttribute(
      'title',
      "Skipped — its share of the project's client effort figure is 0 weeks",
    );
  });
});

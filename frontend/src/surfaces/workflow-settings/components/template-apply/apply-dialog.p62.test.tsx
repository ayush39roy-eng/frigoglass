import { describe, expect, it, vi } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import { seriousAxeViolations } from '@/test/axe';
import { ApiError } from '@/lib/api/client';

import type { ApplyPreviewResponse } from '../../api/types';
import { applyErrorMessage, TEMPLATE_COPY } from '../../lib/template-copy';
import { ApplyDialog } from './apply-dialog';

/** P62 (API_CONTRACT_P62 §4.2): hold before → after and the three new flags, in plain words. */
const PREVIEW: ApplyPreviewResponse = {
  categories: [],
  counts: { automatic: 1, choosable: 0, own_effort: 0, never: 0 },
  automatic: [
    {
      project_id: 'p1',
      name: 'Cooler Alpha',
      hub: 'R&D-Greece',
      status: 'In Development',
      steps: [
        { step_id: 'PDD-J', eff_before: 3, eff_after: 3, gap_before: 0, gap_after: 0, hold_before: null, hold_after: 1, flags: ['lab_split_rederived'] },
        { step_id: 'PDD-L', eff_before: 3, eff_after: 1, gap_before: 0, gap_after: 0, hold_before: 2, hold_after: 1, flags: ['room_weeks_clamped', 'partial_room_length_applied'] },
        { step_id: 'PDD-E', eff_before: 6, eff_after: 6, gap_before: 0, gap_after: -1, hold_before: null, hold_after: null, flags: [] },
      ],
    },
  ],
  choosable: [],
  own_effort: [],
  never: [],
};

describe('ApplyDialog room weeks (P62)', () => {
  it('lists room weeks before → after and the new flags in plain words; axe clean', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <ApplyDialog
        flow={{
          kind: 'review',
          request: { changes: [] },
          options: { summary: ['B · PDD-J room weeks Full → 1w'] },
          preview: PREVIEW,
        }}
        onApply={vi.fn()}
        onBack={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByRole('list', { name: 'Changes to save' })).toHaveTextContent('B · PDD-J room weeks Full → 1w');
    await user.click(screen.getByRole('button', { name: 'Show 1 project' }));
    const rooms = screen.getAllByTestId('apply-step-room');
    expect(rooms.map((r) => r.textContent)).toEqual(['room weeks Full → 1w', 'room weeks 2w → 1w']);
    expect(screen.getByTestId('apply-flag-lab_split_rederived')).toHaveTextContent('its own lab figure is shared out again');
    expect(screen.getByTestId('apply-flag-room_weeks_clamped')).toHaveTextContent('room weeks cut to the new length');
    expect(screen.getByTestId('apply-flag-partial_room_length_applied')).toHaveTextContent('the template length is applied');
    expect(await seriousAxeViolations(document.body)).toEqual([]);
  });

  it('names the two room-weeks refusals', () => {
    const err = (code: string) => new ApiError(422, 'x', 'x', code);
    expect(applyErrorMessage(err('LAB_HOLD_NOT_LAB'), 'apply')).toBe(TEMPLATE_COPY.labHoldNotLab);
    expect(applyErrorMessage(err('LAB_HOLD_OUT_OF_RANGE'), 'preview')).toBe(TEMPLATE_COPY.labHoldOutOfRange);
  });
});

import type { UseQueryResult } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { ScheduleRunChanges } from '@/lib/api/priority-move';
import { IDLE_RUN_FOLLOW } from '@/lib/use-schedule-run-follow';
import { autoReloadAllowed, editSessionHeld } from '@/test/reload-safety';

import { MoveFlowPanel } from './move-flow-panel';
import type { MoveFlowState } from './use-priority-move-flow';

const changes = { isPending: true, isError: false, data: undefined } as unknown as UseQueryResult<ScheduleRunChanges>;
const fields = {
  target: { projectId: 'p1', projectName: 'Cooler A', priority: 'P2' as const },
  rank: null,
  before: 'P2' as const,
  after: 'P1' as const,
  runId: 'run-1',
  baselineRunId: null,
};

function renderPanel(flow: MoveFlowState) {
  return render(<MoveFlowPanel flow={flow} runState={IDLE_RUN_FOLLOW} changes={changes} onClose={() => undefined} />);
}

describe('MoveFlowPanel — P49-R01 auto reload waits (ADR 0060 R1, W49-1c)', () => {
  it('a followed run holds an auto reload', () => {
    renderPanel({ kind: 'running', ...fields });
    expect(screen.getByTestId('priority-move-panel')).toHaveAttribute('data-kind', 'running');
    expect(editSessionHeld()).toBe(true);
    expect(autoReloadAllowed()).toBe(false);
  });

  it('the "Timeline updated" result holds it too, until the panel closes', () => {
    const { rerender } = renderPanel({ kind: 'updated', ...fields });
    expect(editSessionHeld()).toBe(true);
    rerender(<MoveFlowPanel flow={{ kind: 'idle' }} runState={IDLE_RUN_FOLLOW} changes={changes} onClose={() => undefined} />);
    expect(editSessionHeld()).toBe(false);
    expect(autoReloadAllowed()).toBe(true);
  });

  it('a notice does not hold it', () => {
    renderPanel({ kind: 'notice', target: fields.target, tone: 'success', title: 'Done', body: 'Nothing to recalculate.' });
    expect(editSessionHeld()).toBe(false);
  });
});

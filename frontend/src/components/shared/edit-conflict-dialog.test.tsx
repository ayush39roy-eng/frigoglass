import { describe, expect, it, vi } from 'vitest';
import { act, render, renderHook, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { seriousAxeViolations } from '@/test/axe';
import type { EditConflict } from '@/lib/api/edit-conflict';
import { useEditConflict } from '@/lib/use-edit-conflict';
import { askEditConflict } from '@/stores/edit-conflict-host';

import { EditConflictDialog } from './edit-conflict-dialog';
import { EditConflictHost } from './edit-conflict-host';
import { conflictChangedText, conflictFieldLabel, formatConflictValue } from './edit-conflict-meta';

const AT = '2026-11-18T09:05:00Z';

function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

const CONFLICTS: EditConflict[] = [
  {
    entity: 'project',
    id: 'p1',
    label: 'Alpha Cooler',
    field: 'leader_engineer_id',
    your_value: 'eng-2',
    current_value: 'eng-3',
    changed_by: 'Maria Kosta',
    changed_at: AT,
  },
  {
    entity: 'project',
    id: 'p1',
    label: 'Alpha Cooler',
    field: 'selling_price_eur',
    your_value: '<hidden>',
    current_value: '<hidden>',
    changed_by: null,
    changed_at: null,
  },
];

describe('EditConflictDialog (ADR 0059 C2)', () => {
  it('lists each conflict: label, friendly field, you entered, now saved, who and when; hidden values read "hidden"', async () => {
    const { baseElement } = render(
      <EditConflictDialog open conflicts={CONFLICTS} onUseTheirs={vi.fn()} onKeepMine={vi.fn()} onDismiss={vi.fn()} />,
    );
    const dialog = screen.getByRole('dialog', { name: /Someone else changed this while you were editing/ });
    const [leader, price] = within(dialog).getAllByTestId('edit-conflict-item');
    expect(leader).toHaveTextContent('Alpha Cooler: Project leader');
    expect(leader).toHaveTextContent('You enteredeng-2');
    expect(leader).toHaveTextContent('Now savedeng-3');
    expect(leader).toHaveTextContent(`Changed by Maria Kosta`);
    expect(leader).toHaveTextContent(hhmm(AT));
    expect(price).toHaveTextContent('Alpha Cooler: Selling price');
    expect(price).toHaveTextContent('You enteredhidden');
    expect(price).toHaveTextContent('Now savedhidden');
    expect(price).not.toHaveTextContent('<hidden>');
    expect(price).toHaveTextContent('Changed by someone else');
    expect(await seriousAxeViolations(baseElement)).toEqual([]);
  });

  it('a value formatter maps served ids to names (display only)', () => {
    render(
      <EditConflictDialog
        open
        conflicts={[CONFLICTS[0]!]}
        onUseTheirs={vi.fn()}
        onKeepMine={vi.fn()}
        onDismiss={vi.fn()}
        formatValue={(_c, v) => (v === 'eng-3' ? 'Nikos Papas' : null)}
      />,
    );
    expect(screen.getByTestId('edit-conflict-item')).toHaveTextContent('Now savedNikos Papas');
  });

  it('"Use theirs" and "Keep mine" call their handlers', async () => {
    const user = userEvent.setup();
    const onUseTheirs = vi.fn();
    const onKeepMine = vi.fn();
    render(<EditConflictDialog open conflicts={CONFLICTS} onUseTheirs={onUseTheirs} onKeepMine={onKeepMine} onDismiss={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Use theirs' }));
    await user.click(screen.getByRole('button', { name: 'Keep mine' }));
    expect(onUseTheirs).toHaveBeenCalledTimes(1);
    expect(onKeepMine).toHaveBeenCalledTimes(1);
  });

  it('values are text, never HTML', () => {
    render(
      <EditConflictDialog
        open
        conflicts={[{ ...CONFLICTS[0]!, field: 'name', your_value: '<b>bold</b>', current_value: '<img src=x>' }]}
        onUseTheirs={vi.fn()}
        onKeepMine={vi.fn()}
        onDismiss={vi.fn()}
      />,
    );
    const item = screen.getByTestId('edit-conflict-item');
    expect(item).toHaveTextContent('<b>bold</b>');
    expect(item.querySelector('b, img')).toBeNull();
  });
});

describe('edit-conflict meta', () => {
  it('friendly names, plain values and the "changed by" line', () => {
    expect(conflictFieldLabel('status')).toBe('Status');
    expect(conflictFieldLabel('scores.strategic_project')).toBe('Strategic project');
    expect(conflictFieldLabel('some_new_field_id')).toBe('Some new field');
    expect(formatConflictValue(null)).toBe('empty');
    expect(formatConflictValue(true)).toBe('Yes');
    expect(formatConflictValue('<hidden>')).toBe('hidden');
    expect(formatConflictValue([{ step_code: 'PDD-C', step_excluded: true }])).toBe('PDD-C (excluded)');
    expect(conflictChangedText({ changed_by: 'Ana', changed_at: AT }, new Date(AT))).toBe(`Changed by Ana at ${hhmm(AT)}`);
    expect(conflictChangedText({ changed_by: null, changed_at: null })).toBe('Changed by someone else');
  });
});

describe('useEditConflict / the app-wide host', () => {
  it('ask() resolves with the button the user pressed', async () => {
    const user = userEvent.setup();
    const { result } = renderHook(() => useEditConflict());
    let answer: Promise<unknown> = Promise.resolve();
    act(() => {
      answer = result.current.ask(CONFLICTS);
    });
    render(result.current.dialog);
    await user.click(screen.getByRole('button', { name: 'Keep mine' }));
    await expect(answer).resolves.toBe('mine');
  });

  it('the host answers through the shell dialog; with no host mounted it resolves null at once', async () => {
    await expect(askEditConflict(CONFLICTS)).resolves.toBeNull();
    const user = userEvent.setup();
    render(<EditConflictHost />);
    let answer: Promise<unknown> = Promise.resolve();
    act(() => {
      answer = askEditConflict(CONFLICTS);
    });
    await user.click(await screen.findByRole('button', { name: 'Use theirs' }));
    await expect(answer).resolves.toBe('theirs');
  });
});

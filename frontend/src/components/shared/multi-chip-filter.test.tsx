import * as React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { seriousAxeViolations } from '@/test/axe';
import { CATEGORY_CHIP_OPTIONS, TYPE_CHIP_OPTIONS_WITH_UNMAPPED } from '@/lib/multi-select-filter';
import type { ProjectCategory } from '@/types/enums';

import { MultiChipFilter } from './multi-chip-filter';

function Harness({ onChange }: { onChange?: (next: ProjectCategory[]) => void }): React.JSX.Element {
  const [value, setValue] = React.useState<ProjectCategory[]>([]);
  return (
    <MultiChipFilter
      label="Category"
      options={CATEGORY_CHIP_OPTIONS}
      value={value}
      onChange={(next) => {
        setValue(next);
        onChange?.(next);
      }}
    />
  );
}

describe('MultiChipFilter (P31)', () => {
  it('is a labelled group of aria-pressed toggles; "All" is pressed when nothing is selected', () => {
    render(<Harness />);
    const group = screen.getByRole('group', { name: 'Category' });
    const buttons = within(group).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['All', 'A+', 'A', 'B', 'C', 'A-OEM', 'B-OEM', 'C-OEM']);
    expect(within(group).getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(group).getByRole('button', { name: 'A+' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('pressing chips toggles several on; "All" clears; the selection is in option order', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);
    const group = screen.getByRole('group', { name: 'Category' });
    await user.click(within(group).getByRole('button', { name: 'B' }));
    await user.click(within(group).getByRole('button', { name: 'A+' }));
    await user.click(within(group).getByRole('button', { name: 'A' }));
    expect(onChange).toHaveBeenLastCalledWith(['A+', 'A', 'B']);
    expect(within(group).getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'false');
    await user.click(within(group).getByRole('button', { name: 'A' }));
    expect(onChange).toHaveBeenLastCalledWith(['A+', 'B']);
    await user.click(within(group).getByRole('button', { name: 'All' }));
    expect(onChange).toHaveBeenLastCalledWith([]);
    expect(within(group).getByRole('button', { name: 'All' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('is keyboard operable: Tab reaches each chip, Space and Enter toggle', async () => {
    const onChange = vi.fn();
    const user = userEvent.setup();
    render(<Harness onChange={onChange} />);
    await user.tab();
    expect(screen.getByRole('button', { name: 'All' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'A+' })).toHaveFocus();
    await user.keyboard(' ');
    expect(onChange).toHaveBeenLastCalledWith(['A+']);
    await user.tab();
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenLastCalledWith(['A+', 'A']);
    expect(screen.getByRole('button', { name: 'A' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('type chips use the served labels in full (never truncated), incl. Unmapped; the code is the tooltip', () => {
    render(<MultiChipFilter label="Type" options={TYPE_CHIP_OPTIONS_WITH_UNMAPPED} value={['RC']} onChange={() => undefined} />);
    const group = screen.getByRole('group', { name: 'Type' });
    const names = within(group).getAllByRole('button').map((b) => b.textContent);
    expect(names).toEqual([
      'All',
      'New Model',
      'Cost Optimization',
      'Regulatory / Business Compliance',
      'New Option',
      'Improvement',
      'Alternative Component',
      'Service',
      'Unmapped',
    ]);
    const rc = within(group).getByRole('button', { name: 'Regulatory / Business Compliance' });
    expect(rc).toHaveAttribute('aria-pressed', 'true');
    expect(rc).toHaveAttribute('title', 'RC');
    expect(rc).toHaveClass('whitespace-nowrap');
    expect(rc.className).not.toMatch(/truncate|text-ellipsis/);
    // The row wraps instead of clipping.
    expect(rc.parentElement).toHaveClass('flex-wrap');
  });

  it('is axe-clean in both states', async () => {
    const { container } = render(
      <MultiChipFilter label="Type" options={TYPE_CHIP_OPTIONS_WITH_UNMAPPED} value={['NM', 'Unmapped']} onChange={() => undefined} />,
    );
    expect(await seriousAxeViolations(container)).toEqual([]);
  });
});

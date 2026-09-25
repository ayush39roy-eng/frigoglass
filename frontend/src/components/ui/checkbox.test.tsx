import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { Checkbox } from './checkbox';

describe('Checkbox', () => {
  it('toggles checked state and calls onCheckedChange', async () => {
    const onCheckedChange = vi.fn();
    const user = userEvent.setup();
    render(<Checkbox aria-label="Frozen" onCheckedChange={onCheckedChange} />);
    const box = screen.getByRole('checkbox', { name: 'Frozen' });
    expect(box).toHaveAttribute('data-state', 'unchecked');
    await user.click(box);
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it('renders an indeterminate state', () => {
    render(<Checkbox aria-label="Partial" checked="indeterminate" />);
    expect(screen.getByRole('checkbox', { name: 'Partial' })).toHaveAttribute(
      'data-state',
      'indeterminate',
    );
  });
});

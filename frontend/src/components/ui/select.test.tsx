import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './select';

describe('Select', () => {
  it('opens, lists options, and reports the chosen value', async () => {
    const onValueChange = vi.fn();
    const user = userEvent.setup();
    render(
      <Select onValueChange={onValueChange}>
        <SelectTrigger aria-label="Hub">
          <SelectValue placeholder="Choose a hub" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="R&D-Greece">R&D-Greece</SelectItem>
          <SelectItem value="PD-Romania">PD-Romania</SelectItem>
        </SelectContent>
      </Select>,
    );
    await user.click(screen.getByRole('combobox', { name: 'Hub' }));
    const option = await screen.findByRole('option', { name: 'PD-Romania' });
    await user.click(option);
    expect(onValueChange).toHaveBeenCalledWith('PD-Romania');
  });
});

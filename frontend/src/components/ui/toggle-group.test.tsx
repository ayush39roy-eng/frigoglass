import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ToggleGroup, ToggleGroupItem } from './toggle-group';

describe('ToggleGroup', () => {
  it('selects a single item and reports the change (e.g. currency toggle)', async () => {
    const onValueChange = vi.fn();
    const user = userEvent.setup();
    render(
      <ToggleGroup type="single" value="EUR" onValueChange={onValueChange} aria-label="Currency">
        <ToggleGroupItem value="EUR">EUR</ToggleGroupItem>
        <ToggleGroupItem value="USD">USD</ToggleGroupItem>
        <ToggleGroupItem value="INR">INR</ToggleGroupItem>
      </ToggleGroup>,
    );
    expect(screen.getByRole('radio', { name: 'EUR' })).toHaveAttribute('data-state', 'on');
    await user.click(screen.getByRole('radio', { name: 'USD' }));
    expect(onValueChange).toHaveBeenCalledWith('USD');
  });
});

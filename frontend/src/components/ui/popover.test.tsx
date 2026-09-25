import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { Button } from './button';
import { Popover, PopoverContent, PopoverTrigger } from './popover';

describe('Popover', () => {
  it('opens its content on trigger click', async () => {
    const user = userEvent.setup();
    render(
      <Popover>
        <PopoverTrigger asChild>
          <Button>Filters</Button>
        </PopoverTrigger>
        <PopoverContent>Hub: R&D-Greece</PopoverContent>
      </Popover>,
    );
    expect(screen.queryByText('Hub: R&D-Greece')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Filters' }));
    expect(await screen.findByText('Hub: R&D-Greece')).toBeInTheDocument();
  });
});

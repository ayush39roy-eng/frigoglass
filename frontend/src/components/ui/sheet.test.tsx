import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { seriousAxeViolations } from '@/test/axe';

import { Button } from './button';
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle, SheetTrigger } from './sheet';

function Example({ side = 'right' }: { side?: 'right' | 'left' }) {
  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button>Open panel</Button>
      </SheetTrigger>
      <SheetContent side={side}>
        <SheetHeader>
          <SheetTitle>Move preview</SheetTitle>
          <SheetDescription>Nothing is saved until you choose Yes.</SheetDescription>
        </SheetHeader>
        <SheetFooter>
          <Button>Yes</Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}

describe('Sheet', () => {
  it('is a labelled modal dialog docked on the right by default; Escape closes and focus returns to the trigger', async () => {
    const user = userEvent.setup();
    render(<Example />);
    const trigger = screen.getByRole('button', { name: 'Open panel' });
    await user.click(trigger);
    const sheet = await screen.findByRole('dialog', { name: 'Move preview' });
    expect(sheet).toHaveAccessibleDescription('Nothing is saved until you choose Yes.');
    expect(sheet).toHaveAttribute('data-variant', 'sheet');
    expect(sheet).toHaveAttribute('data-side', 'right');
    expect(sheet).toHaveClass('right-0', 'inset-y-0', 'h-full');
    expect(sheet).not.toHaveClass('top-1/2');
    expect(await seriousAxeViolations(sheet)).toEqual([]);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('can dock on the left, and closes on its Close button', async () => {
    const user = userEvent.setup();
    render(<Example side="left" />);
    await user.click(screen.getByRole('button', { name: 'Open panel' }));
    const sheet = await screen.findByRole('dialog', { name: 'Move preview' });
    expect(sheet).toHaveAttribute('data-side', 'left');
    expect(sheet).toHaveClass('left-0');
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

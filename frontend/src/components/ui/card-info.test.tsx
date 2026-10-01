import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import { CardInfo } from '@/components/ui/card-info';

describe('CardInfo', () => {
  it('exposes the prose behind a named, keyboard-reachable button', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <CardInfo label="Schedule outcome source">
        <p>Not recomputed in the browser (Invariant I9).</p>
      </CardInfo>,
    );

    const trigger = screen.getByRole('button', { name: 'Schedule outcome source' });
    // Closed by default — the point of the change is that this copy is no longer
    // shouted as body copy on the surface.
    expect(screen.queryByText(/Invariant I9/)).not.toBeInTheDocument();

    // Reachable by keyboard, not just by pointer.
    await user.tab();
    expect(trigger).toHaveFocus();
    await user.keyboard('{Enter}');

    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent(/Not recomputed in the browser \(Invariant I9\)/);
    // The label doubles as the popover's own visible heading, so the panel is
    // self-describing once open.
    expect(dialog).toHaveTextContent('Schedule outcome source');
  });

  it('dismisses on Escape', async () => {
    const user = userEvent.setup();
    renderWithProviders(
      <CardInfo label="Pipeline composition source">
        <p>Source: live project registry.</p>
      </CardInfo>,
    );
    await user.click(screen.getByRole('button', { name: 'Pipeline composition source' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

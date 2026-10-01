import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { CapacityReportingNotice } from './capacity-reporting-notice';

/**
 * The honest-framing callout is a P4-T03 hard constraint, so these tests assert
 * the same three paragraphs they always did — the ADR 0008 supply formula, the
 * "neither FTE nor downtime is applied when the scheduler books" caveat
 * (ADR 0002 / 0008), and the "load > capacity does NOT mean the scheduler
 * overbooked anyone" conclusion.
 *
 * What changed 2026-10-01 (client text cleanup) is only HOW the copy is reached:
 * it moved from a permanently-rendered four-paragraph `<aside>` landmark into a
 * keyboard-reachable `<CapacityInfo>` popover, so each assertion now opens the
 * disclosure first. The asserted words are unchanged.
 */
describe('CapacityReportingNotice', () => {
  it("states that capacity supply is the client's ADR 0008 formula, which the scheduler does not apply when booking", async () => {
    const user = userEvent.setup();
    render(<CapacityReportingNotice />);

    await user.click(screen.getByRole('button', { name: 'How to read these figures' }));

    expect(screen.getByText(/client.s own supply formula/i)).toBeInTheDocument();
    expect(screen.getByText(/ADR.0008\): a hub work calendar/)).toHaveTextContent(/0002/);
    expect(screen.getByText(/scheduler overbooked anyone/i)).toBeInTheDocument();
  });

  it('is reachable by keyboard and names itself for assistive tech', async () => {
    const user = userEvent.setup();
    render(<CapacityReportingNotice />);

    // The affordance is a real button with an accessible name (the icon itself
    // is aria-hidden), so the copy stays reachable without being body text.
    const trigger = screen.getByRole('button', { name: 'How to read these figures' });
    expect(trigger).toBeInTheDocument();

    await user.tab();
    expect(trigger).toHaveFocus();

    await user.keyboard('{Enter}');
    expect(await screen.findByRole('dialog')).toHaveTextContent(/How to read these figures/);
  });
});

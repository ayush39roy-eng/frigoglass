import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { seriousAxeViolations } from '@/test/axe';

import { TrackingStatusChip } from './tracking-status-chip';
import { TRACKING_STATUSES } from './tracking-status-meta';
import { VipBadge } from './vip-badge';

describe('TrackingStatusChip (ADR 0021 §4, contract §7)', () => {
  it.each([
    ['live', 'Live'],
    ['due', 'Due this week'],
    ['overdue', 'Overdue'],
    ['idle', 'No active stage'],
  ] as const)('labels %s as "%s" with an icon and screen-reader context', (status, label) => {
    render(<TrackingStatusChip status={status} />);
    const chip = screen.getByTestId('tracking-status-chip');
    expect(chip).toHaveAttribute('data-tracking', status);
    expect(chip).toHaveTextContent(`Tracking: ${label}`);
    expect(chip.querySelector('svg')).not.toBeNull();
  });

  it('covers every served status', () => {
    expect(TRACKING_STATUSES).toEqual(['live', 'due', 'overdue', 'idle']);
  });

  it('has no serious/critical axe violations', async () => {
    const { container } = render(
      <div>
        {TRACKING_STATUSES.map((s) => (
          <TrackingStatusChip key={s} status={s} />
        ))}
        <VipBadge />
      </div>,
    );
    expect(await seriousAxeViolations(container)).toEqual([]);
  });
});

describe('VipBadge (ADR 0022, contract §7)', () => {
  it('reads "VIP project" and accepts a className', () => {
    render(<VipBadge className="ml-2" />);
    const badge = screen.getByTestId('vip-badge');
    expect(badge).toHaveTextContent('VIP project');
    expect(badge).toHaveClass('ml-2');
  });
});

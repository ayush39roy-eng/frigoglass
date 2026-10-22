import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const mutation = vi.hoisted(() => ({ mutate: vi.fn(), isPending: false, isError: false }));
vi.mock('@/lib/api/vip', () => ({ useSetProjectVip: () => mutation }));

import { VipToggle } from './vip-toggle';

beforeEach(() => {
  mutation.mutate.mockReset();
  mutation.isPending = false;
  mutation.isError = false;
});

describe('VipToggle (ADR 0040)', () => {
  it('an outline star makes the project VIP', async () => {
    render(<VipToggle projectId="p1" projectName="Cooler" isVip={false} canPin />);
    const btn = screen.getByRole('button', { name: 'Make Cooler VIP' });
    expect(btn).toHaveAttribute('aria-pressed', 'false');
    await userEvent.setup().click(btn);
    expect(mutation.mutate).toHaveBeenCalledWith({ projectId: 'p1', isVip: true });
  });

  it('a filled star removes VIP', async () => {
    render(<VipToggle projectId="p1" projectName="Cooler" isVip canPin />);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Remove VIP from Cooler' }));
    expect(mutation.mutate).toHaveBeenCalledWith({ projectId: 'p1', isVip: false });
  });

  it('shows the refusal in the title after an error', () => {
    mutation.isError = true;
    render(<VipToggle projectId="p1" projectName="Cooler" isVip={false} canPin />);
    expect(screen.getByRole('button', { name: 'Make Cooler VIP' })).toHaveAttribute(
      'title',
      expect.stringContaining('refused') as unknown as string,
    );
  });

  it('read-only: a mark on VIP, nothing otherwise', () => {
    const { rerender } = render(<VipToggle projectId="p1" projectName="Cooler" isVip canPin={false} />);
    expect(screen.getByTestId('vip-mark')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    rerender(<VipToggle projectId="p1" projectName="Cooler" isVip={false} canPin={false} />);
    expect(screen.queryByTestId('vip-mark')).not.toBeInTheDocument();
  });
});

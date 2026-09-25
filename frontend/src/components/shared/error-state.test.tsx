import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { ErrorState } from './error-state';

describe('ErrorState', () => {
  it('states what failed, never a bare "Something went wrong"', () => {
    render(<ErrorState description="Could not reach the schedule-run API." />);
    expect(screen.getByRole('alert')).toHaveTextContent('Could not reach the schedule-run API.');
  });

  it('shows a Retry action only when onRetry is provided', async () => {
    const onRetry = vi.fn();
    const user = userEvent.setup();
    const { rerender } = render(<ErrorState description="Failed." />);
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();

    rerender(<ErrorState description="Failed." onRetry={onRetry} />);
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

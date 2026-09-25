import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { Badge } from './badge';

describe('Badge', () => {
  it('renders its label', () => {
    render(<Badge>SPILLOVER</Badge>);
    expect(screen.getByText('SPILLOVER')).toBeInTheDocument();
  });

  it('applies a custom className alongside variant classes', () => {
    render(<Badge tone="danger" className="my-marker" data-testid="badge" />);
    const el = screen.getByTestId('badge');
    expect(el).toHaveClass('my-marker');
    expect(el.className).toContain('bg-danger-subtle');
  });
});

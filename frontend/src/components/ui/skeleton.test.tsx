import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { Skeleton } from './skeleton';

describe('Skeleton', () => {
  it('announces loading state to assistive tech', () => {
    render(<Skeleton className="h-8 w-full" />);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(status).toHaveTextContent('Loading');
  });
});

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { Spinner } from './spinner';

describe('Spinner', () => {
  it('exposes a status role with an accessible label', () => {
    render(<Spinner label="Applying priorities" />);
    expect(screen.getByRole('status')).toHaveTextContent('Applying priorities');
  });

  it('defaults to a generic "Loading" label', () => {
    render(<Spinner />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading');
  });
});

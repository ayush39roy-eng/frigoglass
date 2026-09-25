import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { PriorityBandPill } from './priority-band-pill';

describe('PriorityBandPill', () => {
  it('renders the visible label for a scored band', () => {
    render(<PriorityBandPill priority="P1" />);
    expect(screen.getByText('P1')).toBeInTheDocument();
  });

  it('never relies on colour alone — icon-only mode still exposes an accessible label', () => {
    render(<PriorityBandPill priority="Q" iconOnly />);
    expect(screen.getByText(/queue/i)).toBeInTheDocument();
  });
});

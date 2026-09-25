import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { BarChart } from './bar-chart';

describe('BarChart', () => {
  it('renders every datum as a label + numeric value under a named region', () => {
    render(
      <BarChart
        ariaLabel="Outcome breakdown"
        data={[
          { key: 'wy', label: 'Within year', value: 9, tone: 'success' },
          { key: 'so', label: 'Spillover', value: 4, tone: 'warning' },
        ]}
      />,
    );
    const region = screen.getByLabelText('Outcome breakdown');
    expect(region).toBeInTheDocument();
    expect(screen.getByText('Within year')).toBeInTheDocument();
    expect(screen.getByText('9')).toBeInTheDocument();
    expect(screen.getByText('Spillover')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
  });

  it('does not divide by zero when every value is 0', () => {
    render(
      <BarChart
        ariaLabel="Empty"
        data={[{ key: 'a', label: 'A', value: 0 }]}
      />,
    );
    expect(screen.getByText('0')).toBeInTheDocument();
  });
});

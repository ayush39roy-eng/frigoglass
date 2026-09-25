import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { DeltaChip, KpiCard, Sparkline, StatCard } from './stat-card';

describe('DeltaChip', () => {
  it('never signals with colour alone — an arrow and text carry the same meaning', () => {
    const { container } = render(<DeltaChip value={12.7} label="+12.7%" />);
    expect(screen.getByText('+12.7%')).toBeInTheDocument();
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('treats a rise as good by default', () => {
    const { container } = render(<DeltaChip value={5} />);
    expect(container.firstElementChild?.className).toContain('success');
  });

  it('treats a rise as BAD when higherIsBetter is false', () => {
    // Over-allocation going up is not a win. Hard-coding green-for-up would make
    // half the dashboard lie.
    const { container } = render(<DeltaChip value={5} higherIsBetter={false} />);
    expect(container.firstElementChild?.className).toContain('danger');
  });

  it('treats a fall as good when lower is better', () => {
    const { container } = render(<DeltaChip value={-5} higherIsBetter={false} />);
    expect(container.firstElementChild?.className).toContain('success');
  });

  it('renders a flat delta as neutral, not as a false positive', () => {
    const { container } = render(<DeltaChip value={0} />);
    const className = container.firstElementChild?.className ?? '';
    expect(className).not.toContain('success');
    expect(className).not.toContain('danger');
  });

  it('formats an unlabelled delta with an explicit sign', () => {
    render(<DeltaChip value={3.25} />);
    expect(screen.getByText('+3.3%')).toBeInTheDocument();
  });
});

describe('Sparkline', () => {
  it('is announced as an image with a real label — it is information, not decoration', () => {
    render(<Sparkline values={[1, 4, 2, 8]} label="Completion trend" />);
    expect(screen.getByRole('img', { name: 'Completion trend' })).toBeInTheDocument();
  });

  it('renders nothing below two points, where a trend is meaningless', () => {
    const { container } = render(<Sparkline values={[5]} label="Trend" />);
    expect(container.querySelector('svg')).toBeNull();
  });

  it('does not divide by zero on a flat series', () => {
    const { container } = render(<Sparkline values={[5, 5, 5]} label="Flat" />);
    const d = container.querySelector('path')?.getAttribute('d') ?? '';
    expect(d).not.toContain('NaN');
  });
});

describe('KpiCard', () => {
  it('renders label, figure and unit', () => {
    render(<KpiCard label="Within year" value="182" unit="projects" />);
    expect(screen.getByText('Within year')).toBeInTheDocument();
    expect(screen.getByText('182')).toBeInTheDocument();
    expect(screen.getByText('projects')).toBeInTheDocument();
  });

  it('omits the trend row entirely when there is neither delta nor trend', () => {
    const { container } = render(<KpiCard label="Total" value="236" />);
    expect(container.querySelector('svg')).toBeNull();
  });
});

describe('StatCard', () => {
  it('renders its figure in the mono face so columns of cards align', () => {
    const { container } = render(<StatCard label="Spillover" value="14" />);
    expect(container.querySelector('.font-mono')?.textContent).toBe('14');
  });
});

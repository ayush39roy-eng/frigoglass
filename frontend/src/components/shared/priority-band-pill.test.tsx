import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { PriorityBandPill, ProjectPriorityPill } from './priority-band-pill';

describe('PriorityBandPill', () => {
  it('renders the visible label for a scored band', () => {
    render(<PriorityBandPill priority="P1" />);
    expect(screen.getByText('P1')).toBeInTheDocument();
  });

  it('never relies on colour alone — icon-only mode still exposes an accessible label', () => {
    render(<PriorityBandPill priority="Q" iconOnly />);
    expect(screen.getByText('Priority band Q — Unprioritised')).toBeInTheDocument();
  });
});

describe('ProjectPriorityPill (P57, ADR 0067)', () => {
  it('shows a neutral "Not applicable" pill, never the stored band, for Commercialized / Cancelled', () => {
    const { unmount } = render(<ProjectPriorityPill status="Commercialized" priority="P4" />);
    expect(screen.getByTestId('priority-not-applicable')).toHaveTextContent('Not applicable');
    expect(screen.getByTestId('priority-not-applicable')).toHaveAttribute(
      'title',
      'Priority does not apply to Commercialized or Cancelled projects',
    );
    expect(screen.queryByText('P4')).not.toBeInTheDocument();
    unmount();
    render(<ProjectPriorityPill status="Cancelled" priority="P1" short />);
    expect(screen.getByTestId('priority-not-applicable')).toHaveTextContent('N/A');
    expect(screen.queryByText('P1')).not.toBeInTheDocument();
  });

  it('shows the band for any other status, and the fallback when no priority is set', () => {
    const { unmount } = render(<ProjectPriorityPill status="In Queue" priority="P4" />);
    expect(screen.getByText('P4')).toBeInTheDocument();
    expect(screen.queryByTestId('priority-not-applicable')).not.toBeInTheDocument();
    unmount();
    render(<ProjectPriorityPill status="In Queue" priority={null} fallback="—" />);
    expect(screen.getByText('—')).toBeInTheDocument();
  });

  it('a served priority_applicable=false reads "Not applicable" without a status', () => {
    render(<ProjectPriorityPill status={undefined} priority="P2" priorityApplicable={false} />);
    expect(screen.getByTestId('priority-not-applicable')).toBeInTheDocument();
    expect(screen.queryByText('P2')).not.toBeInTheDocument();
  });
});

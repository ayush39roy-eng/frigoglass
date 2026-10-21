import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { ProjectStatusBadge } from './project-status-badge';

describe('ProjectStatusBadge', () => {
  it('renders the status text verbatim', () => {
    render(<ProjectStatusBadge status="In Buyoff" />);
    expect(screen.getByText('In Buyoff')).toBeInTheDocument();
  });

  it('gives On Hold a warning tone (excluded from scheduling)', () => {
    render(<ProjectStatusBadge status="On Hold" data-testid="badge" />);
    expect(screen.getByTestId('badge').className).toContain('bg-warning-subtle');
  });
});

describe('ProjectStatusBadge — P23-T01 hidden statuses still render', () => {
  it('renders In Buyoff and Draft even though no UI list offers them', () => {
    render(
      <>
        <ProjectStatusBadge status="In Buyoff" data-testid="buyoff" />
        <ProjectStatusBadge status="Draft" data-testid="draft" />
      </>,
    );
    expect(screen.getByTestId('buyoff')).toHaveTextContent('In Buyoff');
    expect(screen.getByTestId('draft')).toHaveTextContent('Draft');
  });
});

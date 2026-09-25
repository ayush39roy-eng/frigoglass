import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { Button } from '@/components/ui/button';

import { EmptyState } from './empty-state';

describe('EmptyState', () => {
  it('never renders a blank panel — states what is missing', () => {
    render(<EmptyState title="No projects registered for this hub yet" />);
    expect(screen.getByText('No projects registered for this hub yet')).toBeInTheDocument();
  });

  it('renders an optional description and action', () => {
    render(
      <EmptyState
        title="No projects registered for this hub yet"
        description="Register a project to get started."
        action={<Button>Register a project</Button>}
      />,
    );
    expect(screen.getByText('Register a project to get started.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Register a project' })).toBeInTheDocument();
  });
});

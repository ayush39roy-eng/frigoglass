import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';

import { renderWithProviders } from '@/test/render';

import { AutoAssignPlaceholder } from './auto-assign-placeholder';

describe('AutoAssignPlaceholder', () => {
  it('names the specific blocking open question rather than a generic "coming soon"', () => {
    renderWithProviders(<AutoAssignPlaceholder />);
    expect(screen.getByText('Auto-assign is pending a client decision')).toBeInTheDocument();
    expect(screen.getByText(/OPEN_QUESTIONS\.md #10/)).toBeInTheDocument();
  });
});

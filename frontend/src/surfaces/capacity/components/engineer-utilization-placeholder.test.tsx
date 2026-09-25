import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { EngineerUtilizationPlaceholder } from './engineer-utilization-placeholder';

describe('EngineerUtilizationPlaceholder', () => {
  it('states the per-engineer view is withheld pending the GDPR open question', () => {
    render(<EngineerUtilizationPlaceholder />);
    expect(screen.getByText('Per-engineer utilization pending GDPR sign-off')).toBeInTheDocument();
    expect(screen.getByText(/OPEN_QUESTIONS #8 \/ P4-T08/i)).toBeInTheDocument();
    expect(screen.getByText(/personal data under GDPR/i)).toBeInTheDocument();
  });
});

import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';

import { CapacityReportingNotice } from './capacity-reporting-notice';

describe('CapacityReportingNotice', () => {
  it("states that capacity supply is the client's ADR 0008 formula, which the scheduler does not apply when booking", () => {
    render(<CapacityReportingNotice />);
    expect(screen.getByText('How to read these figures')).toBeInTheDocument();
    expect(screen.getByText(/client.s own supply formula/i)).toBeInTheDocument();
    expect(screen.getByText(/ADR.0008\): a hub work calendar/)).toHaveTextContent(/0002/);
    expect(screen.getByText(/scheduler overbooked anyone/i)).toBeInTheDocument();
  });

  it('is exposed as a labelled region for assistive tech', () => {
    render(<CapacityReportingNotice />);
    expect(
      screen.getByRole('complementary', {
        name: /how to read the load and capacity figures/i,
      }),
    ).toBeInTheDocument();
  });
});

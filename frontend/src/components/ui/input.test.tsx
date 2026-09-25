import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { Input } from './input';
import { Label } from './label';

describe('Input', () => {
  it('accepts typed text', async () => {
    const user = userEvent.setup();
    render(
      <>
        <Label htmlFor="code">Project code</Label>
        <Input id="code" />
      </>,
    );
    const input = screen.getByLabelText('Project code');
    await user.type(input, '26-00201');
    expect(input).toHaveValue('26-00201');
  });

  it('reflects aria-invalid for hard-gated required fields', () => {
    render(<Input aria-invalid="true" data-testid="capex" />);
    expect(screen.getByTestId('capex')).toHaveAttribute('aria-invalid', 'true');
  });
});

import { describe, expect, it } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';

import { WhatIfPlanner } from './whatif-planner';

describe('What-if planner parts (P32-T06)', () => {
  it('the scenario builder is the default; "Import plan (Excel)" is its own part, loaded on first open and kept', async () => {
    const user = userEvent.setup();
    renderWithProviders(<WhatIfPlanner chambers={[]} />);
    const parts = screen.getByRole('tablist', { name: 'What-if planner parts' });
    expect(parts).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Scenario builder' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByTestId('import-plan-view')).toBeNull();

    await user.click(screen.getByRole('tab', { name: 'Import plan (Excel)' }));
    expect(await screen.findByRole('heading', { name: 'Import plan (Excel)' })).toBeInTheDocument();
    expect(screen.getByTestId('import-upload')).toBeInTheDocument();

    // Switching back keeps both mounted (the builder's results and the import state survive).
    await user.click(screen.getByRole('tab', { name: 'Scenario builder' }));
    expect(screen.getByTestId('import-plan-view')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Estimate' })).toBeInTheDocument();
  });
});

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import { ApiError } from '@/lib/api/client';
import type { ProjectRead } from '../api/types';

const hooks = { useHardGateStatus: vi.fn() };
vi.mock('../hooks/use-registration', () => ({
  useHardGateStatus: (id: string | null) => hooks.useHardGateStatus(id),
}));

import { HardGatePanel } from './hard-gate-panel';

const project: ProjectRead = {
  id: 'p1',
  name: 'Cooler A',
  external_code: null,
  hub_id: 'hub-1',
  leader_engineer_id: null,
  category: null,
  type: null,
  priority: null,
  status: 'Draft',
  frozen: false,
  actual_start_week: null,
  delay_weeks: 0,
  reg_year: null,
  carry_over: false,
  comments: null,
  customer_name: null,
  tcogs_eur: null,
  selling_price_eur: null,
  gross_margin_pct: null,
  capex_keur: null,
  rm_savings_keur: null,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

function ready<T>(data: T) {
  return { data, isPending: false, isError: false, error: null };
}

beforeEach(() => vi.clearAllMocks());

describe('HardGatePanel', () => {
  it('lists the missing fields verbatim from the API and disables submit', () => {
    hooks.useHardGateStatus.mockReturnValue(
      ready({ can_leave_draft: false, missing_fields: ['category', 'TCOGS'] }),
    );
    renderWithProviders(<HardGatePanel project={project} onSubmit={vi.fn()} />);
    expect(screen.getByText('category')).toBeInTheDocument();
    expect(screen.getByText('TCOGS')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /submit/i })).toBeDisabled();
  });

  it('enables submit once the API reports can_leave_draft', async () => {
    const user = userEvent.setup();
    hooks.useHardGateStatus.mockReturnValue(ready({ can_leave_draft: true, missing_fields: [] }));
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderWithProviders(<HardGatePanel project={project} onSubmit={onSubmit} />);

    const button = screen.getByRole('button', { name: /submit/i });
    expect(button).not.toBeDisabled();
    await user.click(button);
    expect(onSubmit).toHaveBeenCalledWith('p1', 'In Queue');
  });

  it('surfaces a 403 as a role-specific message', async () => {
    const user = userEvent.setup();
    hooks.useHardGateStatus.mockReturnValue(ready({ can_leave_draft: true, missing_fields: [] }));
    const onSubmit = vi.fn().mockRejectedValue(new ApiError(403, 'forbidden'));
    renderWithProviders(<HardGatePanel project={project} onSubmit={onSubmit} />);

    await user.click(screen.getByRole('button', { name: /submit/i }));
    expect(await screen.findByText(/cannot submit projects out of Draft/i)).toBeInTheDocument();
  });

  it('surfaces a non-forbidden ApiError detail (e.g. still-missing fields) verbatim', async () => {
    const user = userEvent.setup();
    hooks.useHardGateStatus.mockReturnValue(ready({ can_leave_draft: true, missing_fields: [] }));
    const onSubmit = vi
      .fn()
      .mockRejectedValue(new ApiError(422, 'unprocessable', 'gross_margin_pct is required'));
    renderWithProviders(<HardGatePanel project={project} onSubmit={onSubmit} />);

    await user.click(screen.getByRole('button', { name: /submit/i }));
    expect(await screen.findByText('gross_margin_pct is required')).toBeInTheDocument();
  });

  it('falls back to a generic message for a non-ApiError failure', async () => {
    const user = userEvent.setup();
    hooks.useHardGateStatus.mockReturnValue(ready({ can_leave_draft: true, missing_fields: [] }));
    const onSubmit = vi.fn().mockRejectedValue(new Error('network down'));
    renderWithProviders(<HardGatePanel project={project} onSubmit={onSubmit} />);

    await user.click(screen.getByRole('button', { name: /submit/i }));
    expect(
      await screen.findByText('The project could not be submitted. Please try again.'),
    ).toBeInTheDocument();
  });

  it('shows a loading skeleton while the hard-gate status is pending', () => {
    hooks.useHardGateStatus.mockReturnValue({ data: undefined, isPending: true, isError: false, error: null });
    renderWithProviders(<HardGatePanel project={project} onSubmit={vi.fn()} />);
    expect(screen.getByRole('status')).toHaveAttribute('aria-busy', 'true');
  });

  it('shows an alert when the hard-gate status fails to load', () => {
    hooks.useHardGateStatus.mockReturnValue({
      data: undefined,
      isPending: false,
      isError: true,
      error: new Error('boom'),
    });
    renderWithProviders(<HardGatePanel project={project} onSubmit={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent('The hard-gate status could not be loaded.');
  });

  it('lets the user change the target status before submitting', async () => {
    const user = userEvent.setup();
    hooks.useHardGateStatus.mockReturnValue(ready({ can_leave_draft: true, missing_fields: [] }));
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    renderWithProviders(<HardGatePanel project={project} onSubmit={onSubmit} />);

    await user.click(screen.getByRole('combobox', { name: /Target status/i }));
    await user.click(await screen.findByRole('option', { name: 'In Development' }));
    await user.click(screen.getByRole('button', { name: /submit/i }));

    expect(onSubmit).toHaveBeenCalledWith('p1', 'In Development');
  });
});

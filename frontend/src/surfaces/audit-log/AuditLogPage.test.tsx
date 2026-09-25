import { describe, expect, it, vi, beforeEach } from 'vitest';
import { screen } from '@testing-library/react';

import { renderWithProviders } from '@/test/render';
import { ApiError } from '@/lib/api/client';
import type { AuditLogEntryList } from './api/types';

const hooks = { useAuditLog: vi.fn() };

vi.mock('./hooks/use-audit-log', () => ({
  useAuditLog: (params: unknown) => hooks.useAuditLog(params),
}));
vi.mock('@/lib/api/reference', () => ({
  useHubs: () => ({ data: [{ id: 'hub-1', name: 'R&D-Greece', lab_region: 'Greece', is_oem: false }] }),
}));
vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 44,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ key: index, index, start: index * 44, size: 44 })),
    measureElement: () => undefined,
    measure: () => undefined,
  }),
}));

import AuditLogPage from './AuditLogPage';

function pending() {
  return { data: undefined, isPending: true, isError: false, error: null, refetch: vi.fn() };
}
function ready(data: AuditLogEntryList) {
  return { data, isPending: false, isError: false, error: null, refetch: vi.fn() };
}
function failed(error: Error) {
  return { data: undefined, isPending: false, isError: true, error, refetch: vi.fn() };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AuditLogPage', () => {
  it('always renders the surface heading and filter controls', () => {
    hooks.useAuditLog.mockReturnValue(pending());
    renderWithProviders(<AuditLogPage />);
    expect(screen.getByRole('heading', { name: 'Audit Log' })).toBeInTheDocument();
    expect(screen.getByLabelText('Entity type')).toBeInTheDocument();
    expect(screen.getByLabelText('Actor user ID')).toBeInTheDocument();
    expect(screen.getByLabelText('Hub')).toBeInTheDocument();
  });

  it('degrades to an access notice on a 403 rather than a wall of errors', () => {
    hooks.useAuditLog.mockReturnValue(failed(new ApiError(403, 'forbidden')));
    renderWithProviders(<AuditLogPage />);
    expect(screen.getByText(/does not have access to the Audit Log/i)).toBeInTheDocument();
    expect(screen.queryByLabelText('Entity type')).not.toBeInTheDocument();
  });

  it('renders returned entries and the total count', () => {
    hooks.useAuditLog.mockReturnValue(
      ready({
        items: [
          {
            id: 'entry-1',
            occurred_at: '2026-09-01T10:00:00.000Z',
            actor_user_id: null,
            action: 'project.create',
            entity_type: 'Project',
            entity_id: 'proj-1',
            hub_id: 'hub-1',
            before_state: null,
            after_state: { name: 'X' },
            request_id: null,
            ip_address: null,
            notes: null,
          },
        ],
        total_count: 1,
        limit: 100,
        offset: 0,
      }),
    );
    renderWithProviders(<AuditLogPage />);
    expect(screen.getByText('project.create')).toBeInTheDocument();
    expect(screen.getByText('1–1 of 1')).toBeInTheDocument();
  });

  it('shows an empty state when no entries match', () => {
    hooks.useAuditLog.mockReturnValue(ready({ items: [], total_count: 0, limit: 100, offset: 0 }));
    renderWithProviders(<AuditLogPage />);
    expect(screen.getByText('No audit entries recorded yet')).toBeInTheDocument();
  });
});

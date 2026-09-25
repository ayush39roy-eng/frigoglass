import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 44,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        key: index,
        index,
        start: index * 44,
        size: 44,
      })),
    measureElement: () => undefined,
    measure: () => undefined,
  }),
}));

import { AuditLogTable, type AuditLogRow } from './audit-log-table';

const rows: AuditLogRow[] = [
  {
    id: 'entry-1',
    occurred_at: '2026-09-01T10:00:00.000Z',
    actor_user_id: '11111111-2222-3333-4444-555555555555',
    action: 'project.create',
    entity_type: 'Project',
    entity_id: 'proj-abcdef12',
    hub_id: 'hub-1',
    hubName: 'R&D-Greece',
    before_state: null,
    after_state: { name: 'X', customer_name: 'Coca-Cola HBC', tcogs_eur: 123.45 },
    request_id: 'req-1',
    ip_address: '10.0.0.1',
    notes: null,
  },
  {
    id: 'entry-2',
    occurred_at: '2026-09-02T10:00:00.000Z',
    actor_user_id: null,
    action: 'schedule_run.greedy_recalc',
    entity_type: 'ScheduleRun',
    entity_id: 'run-1',
    hub_id: null,
    hubName: null,
    before_state: null,
    after_state: null,
    request_id: null,
    ip_address: null,
    notes: null,
  },
];

describe('AuditLogTable', () => {
  it('renders one row per audit-log entry via the virtualizer', () => {
    render(<AuditLogTable rows={rows} expandedId={null} onToggleExpand={vi.fn()} />);
    expect(screen.getByRole('table', { name: 'Audit log entries' })).toHaveAttribute(
      'aria-rowcount',
      '2',
    );
    expect(screen.getByText('project.create')).toBeInTheDocument();
    expect(screen.getByText('schedule_run.greedy_recalc')).toBeInTheDocument();
  });

  it('shows "System" for a null actor_user_id rather than a blank cell', () => {
    render(<AuditLogTable rows={rows} expandedId={null} onToggleExpand={vi.fn()} />);
    expect(screen.getByText('System')).toBeInTheDocument();
  });

  it('calls onToggleExpand with the row id when its expand control is clicked', async () => {
    const onToggleExpand = vi.fn();
    const user = userEvent.setup();
    render(<AuditLogTable rows={rows} expandedId={null} onToggleExpand={onToggleExpand} />);
    await user.click(screen.getByRole('button', { name: 'Expand entry entry-1' }));
    expect(onToggleExpand).toHaveBeenCalledWith('entry-1');
  });

  it('renders the redacted after_state (never the real financial value) when expanded', () => {
    render(<AuditLogTable rows={rows} expandedId="entry-1" onToggleExpand={vi.fn()} />);
    expect(screen.getByText(/"customer_name": "<redacted>"/)).toBeInTheDocument();
    expect(screen.getByText(/"tcogs_eur": "<redacted>"/)).toBeInTheDocument();
    expect(screen.queryByText(/Coca-Cola HBC/)).not.toBeInTheDocument();
    expect(screen.queryByText(/123\.45/)).not.toBeInTheDocument();
  });

  it('shows "Not recorded" for a null before_state instead of an empty panel', () => {
    render(<AuditLogTable rows={rows} expandedId="entry-1" onToggleExpand={vi.fn()} />);
    expect(screen.getByText('Not recorded')).toBeInTheDocument();
  });
});

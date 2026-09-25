import { describe, expect, it, vi } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { renderWithProviders } from '@/test/render';
import type { NotificationListResponse, NotificationRead } from '@/lib/api/notifications';

const hooks = {
  useNotifications: vi.fn(),
  useMarkNotificationRead: vi.fn(),
  useMarkAllNotificationsRead: vi.fn(),
};
vi.mock('@/lib/api/notifications', async () => {
  const actual = await vi.importActual<typeof import('@/lib/api/notifications')>(
    '@/lib/api/notifications',
  );
  return {
    ...actual,
    useNotifications: () => hooks.useNotifications(),
    useMarkNotificationRead: () => hooks.useMarkNotificationRead(),
    useMarkAllNotificationsRead: () => hooks.useMarkAllNotificationsRead(),
  };
});

import { NotificationBell } from './notification-bell';

function pendingQuery() {
  return { data: undefined, isPending: true, isError: false, refetch: vi.fn() };
}
function readyQuery(data: NotificationListResponse) {
  return { data, isPending: false, isError: false, refetch: vi.fn() };
}
function erroredQuery(refetch = vi.fn()) {
  return { data: undefined, isPending: false, isError: true, refetch };
}

function mutation(mutate = vi.fn(), overrides: Record<string, unknown> = {}) {
  return { mutate, mutateAsync: vi.fn(), isPending: false, variables: undefined, ...overrides };
}

function notification(overrides: Partial<NotificationRead> = {}): NotificationRead {
  return {
    id: 'n1',
    reason: 'delay_introduced',
    project_id: 'p1',
    hub_id: 'h1',
    message: 'Project Alpha delayed to week 41',
    schedule_run_id: 'r2',
    previous_schedule_run_id: 'r1',
    read_at: null,
    created_at: '2026-09-04T09:00:00Z',
    ...overrides,
  };
}

function list(overrides: Partial<NotificationListResponse> = {}): NotificationListResponse {
  return { items: [], total_count: 0, unread_count: 0, limit: 20, offset: 0, ...overrides };
}

describe('NotificationBell', () => {
  it('renders the bell with no badge when there are zero unread notifications', () => {
    hooks.useNotifications.mockReturnValue(readyQuery(list()));
    hooks.useMarkNotificationRead.mockReturnValue(mutation());
    hooks.useMarkAllNotificationsRead.mockReturnValue(mutation());

    renderWithProviders(<NotificationBell />);

    const trigger = screen.getByRole('button', { name: 'Notifications' });
    expect(trigger).toBeInTheDocument();
    expect(within(trigger).queryByText(/\d/)).not.toBeInTheDocument();
  });

  it('shows an unread-count badge on the bell when unread_count > 0', () => {
    hooks.useNotifications.mockReturnValue(
      readyQuery(list({ unread_count: 3, items: [notification()] })),
    );
    hooks.useMarkNotificationRead.mockReturnValue(mutation());
    hooks.useMarkAllNotificationsRead.mockReturnValue(mutation());

    renderWithProviders(<NotificationBell />);

    expect(screen.getByRole('button', { name: 'Notifications, 3 unread' })).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('caps the visible badge count at "99+"', () => {
    hooks.useNotifications.mockReturnValue(readyQuery(list({ unread_count: 140 })));
    hooks.useMarkNotificationRead.mockReturnValue(mutation());
    hooks.useMarkAllNotificationsRead.mockReturnValue(mutation());

    renderWithProviders(<NotificationBell />);

    expect(screen.getByText('99+')).toBeInTheDocument();
  });

  it('opens the panel on click and lists notifications with message, reason, and timestamp', async () => {
    hooks.useNotifications.mockReturnValue(
      readyQuery(list({ unread_count: 1, items: [notification()] })),
    );
    hooks.useMarkNotificationRead.mockReturnValue(mutation());
    hooks.useMarkAllNotificationsRead.mockReturnValue(mutation());
    const user = userEvent.setup();

    renderWithProviders(<NotificationBell />);
    await user.click(screen.getByRole('button', { name: 'Notifications, 1 unread' }));

    expect(await screen.findByText('Project Alpha delayed to week 41')).toBeInTheDocument();
    expect(screen.getByText('Delay introduced')).toBeInTheDocument();
    expect(screen.getByText(/2026/)).toBeInTheDocument();
  });

  it('marks a single notification read via its row action', async () => {
    const mutate = vi.fn();
    hooks.useNotifications.mockReturnValue(
      readyQuery(list({ unread_count: 1, items: [notification()] })),
    );
    hooks.useMarkNotificationRead.mockReturnValue(mutation(mutate));
    hooks.useMarkAllNotificationsRead.mockReturnValue(mutation());
    const user = userEvent.setup();

    renderWithProviders(<NotificationBell />);
    await user.click(screen.getByRole('button', { name: 'Notifications, 1 unread' }));
    await user.click(await screen.findByRole('button', { name: 'Mark read' }));

    expect(mutate).toHaveBeenCalledWith('n1');
  });

  it('does not show a row action for an already-read notification', async () => {
    hooks.useNotifications.mockReturnValue(
      readyQuery(list({ unread_count: 0, items: [notification({ read_at: '2026-09-04T09:30:00Z' })] })),
    );
    hooks.useMarkNotificationRead.mockReturnValue(mutation());
    hooks.useMarkAllNotificationsRead.mockReturnValue(mutation());
    const user = userEvent.setup();

    renderWithProviders(<NotificationBell />);
    await user.click(screen.getByRole('button', { name: 'Notifications' }));

    expect(await screen.findByText('Project Alpha delayed to week 41')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mark read' })).not.toBeInTheDocument();
  });

  it('marks all read via the header action, disabled when there is nothing unread', async () => {
    const mutate = vi.fn();
    hooks.useNotifications.mockReturnValue(
      readyQuery(list({ unread_count: 2, items: [notification(), notification({ id: 'n2' })] })),
    );
    hooks.useMarkNotificationRead.mockReturnValue(mutation());
    hooks.useMarkAllNotificationsRead.mockReturnValue(mutation(mutate));
    const user = userEvent.setup();

    renderWithProviders(<NotificationBell />);
    await user.click(screen.getByRole('button', { name: 'Notifications, 2 unread' }));
    const markAll = await screen.findByRole('button', { name: 'Mark all read' });
    expect(markAll).toBeEnabled();
    await user.click(markAll);
    expect(mutate).toHaveBeenCalledTimes(1);
  });

  it('disables "Mark all read" when unread_count is zero', async () => {
    hooks.useNotifications.mockReturnValue(readyQuery(list({ unread_count: 0 })));
    hooks.useMarkNotificationRead.mockReturnValue(mutation());
    hooks.useMarkAllNotificationsRead.mockReturnValue(mutation());
    const user = userEvent.setup();

    renderWithProviders(<NotificationBell />);
    await user.click(screen.getByRole('button', { name: 'Notifications' }));

    expect(await screen.findByRole('button', { name: 'Mark all read' })).toBeDisabled();
  });

  it('shows a loading skeleton while the first fetch is pending', async () => {
    hooks.useNotifications.mockReturnValue(pendingQuery());
    hooks.useMarkNotificationRead.mockReturnValue(mutation());
    hooks.useMarkAllNotificationsRead.mockReturnValue(mutation());
    const user = userEvent.setup();

    renderWithProviders(<NotificationBell />);
    await user.click(screen.getByRole('button', { name: 'Notifications' }));

    expect(await screen.findAllByRole('status')).not.toHaveLength(0);
  });

  it('shows a retryable error state when the fetch fails', async () => {
    const refetch = vi.fn();
    hooks.useNotifications.mockReturnValue(erroredQuery(refetch));
    hooks.useMarkNotificationRead.mockReturnValue(mutation());
    hooks.useMarkAllNotificationsRead.mockReturnValue(mutation());
    const user = userEvent.setup();

    renderWithProviders(<NotificationBell />);
    await user.click(screen.getByRole('button', { name: 'Notifications' }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be loaded/i);
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it('shows an empty state when there are no notifications at all', async () => {
    hooks.useNotifications.mockReturnValue(readyQuery(list()));
    hooks.useMarkNotificationRead.mockReturnValue(mutation());
    hooks.useMarkAllNotificationsRead.mockReturnValue(mutation());
    const user = userEvent.setup();

    renderWithProviders(<NotificationBell />);
    await user.click(screen.getByRole('button', { name: 'Notifications' }));

    expect(await screen.findByText('No notifications')).toBeInTheDocument();
  });
});

import * as React from 'react';
import { Bell, Check, CheckCheck } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/shared/empty-state';
import { ErrorState } from '@/components/shared/error-state';
import {
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotifications,
  type NotificationRead,
} from '@/lib/api/notifications';
import { formatTimestamp } from '@/lib/format';
import { cn } from '@/lib/utils';

import { NOTIFICATION_REASON_META } from './notification-reason-meta';

/**
 * App-shell notification bell (P5-T09) — mounted once in `AppHeader` so it is
 * reachable from every surface, not added per-page. Consumes P5-T06's
 * `GET /notifications` / `POST /notifications/{id}/read` /
 * `POST /notifications/read-all` (`backend/api/routers/notifications.py`).
 *
 * **No `AccessNotice`, ever, by design.** Every other cross-surface addition in
 * this codebase (e.g. `DownloadButton`, P5-T08) sits behind an existing
 * `denied ? <AccessNotice/> : ...` branch because its endpoint requires a
 * per-surface `Surface`/`Action` permission. Notifications endpoints are gated
 * on `get_current_principal` only (`api/routers/notifications.py`'s module
 * docstring) — every authenticated user, including a role that is never
 * resolved as a recipient of anything, is allowed to read/manage their own
 * inbox. There is nothing to gate here: an empty list is the correct outcome
 * for such a user, not a permissions error, so this component never renders a
 * denial state.
 *
 * The single `useNotifications()` query (polled — see `lib/api/notifications.ts`)
 * drives BOTH the badge count and the dropdown list, per the backend's own
 * `unread_count`-always-present design — there is no second "just the count"
 * request.
 */
export function NotificationBell(): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const notificationsQuery = useNotifications();
  const markReadMutation = useMarkNotificationRead();
  const markAllReadMutation = useMarkAllNotificationsRead();

  const unreadCount = notificationsQuery.data?.unread_count ?? 0;
  const badgeText = unreadCount > 99 ? '99+' : String(unreadCount);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative"
          aria-label={unreadCount > 0 ? `Notifications, ${String(unreadCount)} unread` : 'Notifications'}
        >
          <Bell />
          {unreadCount > 0 ? (
            <Badge
              tone="danger"
              aria-hidden="true"
              className="absolute -right-1 -top-1 min-w-[1.05rem] justify-center rounded-full border-transparent px-1 py-0 text-[10px] leading-[1.05rem]"
            >
              {badgeText}
            </Badge>
          ) : null}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-0">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-sm font-semibold text-text">Notifications</span>
          <Button
            variant="ghost"
            size="sm"
            disabled={unreadCount === 0 || markAllReadMutation.isPending}
            onClick={() => markAllReadMutation.mutate()}
          >
            <CheckCheck />
            Mark all read
          </Button>
        </div>
        <div className="max-h-96 overflow-y-auto p-2">
          <NotificationListBody
            query={notificationsQuery}
            onMarkRead={(id) => markReadMutation.mutate(id)}
            pendingMarkReadId={
              markReadMutation.isPending ? (markReadMutation.variables ?? null) : null
            }
          />
        </div>
      </PopoverContent>
    </Popover>
  );
}

function NotificationListBody({
  query,
  onMarkRead,
  pendingMarkReadId,
}: {
  query: ReturnType<typeof useNotifications>;
  onMarkRead: (id: string) => void;
  pendingMarkReadId: string | null;
}): React.JSX.Element {
  if (query.isPending) {
    return (
      <div className="space-y-2 p-1" aria-busy="true">
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-full" />
        <Skeleton className="h-12 w-5/6" />
      </div>
    );
  }

  if (query.isError) {
    return (
      <ErrorState
        className="border-none bg-transparent px-3 py-6"
        description="Notifications could not be loaded."
        onRetry={() => void query.refetch()}
      />
    );
  }

  const items = query.data.items;
  if (items.length === 0) {
    return (
      <EmptyState
        className="border-none bg-transparent px-3 py-6"
        title="No notifications"
        description="You're all caught up — schedule changes affecting your hub or projects will appear here."
      />
    );
  }

  return (
    <ul className="space-y-1">
      {items.map((notification) => (
        <NotificationRow
          key={notification.id}
          notification={notification}
          onMarkRead={onMarkRead}
          pending={pendingMarkReadId === notification.id}
        />
      ))}
    </ul>
  );
}

function NotificationRow({
  notification,
  onMarkRead,
  pending,
}: {
  notification: NotificationRead;
  onMarkRead: (id: string) => void;
  pending: boolean;
}): React.JSX.Element {
  const unread = notification.read_at === null;
  const meta = NOTIFICATION_REASON_META[notification.reason];

  return (
    <li
      className={cn('rounded-md px-2 py-2 text-xs', unread && 'bg-primary-subtle/40')}
      data-testid="notification-row"
      data-unread={unread ? '' : undefined}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 space-y-1">
          <p className={cn('text-text', unread ? 'font-medium' : 'font-normal text-text-muted')}>
            {notification.message}
          </p>
          <div className="flex items-center gap-1.5">
            <Badge tone={meta.tone}>
              <meta.Icon className="size-3" aria-hidden="true" />
              {meta.label}
            </Badge>
            <time
              className="text-2xs text-text-subtle"
              dateTime={notification.created_at}
              title={formatTimestamp(notification.created_at)}
            >
              {formatTimestamp(notification.created_at)}
            </time>
          </div>
        </div>
        {unread ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 shrink-0 px-1.5 text-2xs"
            disabled={pending}
            onClick={() => onMarkRead(notification.id)}
          >
            <Check className="size-3" aria-hidden="true" />
            Mark read
          </Button>
        ) : null}
      </div>
    </li>
  );
}

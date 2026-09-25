/**
 * In-app notifications (P5-T06 backend / P5-T09 frontend) — `GET /notifications`,
 * `POST /notifications/{id}/read`, `POST /notifications/read-all`
 * (`backend/api/routers/notifications.py`). Cross-cutting, not owned by any one
 * surface — every authenticated user has their own inbox, visible from the app
 * shell header on every surface — so this lives next to `lib/api/reference.ts`
 * (the other cross-cutting, non-surface-owned API module), not under
 * `surfaces/*\/api/`.
 *
 * PLACEHOLDER types until the OpenAPI client is generated (src/lib/api/README.md),
 * hand-authored to mirror `backend/schemas/notification.py` field-for-field.
 *
 * **No RBAC gate here, deliberately** — unlike every other `lib/api/*`/
 * `surfaces/*` module, these three endpoints are gated on `get_current_principal`
 * only (see `api/routers/notifications.py`'s module docstring): every signed-in
 * user, including a role that reads no surface at all, can read/manage their own
 * inbox. There is therefore no `AccessNotice` fallback anywhere in this feature —
 * an empty list for a role that was never resolved as a recipient of anything is
 * the correct "nothing to show you" outcome, not a permissions error.
 *
 * No financial field ever appears here — `NotificationRead.message` is composed
 * server-side from project/hub names and plain week numbers only (see
 * `backend/models/notification.py`'s module docstring).
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { queryKeys } from '@/lib/query-keys';
import type { Id } from '@/types/common';
import type { NotificationReason } from '@/types/enums';

import { apiGet, apiSend, ApiError, type ApiRequestOptions } from './client';

/** One row of `GET /notifications` (→ `backend/schemas/notification.py::NotificationRead`). */
export interface NotificationRead {
  id: Id;
  reason: NotificationReason;
  project_id: Id;
  hub_id: Id;
  message: string;
  schedule_run_id: Id;
  previous_schedule_run_id: Id | null;
  read_at: string | null;
  created_at: string;
}

/**
 * `GET /notifications` response (→ `NotificationList`). `unread_count` ALWAYS
 * reflects the caller's total unread count regardless of the `unread_only`
 * filter — this is what lets a single fetch drive both the header badge and
 * the dropdown list without a second request (see the backend schema's own
 * docstring).
 */
export interface NotificationListResponse {
  items: NotificationRead[];
  total_count: number;
  unread_count: number;
  limit: number;
  offset: number;
}

/** `POST /notifications/{id}/read` response. Idempotent — re-marking an
 *  already-read notification returns its existing `read_at` unchanged. */
export interface NotificationMarkReadResponse {
  id: Id;
  read_at: string;
}

/** `POST /notifications/read-all` response. */
export interface NotificationMarkAllReadResponse {
  marked_count: number;
}

type FetchCtx = Pick<ApiRequestOptions, 'signal'>;

/**
 * Fixed at a single page of the caller's most-recent notifications
 * (unread-first-then-newest, per the backend's own ordering) — this feature is
 * a compact header dropdown, not a paginated inbox surface, so there is no UI
 * control that would ever need `offset` > 0 or a narrower `limit`.
 */
const NOTIFICATIONS_PAGE_LIMIT = 20;

export function fetchNotifications(ctx: FetchCtx = {}): Promise<NotificationListResponse> {
  return apiGet<NotificationListResponse>('/notifications', {
    ...ctx,
    query: { limit: NOTIFICATIONS_PAGE_LIMIT, offset: 0 },
  });
}

export function markNotificationRead(id: Id): Promise<NotificationMarkReadResponse> {
  return apiSend<NotificationMarkReadResponse>('POST', `/notifications/${id}/read`);
}

export function markAllNotificationsRead(): Promise<NotificationMarkAllReadResponse> {
  return apiSend<NotificationMarkAllReadResponse>('POST', '/notifications/read-all');
}

/** Do not retry an auth failure — a 401 will not fix itself on retry (there is
 *  no 403 case here; every authenticated user can call this endpoint). */
function retryUnlessAuth(failureCount: number, error: Error): boolean {
  if (error instanceof ApiError && (error.isForbidden || error.isUnauthorized)) return false;
  return failureCount < 1;
}

/**
 * No existing `refetchInterval` precedent anywhere in this codebase (grepped
 * first, per this task's brief — zero hits); this is the first poller.
 * 60 seconds: double `lib/query-client.ts`'s own 30s default `staleTime`,
 * matching that file's stated posture ("data is not real-time... but a stale
 * view is a correctness problem" — here, "a correctness problem" only in the
 * loose sense of a user missing a delay/left-out/conflict notice for up to a
 * minute, not an Invariant I9 schedule-number problem). Frequent enough that a
 * new notification appears within the session without a manual refresh; not so
 * frequent that every open tab hammers the backend for a low-urgency, in-app-
 * only feed (no SSE/push — see `api/routers/notifications.py`'s own module
 * docstring for why). `refetchIntervalInBackground` is left at its default
 * `false` — a backgrounded/hidden tab does not need this.
 */
const NOTIFICATIONS_POLL_INTERVAL_MS = 60_000;

/**
 * Mounted once, unconditionally, in the app shell header (`NotificationBell`)
 * so both the badge count and the dropdown list are driven by the same single
 * `GET /notifications` response — never a second, independent count request.
 */
export function useNotifications() {
  return useQuery({
    queryKey: queryKeys.notifications(),
    queryFn: ({ signal }) => fetchNotifications({ signal }),
    retry: retryUnlessAuth,
    refetchInterval: NOTIFICATIONS_POLL_INTERVAL_MS,
  });
}

export function useMarkNotificationRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: Id) => markNotificationRead(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.notifications() });
    },
  });
}

export function useMarkAllNotificationsRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => markAllNotificationsRead(),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.notifications() });
    },
  });
}

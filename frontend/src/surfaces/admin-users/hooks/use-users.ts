/**
 * TanStack Query hooks for the User / Role Admin surface (P9-T04). Keys from
 * `lib/query-keys.ts`; hooks return raw API payloads.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { queryKeys } from '@/lib/query-keys';

import { createUser, fetchRoles, fetchUsers, retryUnlessAuth, updateUser, type UserListParams } from '../api/users-api';
import type { UserCreateRequest, UserUpdateRequest } from '../api/types';

export function useUsers(params: UserListParams) {
  return useQuery({
    // Search + pagination inputs go in the key so a change never serves a stale page.
    queryKey: queryKeys.users({ q: params.q, limit: params.limit ?? 100, offset: params.offset ?? 0 }),
    queryFn: ({ signal }) => fetchUsers(params, { signal }),
    retry: retryUnlessAuth,
    placeholderData: (prev) => prev,
  });
}

/**
 * The widest single page of users (server max `limit=200` —
 * `api/routers/users.py`) for the Project Access tab's user picker and the
 * grant table's user/granted-by name join. A deployment with more than 200
 * users would miss some names here (falling back to a raw id — see
 * `ProjectAccessTab`'s `resolveUser`); acceptable for this on-premise tool's
 * expected scale and flagged here rather than silently assumed.
 */
export function useUsersForPicker() {
  return useQuery({
    queryKey: queryKeys.usersForPicker(),
    queryFn: ({ signal }) => fetchUsers({ limit: 200 }, { signal }),
    retry: retryUnlessAuth,
    staleTime: 60_000,
  });
}

export function useRoles() {
  return useQuery({
    queryKey: queryKeys.roles(),
    queryFn: ({ signal }) => fetchRoles({ signal }),
    retry: retryUnlessAuth,
    staleTime: 10 * 60_000,
  });
}

export function useCreateUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UserCreateRequest) => createUser(body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['users'] });
    },
  });
}

export function useUpdateUser() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ userId, body }: { userId: string; body: UserUpdateRequest }) =>
      updateUser(userId, body),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['users'] });
    },
  });
}

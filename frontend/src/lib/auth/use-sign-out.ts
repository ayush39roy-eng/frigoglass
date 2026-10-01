import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';

import { setDevUserEmail } from '@/lib/api/dev-user';
import { useSessionStore } from '@/stores/session';

/**
 * Sign out: forget the dev-mode user choice, drop every cached query (so the
 * next user never sees the previous user's hub-scoped data) and return to the
 * login page. Under OIDC there is no server session to end yet — this clears
 * the client side only.
 */
export function useSignOut(): () => void {
  const queryClient = useQueryClient();
  const reset = useSessionStore((s) => s.reset);
  const navigate = useNavigate();
  return React.useCallback(() => {
    setDevUserEmail(null);
    queryClient.clear();
    reset();
    navigate('/login', { replace: true });
  }, [queryClient, reset, navigate]);
}

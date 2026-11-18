import { QueryClient } from '@tanstack/react-query';

import { isSafeToReload } from '@/lib/app-version';
import { useEditSessionStore } from '@/stores/edit-session';

/**
 * P49-R01 (ADR 0060 R1): whether a surface's state holds an auto reload
 * through the edit-session store. A fresh QueryClient has no mutation, so
 * only the store (and an open dialog) can make `isSafeToReload` false.
 */
export function editSessionHeld(): boolean {
  return useEditSessionStore.getState().editors.size > 0;
}

export function autoReloadAllowed(): boolean {
  return isSafeToReload(new QueryClient());
}

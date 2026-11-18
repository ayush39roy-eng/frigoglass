import * as React from 'react';
import { useQueryClient } from '@tanstack/react-query';

import type { EditConflict } from '@/lib/api/edit-conflict';
import { useHubs } from '@/lib/api/reference';

/**
 * P47-T03 (ADR 0059 C2): the conflict dialog's readable form of a project's
 * hub and leader ids, looked up in lists the app already holds (the served
 * hubs, any cached `['engineers', …]` list). Display only; an id that is not
 * found is shown as served.
 */
export function useProjectConflictFormat(): (conflict: EditConflict, value: unknown) => string | null {
  const queryClient = useQueryClient();
  const hubs = useHubs().data;
  return React.useCallback(
    (conflict: EditConflict, value: unknown) => {
      if (typeof value !== 'string') return null;
      if (conflict.field === 'hub_id') return hubs?.find((h) => h.id === value)?.name ?? null;
      if (conflict.field === 'leader_engineer_id') {
        for (const [, data] of queryClient.getQueriesData<unknown>({ queryKey: ['engineers'] })) {
          if (!Array.isArray(data)) continue;
          const hit = (data as { id?: unknown; name?: unknown }[]).find((e) => e.id === value);
          if (hit && typeof hit.name === 'string') return hit.name;
        }
      }
      return null;
    },
    [queryClient, hubs],
  );
}

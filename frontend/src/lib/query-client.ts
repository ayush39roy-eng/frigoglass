import { QueryClient } from '@tanstack/react-query';

/**
 * Shared QueryClient config. Conservative defaults for an internal planning tool:
 * data is not real-time, but a stale schedule/capacity view after an Apply is a
 * correctness problem, so invalidation (not short staleTime) is the mechanism —
 * see lib/query-keys.ts.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        retry: 1,
        refetchOnWindowFocus: false,
      },
      mutations: {
        retry: 0,
      },
    },
  });
}

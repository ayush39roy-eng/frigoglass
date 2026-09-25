import * as React from 'react';
import type { UseQueryResult } from '@tanstack/react-query';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { ErrorState } from '@/components/shared/error-state';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Renders one surface panel's loading / error / ready states from a single
 * query, so one failing panel never takes the whole surface down.
 *
 * Cross-surface infrastructure (lifted from the Dashboard in P4-T03): the
 * Dashboard, Capacity, and later the Matrix all compose their surfaces from
 * several independent read queries and need the same per-panel isolation.
 */
export interface SectionBoundaryProps<T> {
  query: UseQueryResult<T>;
  title: string;
  errorDescription: string;
  children: (data: T) => React.ReactNode;
}

export function SectionBoundary<T>({
  query,
  title,
  errorDescription,
  children,
}: SectionBoundaryProps<T>): React.JSX.Element {
  if (query.isPending) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2" aria-busy="true">
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-5/6" />
          <Skeleton className="h-8 w-4/6" />
        </CardContent>
      </Card>
    );
  }

  if (query.isError) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>{title}</CardTitle>
        </CardHeader>
        <CardContent>
          <ErrorState description={errorDescription} onRetry={() => void query.refetch()} />
        </CardContent>
      </Card>
    );
  }

  return <>{children(query.data)}</>;
}

import * as React from 'react';

import type { SurfaceNavItem } from '@/app/nav';
import { PageHeader } from '@/components/layout/page-header';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';

/**
 * Stand-in for a not-yet-built surface. The real surfaces (P4-T02..T07) are blocked
 * on P3's API contracts — this page names the owning task and shows the design-system
 * scaffolding (PageHeader + Card + Skeleton) that surface will be built on.
 */
export function PlaceholderPage({ surface }: { surface: SurfaceNavItem }): React.JSX.Element {
  React.useEffect(() => {
    document.title = `${surface.title} — RPD`;
  }, [surface.title]);

  return (
    <>
      <PageHeader
        title={surface.title}
        description={surface.summary}
        actions={<Badge tone="outline">{surface.task}</Badge>}
      />
      <Card>
        <CardHeader>
          <CardTitle>Not built yet</CardTitle>
          <Badge tone="warning">Coming in {surface.task}</Badge>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-text-muted">
            This surface is scheduled for <span className="font-medium text-text">{surface.task}</span>{' '}
            and is blocked on the P3 API layer. P4-T01 delivers only the design system and the app
            shell.
          </p>
          <div className="space-y-2" aria-hidden="true">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="h-8 w-5/6" />
            <Skeleton className="h-8 w-4/6" />
          </div>
        </CardContent>
      </Card>
    </>
  );
}

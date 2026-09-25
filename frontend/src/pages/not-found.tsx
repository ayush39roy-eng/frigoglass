import * as React from 'react';
import { Link, useRouteError } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/shared/empty-state';

/** 404 route + the router `errorElement` fallback. */
export function NotFound({ isRouteError = false }: { isRouteError?: boolean }): React.JSX.Element {
  React.useEffect(() => {
    document.title = 'Not found — RPD';
  }, []);

  return (
    <div className="p-4">
      <EmptyState
        title={isRouteError ? 'This page hit an error' : 'Page not found'}
        description={
          isRouteError
            ? 'Something went wrong while rendering this route. Return to the dashboard and try again.'
            : 'The address you followed does not match any surface in this application.'
        }
        action={
          <Button asChild variant="secondary" size="sm">
            <Link to="/">Back to dashboard</Link>
          </Button>
        }
      />
    </div>
  );
}

/** Router `errorElement` — reads the thrown route error but never renders it verbatim. */
export function RouteErrorBoundary(): React.JSX.Element {
  const error = useRouteError();
  console.error('[route error]', error);
  return <NotFound isRouteError />;
}

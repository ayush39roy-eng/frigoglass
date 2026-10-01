import * as React from 'react';
import { Link } from 'react-router-dom';
import { Lock } from 'lucide-react';

import { EmptyState } from '@/components/shared/empty-state';
import { Button } from '@/components/ui/button';

/**
 * The 403 page a route guard renders when the session lacks `read` on the
 * surface behind a URL (ADR 0010 §2) — never a blank. Deep links from
 * bookmarks, exports and notifications land here rather than on an empty
 * shell, and the message says which surface and what to do next.
 */
export function ForbiddenPage({ surfaceTitle }: { surfaceTitle: string }): React.JSX.Element {
  React.useEffect(() => {
    document.title = `Not available — RPD`;
  }, []);

  return (
    <div className="p-4" data-testid="forbidden-page">
      <EmptyState
        media={<Lock className="size-8" />}
        title={`Your role does not have access to ${surfaceTitle}`}
        description="This surface is not part of your role's permissions. If you need it, contact your RPD administrator — access is granted per role on the User / Role Admin surface."
        action={
          <Button asChild variant="secondary" size="sm">
            <Link to="/">Back to dashboard</Link>
          </Button>
        }
      />
    </div>
  );
}

import * as React from 'react';
import { Navigate, useLocation, useParams } from 'react-router-dom';

import { REGISTRATION_EDIT_PARAM } from '@/lib/registration-links';

/**
 * P22-T01: Project Registration merged into Projects. `/register` keeps its
 * query (so `/register?edit=<id>` still opens that project's drawer) and
 * `/register/:projectId` becomes `/projects?edit=<id>`. The target route does
 * its own permission check; the drawer only opens with Registration write.
 */
export function RegisterRedirect(): React.JSX.Element {
  const { search, hash } = useLocation();
  const { projectId } = useParams();
  if (projectId) {
    const next = new URLSearchParams(search);
    next.set(REGISTRATION_EDIT_PARAM, projectId);
    return <Navigate to={`/projects?${next.toString()}${hash}`} replace />;
  }
  return <Navigate to={`/projects${search}${hash}`} replace />;
}

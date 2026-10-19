import * as React from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';

import { queryKeys } from '@/lib/query-keys';
import { REGISTRATION_EDIT_PARAM as EDIT_PARAM } from '@/lib/registration-links';

import { fetchProject } from '../api/registration-api';
import type { ProjectRead } from '../api/types';

/** Project ids are UUIDs (`GET /projects/{project_id: uuid}`); anything else is ignored. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Opens the Registration edit form for `?edit=<projectId>` once the project
 * has loaded, then drops the param (so closing the dialog and reloading does
 * not reopen it). Only fetched when `enabled` (the session may write
 * Registration); the server still authorises the eventual PATCH. A value that
 * is not a UUID is never fetched and is dropped from the URL (P13-F11).
 */
export function useEditDeepLink(enabled: boolean, open: (project: ProjectRead) => void): void {
  const [searchParams, setSearchParams] = useSearchParams();
  const projectId = searchParams.get(EDIT_PARAM);
  const isValidId = projectId !== null && UUID_RE.test(projectId);
  const query = useQuery({
    queryKey: queryKeys.project(projectId ?? ''),
    queryFn: ({ signal }) => fetchProject(projectId ?? '', { signal }),
    enabled: enabled && isValidId,
    retry: false,
  });

  const openRef = React.useRef(open);
  React.useEffect(() => {
    openRef.current = open;
  });

  React.useEffect(() => {
    if (projectId === null) return;
    if (isValidId && enabled && !query.data && !query.isError) return;
    if (query.data) openRef.current(query.data);
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete(EDIT_PARAM);
        return next;
      },
      { replace: true },
    );
  }, [projectId, isValidId, query.data, query.isError, enabled, setSearchParams]);
}

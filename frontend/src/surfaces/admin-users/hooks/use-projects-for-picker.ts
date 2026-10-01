/**
 * The Project Access tab's project picker (P10-T03, re-pointed P10-F02).
 * Was `GET /projects` (Project Registration's `fetchProjects`), which is
 * gated by `project_registration` READ — a permission Engineer/Executive
 * Viewer/Auditor manager-delegates all lack, making the picker unusable for
 * exactly the callers ADR 0012's delegation model exists for. `GET
 * /users/me/manageable-projects` has no surface gate and returns precisely
 * the set of projects the CALLER could grant/revoke on (their own
 * `effective_project_access == "admin"`), which is the picker's actual
 * requirement — not "can read Registration".
 */

import { useQuery } from '@tanstack/react-query';

import { queryKeys } from '@/lib/query-keys';

import { fetchManageableProjects } from '../api/project-access-api';
import { retryUnlessAuth } from '../api/users-api';

export function useProjectsForPicker() {
  return useQuery({
    queryKey: queryKeys.projectsForPicker(),
    queryFn: ({ signal }) => fetchManageableProjects({ signal }),
    retry: retryUnlessAuth,
    staleTime: 60_000,
  });
}

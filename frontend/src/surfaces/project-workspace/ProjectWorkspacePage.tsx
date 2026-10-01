import * as React from 'react';
import { useParams } from 'react-router-dom';

import { SectionBoundary } from '@/components/shared/section-boundary';
import { ReadOnlyNotice } from '@/components/session/write-gate';
import { ApiError } from '@/lib/api/client';
import { usePermission, useSessionStore } from '@/stores/session';

import type { StagePatchRequest } from './api/types';
import { AccessNotice } from './components/access-notice';
import { ActivityPanel } from './components/activity-panel';
import { AskAgentPanel } from './components/ask-agent-panel';
import { DetailsPanel } from './components/details-panel';
import { FilesPanel } from './components/files-panel';
import { ProgressPanel } from './components/progress-panel';
import { WorkspaceHeader } from './components/workspace-header';
import { useRecalcFlow } from './hooks/use-recalc-flow';
import { useStagePatch, useWorkspace } from './hooks/use-workspace';

/**
 * Project Workspace (Surface #7; P9 contract §7; docs/PROJECT_AND_STACK.md §2).
 * Sticky header, then two columns: Details + Progress on the left, Files +
 * Activity & Comments on the right.
 *
 * Gating (ADR 0010): every write control needs `project_workspace.write`
 * (Engineer and Executive Viewer are read-only). Details edits also need
 * `project_registration.write` and score edits `matrix.write`, because they go
 * through those surfaces' endpoints and the server checks those permissions.
 * The server enforces all of it; the UI only avoids offering what will 403.
 */
export default function ProjectWorkspacePage(): React.JSX.Element {
  const { projectId = '' } = useParams();
  const workspace = useWorkspace(projectId);
  const stagePatch = useStagePatch(projectId);
  const recalc = useRecalcFlow(projectId);
  const me = useSessionStore((s) => s.me);

  const ws = usePermission('project_workspace');
  const reg = usePermission('project_registration');
  const matrix = usePermission('matrix');
  const canWrite = ws.write;
  const canModerate = me?.roles.some((r) => r === 'Admin' || r === 'Super Admin') ?? false;

  React.useEffect(() => {
    document.title = workspace.data ? `${workspace.data.project.name} — RPD` : 'Project Workspace — RPD';
  }, [workspace.data]);

  const err = workspace.error;
  const denied =
    err instanceof ApiError
      ? err.isForbidden
        ? 'forbidden'
        : err.isUnauthorized
          ? 'unauthorized'
          : err.status === 404
            ? 'not_found'
            : null
      : null;
  if (denied) return <AccessNotice kind={denied} />;

  const saveStage = (stepId: string, body: StagePatchRequest) => stagePatch.mutateAsync({ stepId, body });

  return (
    <SectionBoundary query={workspace} title="Project Workspace" errorDescription="This project's workspace could not be loaded.">
      {(data) => (
        <div data-testid="project-workspace">
          <WorkspaceHeader data={data} canRecalculate={canWrite} recalc={recalc} />
          <ReadOnlyNotice surface="project_workspace" what="Editing details, progress, files and comments" className="mb-stack" />
          {/* Full-width and first, above the two-column body: this is the one
              panel every project workspace shares regardless of role or write
              access, so it gets top billing rather than sitting at the bottom
              of a scroll column (ask-agent-panel.tsx's own bold styling). */}
          <div className="mb-gutter">
            <AskAgentPanel projectId={data.project.id} />
          </div>
          <div className="grid gap-gutter xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <div className="flex min-w-0 flex-col gap-gutter">
              <DetailsPanel
                data={data}
                canEditDetails={canWrite && reg.write}
                canEditScores={canWrite && matrix.write}
                financialsVisible={reg.read}
              />
              <ProgressPanel data={data} canWrite={canWrite} onSaveStage={saveStage} recalc={recalc} />
            </div>
            <div className="flex min-w-0 flex-col gap-gutter">
              <FilesPanel projectId={data.project.id} files={data.files} canWrite={canWrite} />
              <ActivityPanel
                projectId={data.project.id}
                initial={data.activity}
                canWrite={canWrite}
                currentUserId={me?.user_id ?? null}
                canModerate={canModerate}
              />
            </div>
          </div>
        </div>
      )}
    </SectionBoundary>
  );
}

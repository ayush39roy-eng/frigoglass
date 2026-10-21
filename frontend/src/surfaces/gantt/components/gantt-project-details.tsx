import * as React from 'react';
import { Link } from 'react-router-dom';
import { ArrowUpRight, Snowflake } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { PriorityMoveControl } from '@/components/shared/priority-move/priority-move-control';
import { TrackingStatusChip } from '@/components/shared/tracking-status-chip';
import { VipBadge } from '@/components/shared/vip-badge';

import type { GanttProjectRow } from '../api/types';
import { projectStatusLabels } from '../lib/gantt-status-labels';
import { ProjectRowBadges } from './gantt-badges';
import { ProjectMetaLine, RowWeeks } from './gantt-row-meta';

/**
 * P19-R02 (QA-P19-2): on the narrow (phone) layout the Gantt keeps one slim
 * name column, and everything the wide layout shows beside the name — row
 * meta, served weeks, VIP, tracking status, the status chips, the priority
 * move, the Workspace link and Freeze — lives here, one tap away. Every value
 * is the same served field the wide row renders; nothing is derived.
 */
export function GanttProjectDetailsDialog({
  project,
  open,
  onOpenChange,
  canWrite,
  onFreezeClick,
}: {
  project: GanttProjectRow | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canWrite: boolean;
  onFreezeClick: (project: GanttProjectRow) => void;
}): React.JSX.Element {
  const statuses = project ? projectStatusLabels(project) : [];
  return (
    <Dialog open={open && project !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[calc(100vw-2rem)] sm:max-w-md" data-testid="gantt-project-details">
        {project ? (
          <>
            <DialogHeader>
              <DialogTitle className="pr-6">{project.project_name}</DialogTitle>
              <DialogDescription>Project details and status on the timeline.</DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <ProjectMetaLine project={project} />
              <span className="flex flex-wrap items-center gap-1 text-2xs text-text-muted">
                <RowWeeks project={project} />
                {project.is_vip ? <VipBadge className="px-1 py-px" /> : null}
                <TrackingStatusChip status={project.tracking_status} className="px-1 py-px" />
              </span>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-2xs font-bold uppercase tracking-wider text-text-subtle">Status</span>
                {statuses.length > 0 ? (
                  <ProjectRowBadges project={project} />
                ) : (
                  <span className="text-2xs text-text-muted">No flags</span>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-2xs font-bold uppercase tracking-wider text-text-subtle">Priority</span>
                <PriorityMoveControl
                  projectId={project.project_id}
                  projectName={project.project_name}
                  priority={project.priority}
                />
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button asChild variant="secondary" size="sm">
                <Link to={`/projects/${project.project_id}`}>
                  <ArrowUpRight className="size-3.5" aria-hidden="true" />
                  Open in Project Workspace
                </Link>
              </Button>
              {canWrite ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => {
                    onOpenChange(false);
                    onFreezeClick(project);
                  }}
                >
                  <Snowflake className="size-3.5" aria-hidden="true" />
                  {project.frozen ? 'Unfreeze project' : 'Freeze project'}
                </Button>
              ) : null}
            </div>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

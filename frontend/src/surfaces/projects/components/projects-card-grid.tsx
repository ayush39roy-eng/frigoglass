import * as React from 'react';
import { Link } from 'react-router-dom';
import { Bot, Building2, FolderKanban } from 'lucide-react';

import { BoltCard } from '@/components/ui/bolt-card';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog';
import { CategoryTag } from '@/components/ui/category-tag';
import { PriorityBandPill } from '@/components/shared/priority-band-pill';
import { ProjectStatusBadge } from '@/components/shared/project-status-badge';
import { TrackingStatusChip } from '@/components/shared/tracking-status-chip';
import { VipToggle } from '@/components/shared/vip-toggle';
import { AskAgentPanel } from '@/surfaces/project-workspace/components/ask-agent-panel';

import type { ProjectFilterRow } from '@/surfaces/dashboard/api/types';
import { useHubCountry } from '@/surfaces/dashboard/lib/hub-geo';

import { isVipProject } from '../lib/vip-order';

/**
 * The Projects page Cards view (ADR 0040). Same card as the Dashboard
 * register's `ProjectCardGrid` (same served row, same "Ask the agent"
 * entry point), plus the VIP pin star before the project name. Its own copy
 * because the pin is a Projects / Matrix control only (ADR 0040 §5) and the
 * Dashboard card stays information-only. Rows arrive already ordered
 * (VIP first) and filtered by the page.
 */
export function ProjectsCardGrid({
  rows,
  canPinVip,
}: {
  rows: ProjectFilterRow[];
  canPinVip: boolean;
}): React.JSX.Element {
  return (
    <div className="grid gap-gutter sm:grid-cols-2 xl:grid-cols-3" data-testid="projects-card-grid">
      {rows.map((row) => (
        <ProjectCard key={row.project_id} row={row} canPinVip={canPinVip} />
      ))}
    </div>
  );
}

function ProjectCard({ row, canPinVip }: { row: ProjectFilterRow; canPinVip: boolean }): React.JSX.Element {
  // Region from the served `GET /hubs` `lab_region` (OEM hubs = Greece / Europe).
  const country = useHubCountry();
  return (
    <BoltCard className="flex h-full flex-col gap-s3 p-card" data-testid="project-card" data-project-id={row.project_id}>
      <div className="flex items-center justify-between gap-s2">
        <ProjectStatusBadge status={row.status} />
        {row.category ? <CategoryTag category={row.category} /> : null}
      </div>

      <div className="min-w-0 space-y-s1">
        <h3 className="flex min-w-0 items-center gap-1 text-body font-semibold leading-snug text-text">
          <VipToggle
            projectId={row.project_id}
            projectName={row.project_name}
            isVip={isVipProject(row)}
            canPin={canPinVip}
            className="-ml-1"
          />
          <Link
            to={`/projects/${row.project_id}`}
            className="truncate rounded-sm underline-offset-2 hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            title={`${row.project_name} — open in Project Workspace`}
          >
            {row.project_name}
          </Link>
        </h3>
        <p className="flex items-center gap-1 truncate text-2xs text-text-muted">
          <Building2 className="size-3 shrink-0" aria-hidden="true" />
          {row.hub}
          {country[row.hub] ? ` — ${country[row.hub]}` : ''}
        </p>
        {/* P12 (ADR 0021): the served tracking status. */}
        <TrackingStatusChip status={row.tracking_status} />
      </div>

      <div className="mt-auto flex items-center justify-between gap-s2 border-t border-dash-hairline pt-s3">
        {row.priority ? (
          <PriorityBandPill priority={row.priority} />
        ) : (
          <span className="text-2xs text-text-subtle">Unscored</span>
        )}
        <CardAskAgentDialog projectId={row.project_id} projectName={row.project_name} />
      </div>
    </BoltCard>
  );
}

function CardAskAgentDialog({ projectId, projectName }: { projectId: string; projectName: string }): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button type="button" size="sm" variant="soft" className="font-semibold">
          <Bot aria-hidden="true" />
          Ask the agent
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderKanban className="size-4 text-text-muted" aria-hidden="true" />
            {projectName}
          </DialogTitle>
        </DialogHeader>
        {/* Mounted only while open, so closing drops any in-progress question. */}
        {open ? <AskAgentPanel projectId={projectId} /> : null}
      </DialogContent>
    </Dialog>
  );
}

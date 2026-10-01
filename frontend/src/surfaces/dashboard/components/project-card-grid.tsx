import * as React from 'react';
import { Link } from 'react-router-dom';
import { Bot, Building2, FolderKanban } from 'lucide-react';

import { BoltCard } from '@/components/ui/bolt-card';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { CategoryTag } from '@/components/ui/category-tag';
import { PriorityBandPill } from '@/components/shared/priority-band-pill';
import { ProjectStatusBadge } from '@/components/shared/project-status-badge';
import { AskAgentPanel } from '@/surfaces/project-workspace/components/ask-agent-panel';

import type { ProjectFilterRow } from '../api/types';
import { HUB_COUNTRY } from '../lib/hub-geo';

/**
 * The "all projects, as feature cards" view the project owner asked for
 * alongside the existing virtualized table (`<ProjectBreakdown>`'s own Table
 * tab) — same filtered row set (`GET /dashboard/projects`), same data, a
 * different shape for scanning the portfolio instead of comparing columns.
 *
 * Every card carries its own "Ask the agent" entry point, independent of the
 * one on the Project Workspace page (ADR 0014): the dialog here calls the
 * SAME `<AskAgentPanel>`, just scoped to this card's project id, so a
 * question can be asked without leaving the grid.
 */
export function ProjectCardGrid({ rows }: { rows: ProjectFilterRow[] }): React.JSX.Element {
  return (
    <div className="grid gap-gutter sm:grid-cols-2 xl:grid-cols-3">
      {rows.map((row) => (
        <ProjectFeatureCard key={row.project_id} row={row} />
      ))}
    </div>
  );
}

function ProjectFeatureCard({ row }: { row: ProjectFilterRow }): React.JSX.Element {
  return (
    <BoltCard className="flex h-full flex-col gap-s3 p-card">
      <div className="flex items-center justify-between gap-s2">
        <ProjectStatusBadge status={row.status} />
        {row.category ? <CategoryTag category={row.category} /> : null}
      </div>

      <div className="min-w-0 space-y-s1">
        <h3 className="truncate text-body font-semibold leading-snug text-text">
          <Link
            to={`/projects/${row.project_id}`}
            className="rounded-sm underline-offset-2 hover:text-primary hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            title={`${row.project_name} — open in Project Workspace`}
          >
            {row.project_name}
          </Link>
        </h3>
        <p className="flex items-center gap-1 truncate text-2xs text-text-muted">
          <Building2 className="size-3 shrink-0" aria-hidden="true" />
          {row.hub}
          {HUB_COUNTRY[row.hub] ? ` — ${HUB_COUNTRY[row.hub]}` : ''}
        </p>
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

function CardAskAgentDialog({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName: string;
}): React.JSX.Element {
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
        {/* Mounted only while the dialog is open, so closing it drops any
            in-progress question/answer rather than caching it across cards. */}
        {open ? <AskAgentPanel projectId={projectId} /> : null}
      </DialogContent>
    </Dialog>
  );
}

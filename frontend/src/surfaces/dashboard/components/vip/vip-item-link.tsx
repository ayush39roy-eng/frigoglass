import * as React from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, EyeOff } from 'lucide-react';

import { HealthChip, ProjectedFinishChip } from '@/components/shared/project-outcome-chips';
import { PriorityBandPill } from '@/components/shared/priority-band-pill';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import type { VipItem } from '@/lib/api/vip';
import { cn } from '@/lib/utils';

import { workspaceHref } from './vip-meta';

const LINK_CLASS =
  'rounded-sm text-left underline decoration-border-strong underline-offset-2 hover:decoration-current focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/**
 * An item's title, acting on its linked projects (ADR 0027 §6):
 *   one project → a link to its Workspace;
 *   several     → a small picker (name, hub, priority, finish, health);
 *   none        → plain text, not clickable.
 * Every project fact is served from the active run (I9).
 */
export function VipItemLink({ item, className }: { item: VipItem; className?: string }): React.JSX.Element {
  const projects = item.projects;
  if (projects.length === 1) {
    const only = projects[0]!;
    return (
      <Link to={workspaceHref(only.id)} className={cn(LINK_CLASS, className)} data-testid="vip-item-link" title={`Open ${only.name}`}>
        {item.title}
      </Link>
    );
  }
  if (projects.length > 1) {
    return (
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(LINK_CLASS, 'inline-flex items-baseline gap-1', className)}
            aria-label={`${item.title}: choose one of ${String(projects.length)} projects`}
            data-testid="vip-item-picker-trigger"
          >
            {item.title}
            <ChevronDown className="size-3 shrink-0 self-center" aria-hidden="true" />
          </button>
        </PopoverTrigger>
        <PopoverContent align="start" className="w-[min(28rem,calc(100vw-2rem))] p-2" aria-label={`Open a project: ${item.title}`}
          data-testid="vip-item-picker"
        >
          <p className="px-1 pb-1 text-2xs font-bold uppercase tracking-wider text-text-subtle">Open a project</p>
          <ul className="flex max-h-72 flex-col gap-1 overflow-y-auto" aria-label={`Projects for ${item.title}`}>
            {projects.map((p) => (
              <li key={p.id}>
                <Link
                  to={workspaceHref(p.id)}
                  className="flex flex-col gap-1 rounded-md px-2 py-1.5 hover:bg-surface-raised focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  data-testid="vip-picker-project"
                >
                  <span className="text-xs font-semibold text-text">{p.name}</span>
                  <span className="flex flex-wrap items-center gap-1.5 text-2xs text-text-muted">
                    <span>{p.hub}</span>
                    {p.priority ? <PriorityBandPill priority={p.priority} /> : null}
                    <ProjectedFinishChip projectedEndWeek={p.projected_end_week} withinYear={p.within_year} />
                    <HealthChip health={p.health} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
          {item.hidden_project_count > 0 ? <HiddenProjects count={item.hidden_project_count} /> : null}
        </PopoverContent>
      </Popover>
    );
  }
  return <span className={className}>{item.title}</span>;
}

export function HiddenProjects({ count }: { count: number }): React.JSX.Element {
  return (
    <p className="flex items-center gap-1 px-1 pt-1 text-2xs text-text-muted">
      <EyeOff className="size-3 shrink-0" aria-hidden="true" />
      {`+${String(count)} linked in hubs outside your scope`}
    </p>
  );
}

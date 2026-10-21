import * as React from 'react';
import { UserRound } from 'lucide-react';

import { NoLeaderLabel } from '@/components/shared/no-leader-label';
import { PROJECT_TYPE_LABELS } from '@/types/enums';

import type { GanttProjectRow } from '../api/types';

/**
 * P13-T13 row meta: leader · external code · type · hub. The leader name is
 * served by the API (ADR 0028); a leader id with no name reads "Name unavailable";
 * a null leader reads "No leader" (P24-T02).
 */
export function ProjectMetaLine({ project }: { project: GanttProjectRow }): React.JSX.Element {
  return (
    <span className="flex min-w-0 items-center gap-1 text-2xs text-text-muted" data-testid="gantt-row-meta">
      <UserRound className="size-3 shrink-0 text-text-subtle" aria-hidden="true" />
      {project.leader_name ? (
        <span className="max-w-24 truncate font-medium text-primary" title={`Leader: ${project.leader_name}`}>
          {project.leader_name}
        </span>
      ) : project.leader_engineer_id ? (
        <span className="shrink-0 italic text-text-subtle" title="Leader name unavailable">
          Name unavailable
        </span>
      ) : (
        // P24-T02: "No leader"; plus the Left Out hint from the served `left_out`.
        <NoLeaderLabel leftOut={project.left_out} inline className="shrink" />
      )}
      {project.external_code ? (
        <>
          <span aria-hidden="true">·</span>
          <span className="tnum truncate" title={`Project code ${project.external_code}`}>
            {project.external_code}
          </span>
        </>
      ) : null}
      {project.type ? (
        <>
          <span aria-hidden="true">·</span>
          <abbr className="shrink-0 no-underline" title={PROJECT_TYPE_LABELS[project.type]}>
            {project.type}
          </abbr>
        </>
      ) : null}
      <span aria-hidden="true">·</span>
      <span className="truncate">{project.hub}</span>
    </span>
  );
}

/** P13-T13: the served "Total 17W · 5 DW / 0 LW" — verbatim, never summed here.
 *  The server sends nulls when the project has no step in the active run. */
export function RowWeeks({ project }: { project: GanttProjectRow }): React.JSX.Element {
  const { total_weeks: total, design_weeks: design, lab_weeks: lab } = project;
  if (total === null) {
    return (
      <span className="shrink-0 text-text-subtle" data-testid="gantt-row-weeks">
        Not in the active run
      </span>
    );
  }
  const d = design === null ? '–' : String(design);
  const l = lab === null ? '–' : String(lab);
  return (
    <span
      className="tnum shrink-0"
      data-testid="gantt-row-weeks"
      title={`Total ${String(total)} weeks: ${d} design weeks, ${l} lab weeks (served)`}
    >
      Total {total}W · {d} DW / {l} LW
    </span>
  );
}

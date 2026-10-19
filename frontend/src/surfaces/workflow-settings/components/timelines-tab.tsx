import * as React from 'react';

import { SectionBoundary } from '@/components/shared/section-boundary';
import { Label } from '@/components/ui/label';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { WORKFLOW_IDS, type WorkflowId } from '@/types/enums';

import { useBEquivalent, useCategoryTimelines } from '../hooks/use-workflow-settings';
import { BEquivalentPanel } from './b-equivalent-panel';
import { CategoryTimelineList } from './category-timeline';

/**
 * "Timeline previews" tab (P13-T16): per-category mini-Gantts and the
 * B-equivalent panel for one workflow at a time, both served
 * (API_CONTRACT_P13 §5). Read-only; any role that can read Workflow Settings
 * sees it. Saved lead-time / step changes refetch both (see `afterSave`).
 */
export function TimelinesTab(): React.JSX.Element {
  const [workflow, setWorkflow] = React.useState<WorkflowId>('PDD');
  const timelines = useCategoryTimelines(workflow);
  const bEquivalent = useBEquivalent(workflow);
  const toggleId = React.useId();

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-s3">
        <Label htmlFor={toggleId} className="text-2xs text-text-muted">
          Workflow
        </Label>
        <ToggleGroup
          id={toggleId}
          type="single"
          size="sm"
          value={workflow}
          aria-label="Workflow"
          onValueChange={(next) => {
            if ((WORKFLOW_IDS as readonly string[]).includes(next)) setWorkflow(next as WorkflowId);
          }}
        >
          <ToggleGroupItem value="PDD">Standard PDD</ToggleGroupItem>
          <ToggleGroupItem value="OEM">OEM</ToggleGroupItem>
        </ToggleGroup>
        <p className="text-2xs text-text-subtle">
          Earliest start of every step over the precedence graph, from the lead-time table only: per-project
          duration overrides and capacity are not applied. Week 0 is the project start.
        </p>
      </div>
      <div className="grid items-start gap-4 2xl:grid-cols-[minmax(0,1fr)_28rem]">
        <section aria-labelledby={`${toggleId}-timelines`} className="min-w-0 space-y-s3">
          <h2 id={`${toggleId}-timelines`} className="text-2xs font-bold uppercase tracking-wider text-text-subtle">
            Per-category timelines
          </h2>
          <SectionBoundary
            query={timelines}
            title="Per-category timelines"
            errorDescription="The category timelines could not be loaded."
          >
            {(data) => <CategoryTimelineList timelines={data} />}
          </SectionBoundary>
        </section>
        <div className="min-w-0">
          <SectionBoundary
            query={bEquivalent}
            title="B-equivalent workload"
            errorDescription="The B-equivalent workload could not be loaded."
          >
            {(rows) => <BEquivalentPanel workflow={workflow} rows={rows} />}
          </SectionBoundary>
        </div>
      </div>
    </div>
  );
}
